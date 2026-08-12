#!/usr/bin/env node
/**
 * boss-mcp：把 boss-cli 的业务能力（`src/toolset` 的 `impl*`）以 MCP Server（stdio 传输）暴露出去。
 *
 * 设计约束（与 `src/cli` 的差异）：
 * - 与 `src/cli/` 平行的第二个入口，`toolset/` `browser/` `common/` `ocr/` 零改动。
 * - MCP Server 是**长驻进程**：CDP 会话在多次 tool 调用之间保持复用，只在进程退出时 detach。
 * - 同一只 Chrome 不能并发操作：所有 tool 调用在进程内**串行排队**执行。
 * - stdio 传输下 stdout 只能承载 JSON-RPC，任何日志必须走 stderr。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { APP_HOME } from '../config.js';
import { detachBrowserSession } from '../browser/index.js';
import { getPackageMeta } from '../cli/version.js';
import { runToolCall, textResult, type ToolContext } from './dispatch.js';
import { formatEnvLoadReport, loadMcpEnv } from './env.js';
import { assertResumeOcrReady } from './preflight.js';
import {
  enhanceToolErrorMessage,
  formatInstanceConflictWarning,
  registerInstance,
  unregisterInstance,
} from './session_guard.js';
import {
  implBossSearch,
  implBossSearchSet,
  implChatAction,
  implListCandidates,
  implListPositions,
  implListPositionsWithOptions,
  implListUnreadCandidates,
  implLogin,
  implNormalSearch,
  implOpenChat,
  implOpenChatByIndex,
  implPreview,
  implRecommend,
  implRecommendGreet,
  implSendMessage,
  type ChatPageAction,
} from '../toolset/index.js';
import {
  findCandidate,
  listAllPools,
  poolAdd,
  poolClear,
  poolExportMarkdown,
  poolMark,
  poolRemove,
  poolPath,
  renderCandidateDetail,
  renderPool,
  requirePool,
  savePool,
} from './pool.js';
import { GREET_BATCH_HARD_LIMIT, greetAll } from './pool_greet.js';
import { RESUME_BATCH_HARD_LIMIT, batchResume } from './pool_resume.js';

// ── stdout 保护 ────────────────────────────────────────────────
// stdio 传输把 stdout 独占给 JSON-RPC；任何一次 console.log 都会破坏协议帧。
// 共享业务层目前只用 console.error，这里再加一道兜底：把 log/info/warn 全部改写到 stderr。
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

// ── 环境变量 ──────────────────────────────────────────────────
// MCP 下 CWD 由客户端决定，不能只依赖 CWD 的 .env。见 src/mcp/env.ts 的说明。
// 加载报告在 server 启动日志里输出（stderr），便于排查“配了却不生效”。
const envReport = loadMcpEnv(APP_HOME);

function envTruthy(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

/**
 * 进程启动时的无头偏好。`implLogin` 会把 `BOSS_BROWSER_HEADLESS` 强制改成 `false`
 * （登录必须可见），长驻进程里必须在每次调用前按原始偏好复位，否则登录一次就永久变成有头。
 */
const HEADLESS_PREFERENCE = envTruthy('BOSS_BROWSER_HEADLESS');

function configureHeadlessForTool(toolName: string): void {
  if (toolName === 'boss_login') {
    process.env.BOSS_BROWSER_HEADLESS = 'false';
    return;
  }
  process.env.BOSS_BROWSER_HEADLESS = HEADLESS_PREFERENCE ? 'true' : 'false';
}

/**
 * 单次工具调用的看门狗上限。超过它就放弃等待、重置浏览器会话并放行队列，
 * 否则一次挂死的页面等待会让整个长驻 server 永久卡住。可用 `BOSS_MCP_TOOL_TIMEOUT_MS` 覆盖，
 * 设为 0 表示关闭看门狗（不推荐）。
 */
const TOOL_TIMEOUT_MS = (() => {
  const raw = process.env.BOSS_MCP_TOOL_TIMEOUT_MS?.trim();
  if (!raw) return 240_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 240_000;
  return n;
})();

/** 心跳间隔：客户端普遍有 60s 请求超时，这里远小于它，且 SDK 侧收到 progress 可重置计时 */
const HEARTBEAT_INTERVAL_MS = (() => {
  const raw = process.env.BOSS_MCP_HEARTBEAT_MS?.trim();
  if (!raw) return 10_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1_000) return 10_000;
  return n;
})();

// ── 串行队列 ──────────────────────────────────────────────────
// 同一只浏览器并发操作会互相抢页面焦点；且 `withBossSessionLock` 是**跨进程文件锁**，
// 同进程内并发调用会互相等锁并在 30s 后报 "session is busy"。所以这里必须先排队。
let tail: Promise<unknown> = Promise.resolve();
let queueDepth = 0;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  queueDepth++;
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  const dec = () => {
    queueDepth--;
  };
  run.then(dec, dec);
  return run;
}

// ── 参数解析：MCP 客户端（LLM）常把数字/布尔写成字符串，这里做宽松归一 ──
function argsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') {
    return undefined;
  }
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const v = optString(args, key);
  if (v === undefined) {
    throw new Error(`❌ ${tool} 缺少必填参数 ${key}（非空字符串）`);
  }
  return v;
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
  }
  return undefined;
}

function requireIndex(args: Record<string, unknown>, key: string, tool: string): number {
  const raw = args[key];
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`❌ ${tool} 参数 ${key} 必须是从 1 开始的整数，当前值: ${String(raw)}`);
  }
  return n;
}

/** 正整数（用于 id / limit）；非法返回 undefined */
function optPositiveInt(args: Record<string, unknown>, key: string): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function requirePositiveInt(args: Record<string, unknown>, key: string, tool: string): number {
  const n = optPositiveInt(args, key);
  if (n === undefined) {
    throw new Error(`❌ ${tool} 参数 ${key} 必须是正整数，当前值: ${String(args[key])}`);
  }
  return n;
}

/** id 列表；容忍 [1,2] / ["1","2"] / "1,2" 三种写法 */
function requireIdList(args: Record<string, unknown>, key: string, tool: string): number[] {
  const raw = args[key];
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/);
  const ids: number[] = [];
  for (const item of items) {
    if (item === '' || item === null || item === undefined) continue;
    const n = typeof item === 'number' ? item : Number(String(item).trim());
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`❌ ${tool} 参数 ${key} 含非法 id: ${String(item)}（必须是正整数）`);
    }
    ids.push(n);
  }
  if (ids.length === 0) {
    throw new Error(`❌ ${tool} 缺少有效的 ${key}（正整数数组）`);
  }
  return Array.from(new Set(ids));
}

/** pool_add 的 candidates：[{name, matchReason?}]，也容忍纯字符串数组 */
function requireCandidateList(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): Array<{ name: string; matchReason?: string }> {
  const raw = args[key];
  if (!Array.isArray(raw)) {
    throw new Error(`❌ ${tool} 参数 ${key} 必须是数组：[{ name, matchReason? }]`);
  }
  const out: Array<{ name: string; matchReason?: string }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) out.push({ name });
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (!name) continue;
      const reason = typeof obj.matchReason === 'string' ? obj.matchReason.trim() : '';
      out.push({ name, matchReason: reason || undefined });
    }
  }
  if (out.length === 0) {
    throw new Error(`❌ ${tool} 的 ${key} 里没有有效候选人（每项至少要有非空 name）`);
  }
  return out;
}

/** 允许传数组，也允许传用换行 / 分号分隔的单个字符串（与 CLI 的 --core/--bonus 语义一致） */
function optStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  const items = Array.isArray(v) ? v : String(v).split(/\r?\n|[;；]/);
  const cleaned = items
    .map((x) => (typeof x === 'string' ? x : String(x)))
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  // 显式传了空数组 / 空串表示「清空该分组」，需要保留空数组而不是 undefined
  return cleaned;
}

/** 对外暴露给客户端的规范取值（与 CLI `boss action <操作>` 一致） */
const CHAT_ACTION_CHOICES = [
  'resume',
  'not-fit',
  'remark',
  'agree-resume',
  'request-attachment-resume',
  'history',
  'wechat',
] as const;

/** 规范值 + 兼容别名 → 业务层枚举 */
const CHAT_ACTION_ALIASES: Record<string, ChatPageAction> = {
  resume: 'resume',
  'not-fit': 'not-fit',
  remark: 'remark',
  'agree-resume': 'agree-resume',
  'request-attachment-resume': 'request-attachment-resume',
  'ask-attachment-resume': 'request-attachment-resume',
  'ask-resume': 'request-attachment-resume',
  history: 'history',
  'chat-history': 'history',
  wechat: 'exchange-wechat',
  'exchange-wechat': 'exchange-wechat',
};

// ── Tool 定义：schema 与实现放在一处，避免两边漂移 ──
type ToolSpec = Tool & {
  /** ctx 提供取消信号与进度回调；只有长任务（如 pool_greet_all）需要用到 */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'boss_login',
    description:
      '打开 Boss 直聘登录页（有界面窗口）。本工具不等待、不轮询、不校验登录结果，会立即返回：' +
      '请把控制权交还给用户，由用户在浏览器里完成扫码/验证，再调用其它工具。',
    annotations: { title: '打开登录页', readOnlyHint: false, openWorldHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => implLogin(),
  },
  {
    name: 'boss_list_candidates',
    description:
      '读取「沟通」页的聊天列表候选人（已建立联系的会话）。unread=true 时只返回未读（角标 > 0）的会话。' +
      '返回结果带 1-based 序号，可配合 boss_open_chat_by_index 使用。',
    annotations: { title: '读取聊天列表', readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        unread: { type: 'boolean', description: '仅返回未读会话，默认 false' },
      },
      additionalProperties: false,
    },
    run: async (args) =>
      optBool(args, 'unread') ? implListUnreadCandidates() : implListCandidates(),
  },
  {
    name: 'boss_open_chat',
    description:
      '按姓名打开候选人会话（仅适用于聊天列表里已存在的会话）。默认包含匹配，strict=true 为精确匹配。',
    annotations: { title: '按姓名打开会话', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '候选人姓名' },
        strict: { type: 'boolean', description: '精确匹配姓名，默认 false（包含匹配）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) =>
      implOpenChat(requireString(args, 'name', 'boss_open_chat'), optBool(args, 'strict') === true),
  },
  {
    name: 'boss_open_chat_by_index',
    description:
      '按 boss_list_candidates 输出的 1-based 序号打开会话。unread=true 表示序号对应 unread 列表；' +
      '同时传 name 时会校验该序号的候选人姓名（strict=true 为精确校验）。',
    annotations: { title: '按序号打开会话', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 1, description: '列表序号，从 1 开始' },
        unread: { type: 'boolean', description: '序号取自未读列表，默认 false' },
        name: { type: 'string', description: '可选：用于校验该序号候选人姓名' },
        strict: { type: 'boolean', description: '姓名校验使用精确匹配，默认 false' },
      },
      required: ['index'],
      additionalProperties: false,
    },
    run: async (args) =>
      implOpenChatByIndex({
        index: requireIndex(args, 'index', 'boss_open_chat_by_index'),
        unreadOnly: optBool(args, 'unread'),
        expectedName: optString(args, 'name'),
        exact: optBool(args, 'strict'),
      }),
  },
  {
    name: 'boss_send_message',
    description:
      '向**当前已打开**的会话发送文本消息（等价于在输入框输入后回车）。调用前请先用 boss_open_chat / boss_open_chat_by_index 打开目标会话。' +
      'requestResume=true 时发送后会自动执行一次「求简历」。',
    annotations: { title: '发送消息', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的消息文本' },
        requestResume: { type: 'boolean', description: '发送后自动「求简历」，默认 false' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async (args) =>
      implSendMessage({
        text: requireString(args, 'text', 'boss_send_message'),
        requestResume: optBool(args, 'requestResume'),
      }),
  },
  {
    name: 'boss_chat_action',
    description:
      '对**当前已打开**的候选人会话执行一个操作，仅返回该操作的执行结果。' +
      `可选 action：${CHAT_ACTION_CHOICES.join(' | ')}。` +
      'resume=查看在线简历；not-fit=标记不合适；remark=写备注（必须同时传 remark）；' +
      'agree-resume=同意对方发来的简历请求；request-attachment-resume=工具栏「求简历」（需双方各至少发过一条消息）；' +
      'history=读取聊天记录；wechat=交换微信。',
    annotations: { title: '会话操作', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...CHAT_ACTION_CHOICES], description: '要执行的操作' },
        remark: { type: 'string', description: 'action=remark 时必填：备注内容' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: async (args) => {
      const raw = requireString(args, 'action', 'boss_chat_action').toLowerCase();
      const action = CHAT_ACTION_ALIASES[raw];
      if (!action) {
        throw new Error(
          `❌ boss_chat_action 不支持的 action: ${raw}。可选: ${CHAT_ACTION_CHOICES.join(' | ')}`,
        );
      }
      const remark = optString(args, 'remark') ?? '';
      if (action === 'remark' && !remark) {
        throw new Error('❌ action=remark 时必须提供 remark（备注内容）。');
      }
      if (action === 'resume') {
        // 这条路径会打开在线简历并做 OCR，缺密钥时先扣配额再报错，必须提前拦
        assertResumeOcrReady('boss_chat_action(action=resume)');
      }
      return implChatAction({ action, remark });
    },
  },
  {
    name: 'boss_recommend',
    description:
      '进入「推荐」页并读取推荐牛人列表。传 jobKeyword 时会先在岗位下拉里模糊匹配并切换岗位。' +
      '只读列表，不消耗任何平台配额。',
    annotations: { title: '推荐列表', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobKeyword: { type: 'string', description: '可选：岗位关键字，先切换岗位再读列表' },
      },
      additionalProperties: false,
    },
    run: async (args) => implRecommend(optString(args, 'jobKeyword')),
  },
  {
    name: 'boss_search',
    description: '进入「搜索」页读取 Boss 常规搜索结果；传 keyword 时会填入搜索框并回车搜索。',
    annotations: { title: '常规搜索', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：搜索关键词' },
      },
      additionalProperties: false,
    },
    run: async (args) => implNormalSearch(optString(args, 'keyword')),
  },
  {
    name: 'boss_deep_search',
    description:
      '进入「深度搜索」页并回读当前状态：当前表单条件、剩余匹配次数、「立即匹配」按钮状态。' +
      '本工具**不会**点击匹配，不消耗任何配额。要改条件用 boss_deep_search_set，要真正匹配用 boss_deep_search_match。',
    annotations: { title: '深度搜索（查看状态）', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobKeyword: { type: 'string', description: '可选：岗位关键字，先切换岗位再回读' },
      },
      additionalProperties: false,
    },
    run: async (args) => implBossSearch({ jobKeyword: optString(args, 'jobKeyword'), match: false }),
  },
  {
    name: 'boss_deep_search_set',
    description:
      '只设置「深度搜索」表单（岗位 / 核心要求 / 加分项）并回读当前状态，**不点击「立即匹配」**，不消耗配额。' +
      'core/bonus 传入即按该列表同步对应分组，传空数组表示清空该分组。' +
      '典型用法：LLM 读完 JD 拆出 core/bonus 后调本工具建表单，再由用户确认后调 boss_deep_search_match。',
    annotations: { title: '深度搜索（设置表单）', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobKeyword: { type: 'string', description: '可选：岗位关键字' },
        core: { type: 'array', items: { type: 'string' }, description: '核心要求列表；空数组=清空' },
        bonus: { type: 'array', items: { type: 'string' }, description: '加分项列表；空数组=清空' },
      },
      additionalProperties: false,
    },
    run: async (args) =>
      implBossSearchSet({
        jobKeyword: optString(args, 'jobKeyword'),
        coreRequirements: optStringList(args, 'core'),
        bonusRequirements: optStringList(args, 'bonus'),
      }),
  },
  {
    name: 'boss_deep_search_match',
    description:
      '⚠️【消耗今日深度搜索匹配次数，务必先与用户确认】点击「立即匹配」并返回匹配到的候选人列表（顶部最新 20 条）。' +
      '可同时传 core/bonus 先同步表单再匹配。返回的候选人可由你解析后用 pool_add 存入候选人集合。',
    annotations: {
      title: '深度搜索（执行匹配，消耗配额）',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        jobKeyword: { type: 'string', description: '可选：岗位关键字' },
        core: { type: 'array', items: { type: 'string' }, description: '可选：匹配前同步核心要求' },
        bonus: { type: 'array', items: { type: 'string' }, description: '可选：匹配前同步加分项' },
      },
      additionalProperties: false,
    },
    run: async (args) =>
      implBossSearch({
        jobKeyword: optString(args, 'jobKeyword'),
        coreRequirements: optStringList(args, 'core'),
        bonusRequirements: optStringList(args, 'bonus'),
        match: true,
      }),
  },
  {
    name: 'boss_greet',
    description:
      '⚠️【消耗平台打招呼次数，单次成本高，务必先与用户确认】对**当前列表中**的候选人点击「打招呼」。' +
      '前置条件：当前必须已在「推荐」(/web/chat/recommend) 或「深度搜索」(/web/chat/aiform) 且列表已加载，本工具不会自动跳转。' +
      '可传 job 先在岗位下拉里模糊匹配并切换岗位。',
    annotations: { title: '打招呼（消耗配额）', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '候选人姓名（须存在于当前列表）' },
        job: { type: 'string', description: '可选：岗位关键字，先切换岗位' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) =>
      implRecommendGreet({
        candidateTarget: requireString(args, 'name', 'boss_greet'),
        jobKeyword: optString(args, 'job'),
      }),
  },
  {
    name: 'boss_preview_resume',
    description:
      '⚠️【消耗每日在线简历查看次数，务必按需使用】预览当前列表中某候选人的在线简历。' +
      '前置条件：当前必须已在「推荐」(/web/chat/recommend)、「深度搜索」(/web/chat/aiform) 或「常规搜索」(/web/chat/search) 且列表已加载，本工具不会自动跳转。',
    annotations: { title: '预览在线简历（消耗配额）', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '候选人姓名（须存在于当前列表）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const name = requireString(args, 'name', 'boss_preview_resume');
      assertResumeOcrReady('boss_preview_resume');
      return implPreview({ candidateTarget: name });
    },
  },
  {
    name: 'boss_list_positions',
    description: '读取当前账号的职位列表（含开放 / 待开放 / 已关闭状态）。只读。',
    annotations: { title: '职位列表', readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => implListPositions(),
  },
  {
    name: 'boss_get_jd',
    description: '抓取指定职位的 JD 详情，并缓存到 ~/.boss-cli/jd/ 下的同名 .md 文件。',
    annotations: { title: '抓取职位 JD', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '职位名称（可用 boss_list_positions 先确认）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) =>
      implListPositionsWithOptions({
        detail: true,
        name: requireString(args, 'name', 'boss_get_jd'),
      }),
  },

  // ── 候选人集合（pool_*）：MCP 层的有状态工作台，持久化在 ~/.boss-cli/.cache/pool/ ──
  {
    name: 'pool_add',
    description:
      '把候选人存入指定岗位的候选人集合（按姓名去重，自动分配 1-based id）。不消耗任何配额。' +
      '典型用法：boss_deep_search_match / boss_recommend / boss_search 返回列表后，由你挑出合适的人调本工具入库；' +
      'matchReason 建议写清为什么匹配，方便用户后续审核。core/bonus 可选，用于把这次的筛选条件一起记进集合。',
    annotations: { title: '集合：加入候选人', readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名（通常是岗位名），同名集合会累加' },
        candidates: {
          type: 'array',
          description: '候选人列表',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '候选人姓名（须与 Boss 列表中显示的一致）' },
              matchReason: { type: 'string', description: '匹配理由，便于用户审核' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        core: { type: 'array', items: { type: 'string' }, description: '可选：记录本次核心要求' },
        bonus: { type: 'array', items: { type: 'string' }, description: '可选：记录本次加分项' },
      },
      required: ['job', 'candidates'],
      additionalProperties: false,
    },
    run: async (args) => {
      const job = requireString(args, 'job', 'pool_add');
      const incoming = requireCandidateList(args, 'candidates', 'pool_add');
      const result = await poolAdd(job, incoming, {
        core: optStringList(args, 'core'),
        bonus: optStringList(args, 'bonus'),
      });
      const lines = [
        `已更新集合「${job}」：新增 ${result.added.length} 人，当前共 ${result.pool.candidates.length} 人。`,
      ];
      if (result.added.length > 0) {
        lines.push(`新增：${result.added.join('、')}`);
      }
      if (result.duplicated.length > 0) {
        lines.push(`已存在（跳过）：${result.duplicated.join('、')}`);
      }
      lines.push(`文件：${poolPath(job)}`, '', '用 pool_list 查看完整集合。');
      return lines.join('\n');
    },
  },
  {
    name: 'pool_list',
    description:
      '查看候选人集合。传 job 查看该集合明细（序号、姓名、标记、是否已打招呼、匹配理由）；不传 job 则列出所有集合及人数。只读，不消耗配额。',
    annotations: { title: '集合：查看', readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名；省略则列出全部集合' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const job = optString(args, 'job');
      if (!job) {
        return listAllPools();
      }
      return renderPool(await requirePool(job));
    },
  },
  {
    name: 'pool_get_detail',
    description:
      '查看集合中某个候选人的细节。默认只读已缓存内容，不消耗配额。' +
      '⚠️ 传 preview=true 会调用在线简历预览并**消耗每日简历查看配额**，且要求浏览器当前已在推荐/深搜/常规搜索页且列表已加载；' +
      '抓到的正文会缓存进集合，之后再看同一个人不会再次消耗配额（除非传 refresh=true）。',
    annotations: { title: '集合：候选人细节', readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
        id: { type: 'integer', minimum: 1, description: 'pool_list 里显示的候选人 id' },
        preview: {
          type: 'boolean',
          description: '⚠️ true 时抓取在线简历，消耗每日简历查看配额，默认 false',
        },
        refresh: { type: 'boolean', description: '已有缓存时仍强制重新抓取（同样消耗配额）' },
      },
      required: ['job', 'id'],
      additionalProperties: false,
    },
    run: async (args) => {
      const job = requireString(args, 'job', 'pool_get_detail');
      const id = requirePositiveInt(args, 'id', 'pool_get_detail');
      const pool = await requirePool(job);
      const candidate = findCandidate(pool, id);
      if (!candidate) {
        throw new Error(`❌ 集合「${job}」中未找到 id=${id}。用 pool_list 查看当前序号。`);
      }

      const wantPreview = optBool(args, 'preview') === true;
      const refresh = optBool(args, 'refresh') === true;
      if (!wantPreview) {
        return renderCandidateDetail(pool, candidate);
      }
      if (candidate.detail && !refresh) {
        return [
          '（命中缓存，未消耗简历查看配额；需要重新抓取请传 refresh=true）',
          '',
          renderCandidateDetail(pool, candidate),
        ].join('\n');
      }

      assertResumeOcrReady('pool_get_detail(preview=true)');
      const detail = await implPreview({ candidateTarget: candidate.name });
      candidate.detail = detail;
      candidate.detailAt = new Date().toISOString();
      await savePool(pool);
      return renderCandidateDetail(pool, candidate);
    },
  },
  {
    name: 'pool_remove',
    description: '按 id 从集合中删除候选人（用户审核时剔除不合适的人）。不消耗配额，但删除不可撤销。',
    annotations: { title: '集合：删除候选人', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
        ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          description: '要删除的候选人 id 列表',
        },
      },
      required: ['job', 'ids'],
      additionalProperties: false,
    },
    run: async (args) =>
      poolRemove(
        requireString(args, 'job', 'pool_remove'),
        requireIdList(args, 'ids', 'pool_remove'),
      ),
  },
  {
    name: 'pool_mark',
    description: '给集合中某候选人打标记（如「重点」「待定」「已看简历」）。传空字符串可清除标记。不消耗配额。',
    annotations: { title: '集合：打标记', readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
        id: { type: 'integer', minimum: 1, description: '候选人 id' },
        tag: { type: 'string', description: '标记内容；空字符串表示清除标记' },
      },
      required: ['job', 'id', 'tag'],
      additionalProperties: false,
    },
    run: async (args) => {
      const job = requireString(args, 'job', 'pool_mark');
      const id = requirePositiveInt(args, 'id', 'pool_mark');
      const tag = typeof args.tag === 'string' ? args.tag : '';
      return poolMark(job, id, tag);
    },
  },
  {
    name: 'pool_clear',
    description:
      '清空某个集合里的所有候选人（岗位条件与文件保留）。不可撤销，调用前请与用户确认。不消耗配额。',
    annotations: { title: '集合：清空', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
      },
      required: ['job'],
      additionalProperties: false,
    },
    run: async (args) => poolClear(requireString(args, 'job', 'pool_clear')),
  },
  {
    name: 'pool_greet_all',
    description:
      '⚠️【本工具是唯一会批量消耗打招呼配额的入口】对集合中**未打招呼**的候选人逐个打招呼。' +
      '默认 dryRun=true 只返回将要打招呼的名单而不真发，**必须显式传 dryRun=false 才会执行**。' +
      `limit 限制本次人数（单次硬上限 ${GREET_BATCH_HARD_LIMIT}）。执行时逐个之间有 3-8 秒随机间隔以降低风控风险，` +
      '每成功一个立即落盘，中断后再次调用会自动跳过已打过的人。' +
      '前置条件：浏览器当前须已在「推荐」或「深度搜索」页且候选人列表已加载（本工具不会自动跳转）。' +
      '注意：人数较多时整个调用可能持续数分钟。',
    annotations: {
      title: '集合：批量打招呼（消耗配额）',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
        dryRun: {
          type: 'boolean',
          description: '默认 true（只预演不执行）；必须显式传 false 才真正打招呼',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: GREET_BATCH_HARD_LIMIT,
          description: `本次最多打招呼人数，默认且最大 ${GREET_BATCH_HARD_LIMIT}`,
        },
        jobKeyword: {
          type: 'string',
          description:
            '可选：仅在第一个候选人前切换一次岗位。批量过程中不重复切换（切岗位会重置深搜匹配结果）',
        },
      },
      required: ['job'],
      additionalProperties: false,
    },
    run: async (args, ctx) =>
      greetAll({
        job: requireString(args, 'job', 'pool_greet_all'),
        // 默认预演：只有显式 false 才真发
        dryRun: optBool(args, 'dryRun') !== false,
        limit: optPositiveInt(args, 'limit'),
        jobKeyword: optString(args, 'jobKeyword'),
        signal: ctx.signal,
        onProgress: (done, total, label) => ctx.tick(`已处理 ${done}/${total}：${label}`),
      }),
  },
  {
    name: 'pool_batch_resume',
    description:
      '⚠️【批量消耗每日在线简历查看次数，务必先与用户确认】对集合中**还没有简历**的候选人逐个抓在线简历，' +
      '把截图路径与 OCR 正文缓存进集合（之后 pool_get_detail / pool_export 直接读缓存，不再消耗配额）。' +
      '默认 dryRun=true 只返回将要抓取的名单，**必须显式传 dryRun=false 才会执行**。' +
      `limit 限制本次人数（单次硬上限 ${RESUME_BATCH_HARD_LIMIT}，比打招呼更保守，因为简历配额通常稀缺得多）。` +
      '可传 ids 只抓指定的人；refresh=true 会把已有简历的人也重抓（同样消耗配额）。' +
      '逐个之间有 4-9 秒随机间隔，每成功一个立即落盘，中断后再次调用会自动跳过已抓到的人。' +
      '前置条件：浏览器当前须已在「推荐」/「深度搜索」/「常规搜索」页且列表已加载（不会自动跳转）。' +
      '说明：Boss 的在线简历不是可下载的文件，而是页面内渲染，因此这里的产物是 PNG 截图 + OCR 文本。' +
      '人数较多时整个调用可能持续数分钟。',
    annotations: {
      title: '集合：批量抓在线简历（消耗配额）',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
        dryRun: {
          type: 'boolean',
          description: '默认 true（只预演不执行）；必须显式传 false 才真正抓取',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: RESUME_BATCH_HARD_LIMIT,
          description: `本次最多抓取人数，默认且最大 ${RESUME_BATCH_HARD_LIMIT}`,
        },
        ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          description: '可选：只抓这些候选人 id；省略则抓所有还没有简历的人',
        },
        refresh: {
          type: 'boolean',
          description: '已有简历的人也重新抓取（同样消耗配额），默认 false',
        },
      },
      required: ['job'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const job = requireString(args, 'job', 'pool_batch_resume');
      const dryRun = optBool(args, 'dryRun') !== false;
      // 预演阶段不碰浏览器，所以只在真执行前检查 OCR 前置条件
      if (!dryRun) {
        assertResumeOcrReady('pool_batch_resume');
      }
      return batchResume({
        job,
        dryRun,
        limit: optPositiveInt(args, 'limit'),
        ids: args.ids === undefined ? undefined : requireIdList(args, 'ids', 'pool_batch_resume'),
        refresh: optBool(args, 'refresh') === true,
        signal: ctx.signal,
        onProgress: (done, total, label) => ctx.tick(`已抓取 ${done}/${total}：${label}`),
      });
    },
  },
  {
    name: 'pool_export',
    description:
      '把集合导出成一份 Markdown 文件（名单速览表 + 每人的简历正文），落到 ~/.boss-cli/.cache/pool/exports/ 并返回绝对路径。' +
      '只读本地缓存，不碰浏览器、不消耗任何配额。' +
      'onlyWithDetail=true 时只导出已抓到简历的人；includeDetail=false 时只导出名单表格不含正文。',
    annotations: { title: '集合：导出为 Markdown', readOnlyHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'string', description: '集合名' },
        includeDetail: { type: 'boolean', description: '是否包含简历正文，默认 true' },
        onlyWithDetail: { type: 'boolean', description: '只导出已抓到简历的人，默认 false' },
      },
      required: ['job'],
      additionalProperties: false,
    },
    run: async (args) => {
      const job = requireString(args, 'job', 'pool_export');
      const result = await poolExportMarkdown(job, {
        includeDetail: optBool(args, 'includeDetail') !== false,
        onlyWithDetail: optBool(args, 'onlyWithDetail') === true,
      });
      return [
        `已导出集合「${job}」：${result.total} 人（含简历正文 ${result.withDetail} 人）。`,
        `文件：${result.path}`,
        result.withDetail < result.total
          ? '提示：部分候选人还没有简历正文，可先用 pool_batch_resume 批量抓取后再导出。'
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
];

const TOOLS: Tool[] = TOOL_SPECS.map(({ run: _run, ...tool }) => tool);
const TOOL_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

// ── Server ───────────────────────────────────────────────────
/**
 * 版本号仅用于 serverInfo 与日志，读不到 package.json 不该让长驻 server 起不来。
 */
function resolvePackageMeta(): { name: string; version: string } {
  try {
    return getPackageMeta();
  } catch (e) {
    console.error(
      `[boss-mcp] 读取 package.json 失败，使用占位版本号继续启动：${e instanceof Error ? e.message : String(e)}`,
    );
    return { name: '@joohw/boss-cli', version: '0.0.0-unknown' };
  }
}

const { name: pkgName, version: pkgVersion } = resolvePackageMeta();

const server = new Server(
  { name: 'boss-cli', version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
  const toolName = request.params.name;
  const spec = TOOL_BY_NAME.get(toolName);
  if (!spec) {
    return textResult(`❌ 未知工具: ${toolName}`, true);
  }

  const args = argsOf(request.params.arguments);

  // 心跳只在客户端给了 progressToken 时才发（无 token 时发 progress 不合协议）
  const progressToken = extra._meta?.progressToken;
  let progressSeq = 0;
  const tick = (message?: string): void => {
    if (progressToken === undefined || progressToken === null) return;
    progressSeq += 1;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progressSeq,
          message: message ?? `${toolName} 执行中…`,
        },
      })
      .catch(() => {
        /* 通道已关闭时忽略 */
      });
  };

  return serialize(() =>
    runToolCall({
      toolName,
      signal: extra.signal,
      tick,
      timeoutMs: TOOL_TIMEOUT_MS,
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      resetSession: () => detachBrowserSession(),
      pendingCount: () => queueDepth,
      // 把共享层那条英文会话锁超时错误改写成可操作指引
      mapErrorMessage: enhanceToolErrorMessage,
      execute: (ctx) => {
        configureHeadlessForTool(toolName);
        return spec.run(args, ctx);
      },
    }),
  );
});

// ── 生命周期：会话在调用之间常驻，仅在退出时 detach（不关用户的浏览器窗口） ──
let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error(`[boss-mcp] 正在退出（${reason}），断开 CDP 但保留浏览器窗口…`);
  unregisterInstance();
  // detach 卡住时不能拖死退出流程
  await Promise.race([
    detachBrowserSession().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// stdio 传输下客户端关闭 stdin 即视为断开
server.onclose = () => void shutdown('transport closed');

// 长驻进程不能被一条漏网的 rejection 静默干掉：记录下来，让 server 继续服务。
// （CLI 是短命进程所以无所谓，MCP 下崩一次等于整个会话断线。）
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`[boss-mcp] 未处理的 Promise rejection（已忽略，server 继续运行）：${message}`);
});
process.on('uncaughtException', (error) => {
  console.error(`[boss-mcp] 未捕获异常（已忽略，server 继续运行）：${error.stack ?? error.message}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  [
    `[boss-mcp] ${pkgName} ${pkgVersion} MCP server 已启动（stdio），共 ${TOOLS.length} 个工具`,
    `单次调用看门狗 ${TOOL_TIMEOUT_MS === 0 ? '已关闭' : `${TOOL_TIMEOUT_MS}ms`}`,
    `心跳 ${HEARTBEAT_INTERVAL_MS}ms`,
  ].join('，'),
);
console.error(formatEnvLoadReport(envReport));

// 多实例告警：把「稍后莫名 30s session is busy」提前暴露成启动时的一条明确告警
const { conflict } = registerInstance();
if (conflict) {
  console.error(formatInstanceConflictWarning(conflict));
}
