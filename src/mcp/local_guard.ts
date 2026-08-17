/**
 * 本机运行前置约束：把「原项目赖以不被识别的三个隐式前提」变成显式、启动即校验的硬约束。
 *
 * 背景（为什么需要这个模块）：
 * `common/boss_page_guards.ts` 的页面守卫只覆盖 `navigator.webdriver` / `languages` / `close` /
 * `history` / `Location` / `console` 六项，它的注释还明确写了「不再伪造 navigator.plugins 与
 * window.chrome：伪造反而会被一眼分辨」。也就是说这套守卫的**成立条件是「真实机器 + 有头浏览器」**——
 * WebGL renderer、字体列表、screen.*、Notification.permission、mediaDevices、时区这些它一概不管，
 * 因为在那个前提下它们本来就是真的。
 *
 * 一旦把浏览器搬到无头 / 无 GPU / 无字体的服务器，守卫没覆盖的那一整片会同时变成裸露特征，
 * 而登录页（`boss_availability.ts` 的 REQUIRED_LOGIN_SCRIPT_URLS：browser-check-v2、warlock
 * 2.2.15、zhipin-sign 三件套）正是采集最重的一次，且结果绑定到**账号**而不是单次请求。
 *
 * 所以这里做三件事，都是纯本地判断，不发任何网络请求：
 * 1. {@link assertHeadfulRuntime}   —— 无头即拒绝启动，不提供绕过开关。
 * 2. {@link createBrowserCallThrottle} —— 相邻浏览器类调用之间插入随机间隔，补上 MCP 相对 CLI 缺失的「人类停顿」。
 * 3. {@link inspectBrowserProfile}  —— 启动时检查 profile 是否已有登录态，缺失时指引先在终端 `boss login`。
 *
 * 依赖（时钟 / 等待 / 文件系统）全部可注入，便于在不真的睡觉、不碰真实目录的前提下单测。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomIntInclusive, sleep } from '../browser/timing.js';
// 只读导入：`REMOTE_DEBUGGING_PORT` 未从 browser/index.ts 转出，故直连模块。不修改共享层。
import { REMOTE_DEBUGGING_PORT } from '../browser/cdp_browser.js';
import { BROWSER_USER_DATA_DIR } from '../config.js';

export { REMOTE_DEBUGGING_PORT };

// ── 1) 有头运行约束 ────────────────────────────────────────────

/** 与 `cdp_browser.ts` / `cliRouter.ts` 对 `BOSS_BROWSER_HEADLESS` 的判定保持一致 */
function envTruthy(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

export const HEADLESS_REFUSAL_MESSAGE = [
  '[boss-mcp] ❌ 拒绝启动：检测到 BOSS_BROWSER_HEADLESS 为真（无头模式）。',
  '',
  'boss-cli 的页面守卫（common/boss_page_guards.ts）只处理 navigator.webdriver / languages /',
  'close / history / Location / console 六项，它刻意不伪造 plugins 与 window.chrome，因为',
  '「伪造反而会被一眼分辨」。这套守卫的成立前提是**真实机器 + 有头浏览器**。',
  '',
  '无头运行时，守卫完全没有覆盖的这些特征会同时暴露：',
  '  - WebGL renderer 变成 SwiftShader / llvmpipe（无 GPU）',
  '  - 字体列表近乎为空（中文站点上 measureText 指纹极其独特）',
  '  - screen.* / outerWidth / devicePixelRatio 为无头固定组合',
  '  - Notification.permission 恒为 denied、无 mediaDevices、无可信交互事件历史',
  '',
  '而登录页是风控采集最重的一次，且结果绑定到账号而非单次请求。',
  '',
  '正确做法：boss-mcp 跑在你日常使用的那台机器上（有头、真实出口 IP、已有可信设备记录），',
  '需要 Agent 远程调用时，把 stdio MCP 通过内网穿透 / VPN 暴露给客户端，而不是把浏览器搬到服务器。',
  '',
  '请从 MCP 客户端配置的 env、~/.boss-cli/.env 或 shell 环境里移除 BOSS_BROWSER_HEADLESS 后重启。',
].join('\n');

/**
 * 无头即抛错。**刻意不提供绕过开关**：
 * `AGENTS.md` 要求「禁止添加任何回退逻辑」，`skills/boss-frontend-analysis/SKILL.md` 也明确
 * 「Do not add fallback or bypass switches for availability checks」。留一个 env 逃生门等于这条约束不存在。
 */
export function assertHeadfulRuntime(
  env: { BOSS_BROWSER_HEADLESS?: string } = process.env,
): void {
  if (envTruthy(env.BOSS_BROWSER_HEADLESS)) {
    throw new Error(HEADLESS_REFUSAL_MESSAGE);
  }
}

/**
 * 只查环境变量是不够的——`connectBrowser()` 有一条**复用**分支：
 * 探测 `127.0.0.1:<port>/json/version` 命中就直接 `puppeteer.connect()`，
 * 此时 `BOSS_BROWSER_HEADLESS` 完全不参与决策。如果那个端口上占着的是一只**陈旧的无头 Chrome**
 * （典型来源：早先的无头登录实验没退干净），后续每一次工具调用都会静默复用它，
 * 有头约束被绕过而没有任何提示。
 *
 * 判据必须用 `User-Agent` 而不是 `Browser` 字段。实测（Chrome 151，`--headless=new`）：
 *   无头  Browser: "Chrome/151.0.7922.138"  User-Agent: "...HeadlessChrome/151.0.0.0 Safari/537.36"
 *   有头  Browser: "Chrome/151.0.7922.138"  User-Agent: "...Chrome/151.0.0.0 Safari/537.36"
 * 两者的 `Browser` 完全一致——新版无头模式已不在该字段标注，只有 UA 里还留着 `HeadlessChrome`。
 */
export const HEADLESS_UA_MARKER = 'HeadlessChrome';

export type DebugPortProbe = {
  reachable: boolean;
  userAgent?: string;
  headless: boolean;
};

/** 探测调试端口上那只浏览器是不是无头的。端口不通不算错误——届时会 spawn 一只新的有头浏览器。 */
export async function probeDebugPortBrowser(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 800,
): Promise<DebugPortProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    if (!res.ok) {
      return { reachable: false, headless: false };
    }
    const data = (await res.json()) as { 'User-Agent'?: string };
    const userAgent = typeof data['User-Agent'] === 'string' ? data['User-Agent'] : '';
    return { reachable: true, userAgent, headless: userAgent.includes(HEADLESS_UA_MARKER) };
  } catch {
    return { reachable: false, headless: false };
  } finally {
    clearTimeout(timer);
  }
}

export function formatStaleHeadlessMessage(port: number, userAgent: string): string {
  return [
    `❌ 拒绝执行：调试端口 ${port} 上占着一只**无头** Chrome，复用它会绕过有头约束。`,
    `   检测到的 User-Agent：${userAgent}`,
    '',
    '来源通常是早先的无头运行没退干净。boss-cli 的复用逻辑只探测端口是否可达，',
    '不校验对端是否有头，所以必须在这里拦下来。',
    '',
    '清理（PowerShell）：',
    '  Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" |',
    '    Where-Object { $_.CommandLine -like \'*--headless*\' } |',
    '    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    '',
    '清理后重新调用即可——boss-cli 会从同一个 profile 重新拉起一只有头 Chrome，登录态不丢。',
  ].join('\n');
}

/**
 * 无头浏览器占用调试端口时抛错。与 {@link assertHeadfulRuntime} 一样不提供绕过开关。
 */
export async function assertDebugPortBrowserIsHeadful(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const probe = await probeDebugPortBrowser(port, fetchImpl);
  if (probe.reachable && probe.headless) {
    throw new Error(formatStaleHeadlessMessage(port, probe.userAgent ?? '(未知)'));
  }
}

// ── 2) 调用间节流 ──────────────────────────────────────────────

export type GapRange = { min: number; max: number };

/** 相邻浏览器类调用之间的默认随机间隔。参照 `pool_batch` 的 3-8s / 4-9s，通用命令取略小的量级。 */
export const DEFAULT_CALL_GAP_MS: GapRange = { min: 1_800, max: 5_000 };

/**
 * 解析 `BOSS_MCP_CALL_GAP_MS`：支持 `"1800-5000"`（区间）与 `"2500"`（固定值）；
 * `"0"` 表示关闭节流。非法输入回落到默认值，并把原因交给调用方决定是否记日志。
 *
 * 纯函数，便于单测。
 */
export function parseCallGapMs(raw: string | undefined): {
  gap: GapRange;
  invalidInput?: string;
} {
  const text = (raw ?? '').trim();
  if (!text) {
    return { gap: DEFAULT_CALL_GAP_MS };
  }

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(text);
  if (range) {
    const min = Number.parseInt(range[1]!, 10);
    const max = Number.parseInt(range[2]!, 10);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min) {
      return { gap: { min, max } };
    }
    return { gap: DEFAULT_CALL_GAP_MS, invalidInput: text };
  }

  if (/^\d+$/.test(text)) {
    const fixed = Number.parseInt(text, 10);
    if (Number.isFinite(fixed) && fixed >= 0) {
      return { gap: { min: fixed, max: fixed } };
    }
  }

  return { gap: DEFAULT_CALL_GAP_MS, invalidInput: text };
}

/**
 * 完全不碰浏览器的工具（纯文件系统读写），不需要节流。
 * 判定方向刻意保守：**只有明确列在这里的才免节流**，新增工具默认按「会碰浏览器」处理。
 * `pool_get_detail` 不在列内——它传 preview=true 时会打开在线简历。
 */
export const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'pool_add',
  'pool_list',
  'pool_remove',
  'pool_mark',
  'pool_clear',
  'pool_export',
]);

export type BrowserCallThrottleDeps = {
  gapMs: GapRange;
  isLocalOnly?: (toolName: string) => boolean;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pickGap?: (min: number, max: number) => number;
};

export type BrowserCallThrottle = {
  /**
   * 在浏览器类调用真正动手之前等待，返回实际等待毫秒数（0 表示无需等待）。
   * 必须在串行队列内部调用，否则多个调用的间隔会互相重叠而失效。
   */
  beforeCall: (toolName: string, signal?: AbortSignal) => Promise<number>;
  /** 调用结束（成功或失败）后记录完成时刻，作为下一次间隔的起点 */
  afterCall: (toolName: string) => void;
};

/**
 * 让相邻的浏览器类调用之间保持随机间隔。
 *
 * 为什么 MCP 需要而 CLI 不需要：CLI 下人敲一条命令、思考、再敲下一条，天然有几十秒的停顿，
 * 且每条命令结束都 `detachBrowserSession()`；MCP 的串行队列只保证**不并发**，不保证**间隔**，
 * Agent 会零停顿地连续调用，而 `human_delay.ts` 里的随机延迟全是页面内动作级（几百 ms），
 * 覆盖不到「命令与命令之间」这一层。
 */
export function createBrowserCallThrottle(
  deps: BrowserCallThrottleDeps,
): BrowserCallThrottle {
  const isLocalOnly = deps.isLocalOnly ?? ((name: string) => LOCAL_ONLY_TOOLS.has(name));
  const now = deps.now ?? (() => Date.now());
  const wait = deps.wait ?? sleep;
  const pickGap = deps.pickGap ?? randomIntInclusive;
  const { min, max } = deps.gapMs;

  let lastBrowserCallEndedAt: number | null = null;

  return {
    async beforeCall(toolName, signal) {
      if (isLocalOnly(toolName)) {
        return 0;
      }
      if (max <= 0) {
        return 0;
      }
      if (lastBrowserCallEndedAt === null) {
        // 进程内第一次浏览器调用不额外等待：此时并不存在「上一个动作」。
        return 0;
      }
      const target = pickGap(min, max);
      const elapsed = now() - lastBrowserCallEndedAt;
      const remaining = target - elapsed;
      if (remaining <= 0) {
        return 0;
      }
      // `sleep` 在 abort 时 reject('Aborted')：客户端已放弃时不应继续去消耗真实配额。
      await wait(remaining, signal);
      return remaining;
    },
    afterCall(toolName) {
      if (isLocalOnly(toolName)) {
        return;
      }
      lastBrowserCallEndedAt = now();
    },
  };
}

export function formatCallGapNotice(gap: GapRange, invalidInput?: string): string {
  const lines: string[] = [];
  if (invalidInput !== undefined) {
    lines.push(
      `[boss-mcp] ⚠️ BOSS_MCP_CALL_GAP_MS 取值非法（${invalidInput}），已回落到默认值。` +
        '支持格式："1800-5000"（区间）、"2500"（固定）、"0"（关闭）。',
    );
  }
  lines.push(
    gap.max <= 0
      ? '[boss-mcp] ⚠️ 调用间节流已关闭：Agent 会零停顿连续操作，行为节奏与人类差异明显，风控风险升高。'
      : `[boss-mcp] 浏览器类调用之间保持 ${gap.min}-${gap.max}ms 随机间隔（纯本地 pool_* 工具不节流）。`,
  );
  return lines.join('\n');
}

// ── 3) profile 登录态自检 ──────────────────────────────────────

export type BrowserProfileState = {
  dir: string;
  /** 目录存在且非空——说明 Chrome 至少在这个 profile 上跑过 */
  initialized: boolean;
  /** 找到 Cookies 库文件——说明大概率已有登录态 */
  hasCookieStore: boolean;
};

/**
 * 纯本地检查 profile 目录状态，不启动浏览器、不读 cookie 内容。
 *
 * 目的：服务器上那个全新的 `browser-data` 等于一台 Boss 从没见过的设备，
 * 「新设备 + 新 ASN」本身就是强风控信号。启动时把这件事说清楚，
 * 比等到调用 `boss_list_candidates` 报「未登录」再回头查要省事得多。
 */
export function inspectBrowserProfile(
  dir: string = BROWSER_USER_DATA_DIR,
  fs: { existsSync: typeof existsSync; readdirSync: typeof readdirSync } = {
    existsSync,
    readdirSync,
  },
): BrowserProfileState {
  if (!fs.existsSync(dir)) {
    return { dir, initialized: false, hasCookieStore: false };
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // 读不动目录时按「未初始化」处理：这里只用于提示，不该让 server 起不来。
    return { dir, initialized: false, hasCookieStore: false };
  }

  const profileDir = process.env.BOSS_BROWSER_PROFILE_DIRECTORY?.trim() || 'Default';
  const hasCookieStore =
    fs.existsSync(join(dir, profileDir, 'Network', 'Cookies')) ||
    fs.existsSync(join(dir, profileDir, 'Cookies'));

  return { dir, initialized: entries.length > 0, hasCookieStore };
}

/**
 * 注意这条提示能证明什么、不能证明什么：
 * - 能证明：profile 目录存在 / Chrome 曾在它上面跑过 / Cookie 库文件已创建。
 * - **不能证明已登录**。Cookie 库里可能只有 `__a` / `__c` / `ab_guid` 这类埋点 cookie，
 *   一条登录态都没有。运行中的 Chrome 会以 FileShare.None 独占该文件，启动时无法读取其内容，
 *   因此这里刻意不声称「已登录」，避免给出比证据更强的结论。
 */
export function formatProfileNotice(state: BrowserProfileState): string {
  if (state.hasCookieStore) {
    return [
      `[boss-mcp] 浏览器 profile：${state.dir}`,
      '[boss-mcp]   Cookie 库已存在（注意：这只说明 Chrome 用过该 profile，不代表已登录）。',
      '[boss-mcp]   若工具返回「未登录」或未出现侧栏 .menu-list，请在本机终端执行 `boss login` 并用 App 扫码。',
    ].join('\n');
  }
  return [
    `[boss-mcp] ⚠️ 浏览器 profile ${state.initialized ? '已初始化但未检测到 Cookie 库' : '尚未初始化'}：${state.dir}`,
    '[boss-mcp]   这是一台 Boss 从未见过的「新设备」。请先在**本机终端**执行 `boss login` 并用 App 扫码，',
    '[boss-mcp]   让登录发生在有头浏览器里；boss-mcp 只复用已有登录态，不代替你完成登录。',
  ].join('\n');
}
