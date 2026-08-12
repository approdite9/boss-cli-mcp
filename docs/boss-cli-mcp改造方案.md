# boss-cli → MCP 改造方案

> 目标：在不改动现有业务逻辑的前提下，把 `@joohw/boss-cli` 的主要能力封装为 MCP（Model Context Protocol）Server，供 Claude Desktop / Cline / 其它 MCP 客户端直接调用。 结论先行：**改造成本很低**。项目业务逻辑已全部函数化（`src/toolset/index.ts` 里的 `impl*`），且返回值统一为 `Promise<string>`（结构化纯文本），只需新增一个平行于 `src/cli/` 的 `src/mcp/` 入口即可，业务层、浏览器层、公共层零改动。

---

## 一、为什么改造成本低

boss-cli 已具备 MCP 化的两个关键前提：

1. **业务逻辑已函数化**：每个命令对应 `src/toolset/index.ts` 的一个 `impl*` 函数，CLI 路由层（`cliRouter.ts`）只是薄薄一层参数解析。MCP Server 只需换一个调用入口去调这些函数。
2. **返回值统一为 **`Promise<string>`：本就是为「Agent 子进程编排」设计的结构化纯文本，可直接作为 MCP tool 的 `text` content 返回，无需二次序列化。

改造原则：**保留 **`toolset/`** + **`browser/`** + **`common/`** 全部不动，只新增 **`src/mcp/server.ts`**。**

```
src/
├── cli/          ← 现有 CLI 入口（保留）
│   ├── index.ts
│   └── cliRouter.ts
├── mcp/          ← 【新增】MCP 入口
│   └── server.ts
├── toolset/      ← 业务实现（CLI 与 MCP 共享，零改动）
├── browser/      ← CDP 会话复用（共享）
├── common/       ← 登录 / 反检测 / 页面守卫（共享）
├── ocr/          ← 百度 OCR（共享）
└── config.ts

```

---

## 二、能力 → MCP Tool 映射表

映射基于已核对的真实函数签名（`src/toolset/index.ts`）。所有 `impl*` 均返回 `Promise<string>`。

| MCP Tool 名 | 复用的 impl 函数 | 输入参数 | 说明 |
| --- | --- | --- | --- |
| `boss_login` | `implLogin()` | — | 打开登录页；**非阻塞**，提示用户手动完成 |
| `boss_list_candidates` | `implListCandidates()` / `implListUnreadCandidates()` | `unread?: boolean` | 读取聊天列表；unread 仅未读 |
| `boss_open_chat` | `implOpenChat(name, exact)` | `name: string`, `strict?: boolean` | 按姓名打开会话 |
| `boss_open_chat_by_index` | `implOpenChatByIndex({index, unreadOnly, expectedName, exact})` | `index: number`, `unread?`, `name?`, `strict?` | 按 list 序号打开 |
| `boss_send_message` | `implSendMessage({text, requestResume})` | `text: string`, `requestResume?: boolean` | 向当前会话发消息 |
| `boss_chat_action` | `implChatAction({action, remark})` | `action: enum`, `remark?: string` | resume / not-fit / remark / agree-resume / request-attachment-resume / history / wechat |
| `boss_recommend` | `implRecommend(jobKeyword?)` | `jobKeyword?: string` | 进入推荐页并读取列表 |
| `boss_greet` | `implRecommendGreet({candidateTarget, jobKeyword})` | `name: string`, `job?: string` | 对推荐/深搜列表候选人打招呼 |
| `boss_search` | `implNormalSearch(keyword?)` | `keyword?: string` | 常规搜索牛人列表 |
| `boss_deep_search` | `implBossSearch({jobKeyword, coreRequirements, bonusRequirements, match})` | `jobKeyword?`, `core?: string[]`, `bonus?: string[]`, `match?: boolean` | 深度搜索；仅 match=true 才消耗匹配次数 |
| `boss_deep_search_set` | `implBossSearchSet({jobKeyword, coreRequirements, bonusRequirements})` | 同上（不含 match） | 仅设置表单，不点匹配 |
| `boss_preview_resume` | `implPreview({candidateTarget})` | `name: string` | 在线简历预览（每日次数有限） |
| `boss_list_positions` | `implListPositions()` / `implListPositionsWithOptions({detail, name})` | `detail?: boolean`, `name?: string` | 读取职位列表 |
| `boss_get_jd` | `implListPositionsWithOptions({detail:true, name})` | `name: string` | 抓取职位 JD |

> ⚠️ 注意：`greet` 与 `preview` 会**消耗平台配额**（打招呼次数 / 简历查看次数），在 tool 的 `description` 里必须写明，让 Agent 谨慎调用。

---

## 三、三个必须处理的技术点

### 1. 浏览器会话生命周期（最关键）

- **CLI 现状**：每条命令跑完调用 `detachBrowserSession()`（见 `cliRouter.ts` 的 `cleanupAfterCommand`），只 detach 不关窗口。
- **MCP 改造**：MCP Server 是**长驻进程**，策略要反过来——- **保持 CDP 连接常驻**，靠 `browser_session.ts` 已有的复用逻辑（固定端口 53470 探测复用同一只 Chrome）在多次 tool 调用间共享会话；
- **不要**在每个 tool 调用后 detach；
- 只在 Server 收到 `SIGINT/SIGTERM` 关闭时才调用 `detachBrowserSession()`。
- 这反而比 CLI 更高效：省去反复重连的开销。

### 2. `boss_login` 的交互性

`boss login` 需要用户在浏览器扫码/手动完成，不能在 tool 里阻塞等待。返回文案应为：

> "已打开 Boss 登录页，请在浏览器中完成扫码/验证登录，完成后再调用其它工具。"

### 3. 并发串行化

CDP 操作同一只浏览器**不能并发**（会互相抢页面焦点）。MCP Server 应在内部维护一个**串行队列（mutex）**，保证 tool 调用逐个执行——boss-cli 现有的 `boss_session_lock.ts` 已有会话锁机制，可复用其思路或在 MCP 层加一把简单的 Promise 链锁。

---

## 四、传输方式选择

| 传输 | 适用场景 | 建议 |
| --- | --- | --- |
| **stdio** | Claude Desktop / Cline 等本地客户端 | ✅ **推荐**，最贴合现有「子进程编排」定位 |
| HTTP + SSE | 远程访问、多客户端共享 | 需要时再加，改动仅在传输层 |

---

## 五、依赖与配置改动

### `package.json`

```jsonc
{
  "dependencies": {
    "dotenv": "^17.4.2",
    "puppeteer-core": "^24.29.1",
    "@modelcontextprotocol/sdk": "^1.0.0"   // 新增
  },
  "bin": {
    "boss": "dist/cli/index.js",
    "boss-mcp": "dist/mcp/server.js"          // 新增：MCP 入口
  }
}

```

> `puppeteer-core` 那套完全不动，只加一个官方 SDK 依赖。

### Claude Desktop 配置示例（`claude_desktop_config.json`）

```jsonc
{
  "mcpServers": {
    "boss-cli": {
      "command": "node",
      "args": ["/绝对路径/boss-cli/dist/mcp/server.js"],
      "env": {
        "BOSS_BROWSER_HEADLESS": "false"
      }
    }
  }
}

```

---

## 六、`src/mcp/server.ts` 骨架（stdio 传输）

```ts
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { APP_HOME } from '../config.js';
import { detachBrowserSession } from '../browser/index.js';
import {
  implLogin,
  implListCandidates,
  implListUnreadCandidates,
  implOpenChat,
  implOpenChatByIndex,
  implSendMessage,
  implChatAction,
  implRecommend,
  implRecommendGreet,
  implNormalSearch,
  implBossSearch,
  implBossSearchSet,
  implPreview,
  implListPositions,
  implListPositionsWithOptions,
  type ChatPageAction,
} from '../toolset/index.js';

// —— 环境变量：与 CLI 入口保持一致 ——
const userEnv = join(APP_HOME, '.env');
if (existsSync(userEnv)) loadEnv({ path: userEnv, quiet: true });
loadEnv({ quiet: true });

// —— 串行队列：CDP 同一浏览器不能并发 ——
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

// —— Tool 定义（inputSchema 用 JSON Schema）——
const TOOLS = [
  { name: 'boss_login', description: '打开 Boss 登录页（用户需在浏览器手动完成扫码/验证，本工具立即返回）', inputSchema: { type: 'object', properties: {} } },
  { name: 'boss_list_candidates', description: '读取聊天列表候选人；unread=true 仅未读', inputSchema: { type: 'object', properties: { unread: { type: 'boolean' } } } },
  { name: 'boss_open_chat', description: '按姓名打开候选人会话；strict=true 精确匹配', inputSchema: { type: 'object', properties: { name: { type: 'string' }, strict: { type: 'boolean' } }, required: ['name'] } },
  { name: 'boss_open_chat_by_index', description: '按 list 输出的 1-based 序号打开会话', inputSchema: { type: 'object', properties: { index: { type: 'number' }, unread: { type: 'boolean' }, name: { type: 'string' }, strict: { type: 'boolean' } }, required: ['index'] } },
  { name: 'boss_send_message', description: '向当前已打开的会话发送文本；requestResume=true 发送后自动求简历', inputSchema: { type: 'object', properties: { text: { type: 'string' }, requestResume: { type: 'boolean' } }, required: ['text'] } },
  { name: 'boss_chat_action', description: '对当前会话执行操作：resume|not-fit|remark|agree-resume|request-attachment-resume|history|wechat；action=remark 时须传 remark', inputSchema: { type: 'object', properties: { action: { type: 'string' }, remark: { type: 'string' } }, required: ['action'] } },
  { name: 'boss_recommend', description: '进入推荐页并读取推荐列表；可传岗位关键字先切换岗位', inputSchema: { type: 'object', properties: { jobKeyword: { type: 'string' } } } },
  { name: 'boss_greet', description: '【消耗打招呼次数，谨慎】对当前推荐/深搜列表中候选人打招呼', inputSchema: { type: 'object', properties: { name: { type: 'string' }, job: { type: 'string' } }, required: ['name'] } },
  { name: 'boss_search', description: '进入常规搜索页读取牛人列表；可传关键词', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } } },
  { name: 'boss_deep_search', description: '深度搜索；core/bonus 为字符串数组；match=true 才点「立即匹配」并消耗今日匹配次数', inputSchema: { type: 'object', properties: { jobKeyword: { type: 'string' }, core: { type: 'array', items: { type: 'string' } }, bonus: { type: 'array', items: { type: 'string' } }, match: { type: 'boolean' } } } },
  { name: 'boss_preview_resume', description: '【消耗每日简历查看次数，谨慎】在线简历预览，须已在推荐/深搜/常规搜索页且列表已加载', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'boss_list_positions', description: '读取职位列表；detail=true+name 抓取该职位 JD', inputSchema: { type: 'object', properties: { detail: { type: 'boolean' }, name: { type: 'string' } } } },
];

const server = new Server(
  { name: 'boss-cli', version: '0.6.6' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  const args = a as Record<string, any>;
  return serialize(async () => {
    switch (name) {
      case 'boss_login':
        return ok(await implLogin());
      case 'boss_list_candidates':
        return ok(await (args.unread ? implListUnreadCandidates() : implListCandidates()));
      case 'boss_open_chat':
        return ok(await implOpenChat(args.name, !!args.strict));
      case 'boss_open_chat_by_index':
        return ok(await implOpenChatByIndex({ index: args.index, unreadOnly: args.unread, expectedName: args.name, exact: args.strict }));
      case 'boss_send_message':
        return ok(await implSendMessage({ text: args.text, requestResume: args.requestResume }));
      case 'boss_chat_action':
        return ok(await implChatAction({ action: args.action as ChatPageAction, remark: args.remark }));
      case 'boss_recommend':
        return ok(await implRecommend(args.jobKeyword));
      case 'boss_greet':
        return ok(await implRecommendGreet({ candidateTarget: args.name, jobKeyword: args.job }));
      case 'boss_search':
        return ok(await implNormalSearch(args.keyword));
      case 'boss_deep_search':
        return ok(await implBossSearch({ jobKeyword: args.jobKeyword, coreRequirements: args.core, bonusRequirements: args.bonus, match: args.match }));
      case 'boss_preview_resume':
        return ok(await implPreview({ candidateTarget: args.name }));
      case 'boss_list_positions':
        return ok(await implListPositionsWithOptions({ detail: args.detail, name: args.name }));
      default:
        return { content: [{ type: 'text' as const, text: `未知工具: ${name}` }], isError: true };
    }
  });
});

// —— 生命周期：仅在退出时 detach，会话在调用间常驻 ——
async function shutdown() {
  await detachBrowserSession().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[boss-mcp] MCP server started (stdio)');

```

> 说明：
> - `detachBrowserSession` 从 `browser/index.js` 导出（`cliRouter.ts` 已在用），若导出名不同请对照 `src/browser/index.ts` 调整。
> - 上表少数工具（如 `boss_deep_search_set`、`boss_get_jd` 单独入口）可按需补齐，模式完全一致。
> - JSON Schema 里 boolean/array 已够用；若想要更强校验可引入 `zod` + `zodToJsonSchema`。

---

## 七、落地步骤

1. `npm i @modelcontextprotocol/sdk`
2. 新建 `src/mcp/server.ts`（用上面骨架），按需补全剩余工具。
3. `package.json` 的 `bin` 增加 `"boss-mcp": "dist/mcp/server.js"`。
4. 确认 `tsconfig.json` 的 `include`/`outDir` 覆盖 `src/mcp`（现有 `tsc` 通常已覆盖整个 `src`，无需改）。
5. `npm run build` → 产物 `dist/mcp/server.js`。
6. 在 MCP 客户端配置里指向该文件（见 §五示例）。
7. 首次使用先调 `boss_login` 完成登录，再调用其它工具。

---

## 八、风险与注意

- **强依赖 Boss 前端结构**：平台一更新页面/风控就可能失效，需跟随上游 boss-cli 版本更新（作者在 help 里已提示）。
- **配额类工具**（greet / preview / deep_search --match）会消耗真实平台次数，务必在 description 里警示，避免 Agent 误批量调用。
- **反检测依赖**：MCP 复用的是同一套 `common/` 反检测注入逻辑，不受传输层影响，保持不动即可。
- **单浏览器串行**：切勿去掉 §三.3 的串行队列，否则并发 tool 调用会互相抢页面导致误判。

---

## 九、进阶工作台：JD → 候选人集合 → 人工审核 → 批量打招呼 ⭐

> 这一节把 MCP 从「命令转发器」升级为「有状态的招聘工作台」。核心区别：**MCP 自己维护一个可增删、可查看、可持久化的候选人集合（pool）**，你审核满意后再一次性批量打招呼。

### 9.1 理想工作流

```
① 你粘贴一大段 JD
        ↓ (AI 解析，不消耗任何配额)
② 拆成：岗位名 + 核心要求[] + 加分项[]
        ↓ boss_deep_search_set   (填表单，不消耗次数)
③ 自动搜索
        ↓ boss_deep_search_match (消耗匹配次数，返回候选人)
④ 结果汇总进「候选人集合(pool)」，持久保存，可反复查看
        ↓ 你审核：pool_add / pool_remove / pool_get_detail / pool_mark
⑤ 你说「给集合里的人都打招呼」
        ↓ pool_greet_all (dryRun 预演 → 确认 → 逐个执行，带风控延迟)
⑥ 输出打招呼结果报表

```

**关键分工**：

- 第 ① 步「解析 JD」是 **AI（LLM）天然能力**，MCP 无需实现解析器——LLM 读完 JD 直接产出 `core[]` / `bonus[]` 调用 `boss_deep_search_set`。
- 第 ④ 步「集合」是 **MCP 新增的状态层**，这是与前面基础方案最大的不同。

### 9.2 新增工具：集合层（pool_*）

集合以 JSON 持久化到 `~/.boss-cli/.cache/pool/<岗位>.json`，多次调用间保留状态。

| Tool | 作用 | 是否消耗配额 |
| --- | --- | --- |
| `pool_add({job, candidates[]})` | 把搜索结果加入候选池（按姓名/ID 自动去重） | 否 |
| `pool_list({job?})` | 查看集合（序号、姓名、匹配理由、标记、是否已打招呼） | 否 |
| `pool_get_detail({job, id})` | 看某候选人细节；需要时可触发在线简历预览 | 预览时消耗 |
| `pool_remove({job, ids[]})` | 从集合删除不合适的人 | 否 |
| `pool_mark({job, id, tag})` | 打标记（如「重点」「待定」「已看简历」） | 否 |
| `pool_clear({job})` | 清空某岗位集合 | 否 |

### 9.3 新增工具：批量执行层（带三道安全阀）

| Tool | 作用 |
| --- | --- |
| `pool_greet_all({job, dryRun?, limit?})` | 对集合中 **未打招呼** 的候选人批量打招呼 |

**三道安全阀**（防止误烧配额 / 触发 Boss 风控）：

1. `dryRun=true`** 预演**：只返回「将要给谁打招呼」的名单，不真发。默认建议先跑一次 dryRun。
2. `limit`** 单次上限**：如 `limit=20`，今天最多打 20 个，超出跳过。
3. **逐个拟人延迟**：复用 boss-cli 内置的 `human_delay`（逐字输入 38–125ms、动作间随机停顿），单个之间再加随机间隔，降低风控风险。执行后把成功者标记 `greeted=true`，下次不再重复。

### 9.4 集合数据结构（存 JSON，随时可查看/手改）

```jsonc
// ~/.boss-cli/.cache/pool/前端工程师.json
{
  "job": "前端工程师",
  "criteria": { "core": ["3年以上React", "有大型项目落地"], "bonus": ["Node全栈经验"] },
  "createdAt": "2026-08-12T10:00:00+08:00",
  "candidates": [
    { "id": 1, "name": "张三", "matchReason": "5年React，主导过千万级DAU项目", "tag": "重点", "greeted": false },
    { "id": 2, "name": "李四", "matchReason": "3年React，中型项目",            "tag": "",     "greeted": false }
  ]
}

```

### 9.5 集合层代码骨架（新增 `src/mcp/pool.ts`）

```ts
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.js';

const POOL_DIR = join(CACHE_DIR, 'pool');

export interface PoolCandidate {
  id: number;
  name: string;
  matchReason?: string;
  tag?: string;
  greeted: boolean;
}
export interface Pool {
  job: string;
  criteria: { core: string[]; bonus: string[] };
  createdAt: string;
  candidates: PoolCandidate[];
}

function poolPath(job: string): string {
  // 防止文件名非法字符
  const safe = job.replace(/[\\/:*?"<>|]/g, '_');
  return join(POOL_DIR, `${safe}.json`);
}

async function ensureDir(): Promise<void> {
  if (!existsSync(POOL_DIR)) await mkdir(POOL_DIR, { recursive: true });
}

export async function loadPool(job: string): Promise<Pool | null> {
  const p = poolPath(job);
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, 'utf8')) as Pool;
}

export async function savePool(pool: Pool): Promise<void> {
  await ensureDir();
  await writeFile(poolPath(pool.job), JSON.stringify(pool, null, 2), 'utf8');
}

/** 加入候选人，按 name 去重，自动分配递增 id */
export async function poolAdd(
  job: string,
  criteria: { core: string[]; bonus: string[] },
  incoming: Array<{ name: string; matchReason?: string }>,
): Promise<Pool> {
  await ensureDir();
  const pool: Pool =
    (await loadPool(job)) ??
    { job, criteria, createdAt: new Date().toISOString(), candidates: [] };
  pool.criteria = criteria; // 刷新条件
  const existing = new Set(pool.candidates.map((c) => c.name));
  let nextId = pool.candidates.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  for (const c of incoming) {
    if (existing.has(c.name)) continue;
    pool.candidates.push({ id: nextId++, name: c.name, matchReason: c.matchReason, tag: '', greeted: false });
    existing.add(c.name);
  }
  await savePool(pool);
  return pool;
}

export async function poolList(job: string): Promise<string> {
  const pool = await loadPool(job);
  if (!pool) return `集合「${job}」不存在。`;
  const lines = pool.candidates.map(
    (c) => `${c.id}. ${c.name}${c.tag ? ` [${c.tag}]` : ''}${c.greeted ? ' ✅已打招呼' : ''} — ${c.matchReason ?? ''}`,
  );
  return `集合「${job}」共 ${pool.candidates.length} 人：\n` + lines.join('\n');
}

export async function poolRemove(job: string, ids: number[]): Promise<string> {
  const pool = await loadPool(job);
  if (!pool) return `集合「${job}」不存在。`;
  const before = pool.candidates.length;
  pool.candidates = pool.candidates.filter((c) => !ids.includes(c.id));
  await savePool(pool);
  return `已从「${job}」删除 ${before - pool.candidates.length} 人，剩 ${pool.candidates.length} 人。`;
}

export async function poolMark(job: string, id: number, tag: string): Promise<string> {
  const pool = await loadPool(job);
  if (!pool) return `集合「${job}」不存在。`;
  const c = pool.candidates.find((x) => x.id === id);
  if (!c) return `未找到 id=${id}。`;
  c.tag = tag;
  await savePool(pool);
  return `已标记 ${c.name} 为「${tag}」。`;
}

```

### 9.6 批量打招呼骨架（追加到 `src/mcp/server.ts` 的调用分支）

```ts
import { sleep, randomIntInclusive } from '../browser/timing.js';
import { implRecommendGreet } from '../toolset/index.js';
import { loadPool, savePool, poolAdd, poolList, poolRemove, poolMark } from './pool.js';

// pool_greet_all 的核心逻辑
async function greetAll(job: string, dryRun: boolean, limit?: number): Promise<string> {
  const pool = await loadPool(job);
  if (!pool) return `集合「${job}」不存在。`;
  const pending = pool.candidates.filter((c) => !c.greeted);
  const targets = typeof limit === 'number' ? pending.slice(0, limit) : pending;

  if (dryRun) {
    return `【预演】将对以下 ${targets.length} 人打招呼（消耗 ${targets.length} 次配额），确认后去掉 dryRun 再执行：\n` +
      targets.map((c) => `- ${c.name}${c.tag ? ` [${c.tag}]` : ''}`).join('\n');
  }

  const results: string[] = [];
  for (const c of targets) {
    try {
      const r = await implRecommendGreet({ candidateTarget: c.name, jobKeyword: job });
      c.greeted = true;
      results.push(`✅ ${c.name}: ${r.slice(0, 60)}`);
      await savePool(pool); // 每个都落盘，中断也不丢进度
    } catch (e) {
      results.push(`❌ ${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 逐个之间加随机间隔，降低风控风险
    await sleep(randomIntInclusive(3000, 8000));
  }
  return `批量打招呼完成（${targets.length} 人）：\n` + results.join('\n');
}

```

对应在 `CallToolRequestSchema` 的 switch 里补充分支（均包在 `serialize()` 里）：

```ts
case 'pool_add': {
  const pool = await poolAdd(args.job, { core: args.core ?? [], bonus: args.bonus ?? [] }, args.candidates ?? []);
  return ok(`已加入集合「${args.job}」，当前 ${pool.candidates.length} 人。`);
}
case 'pool_list':        return ok(await poolList(args.job));
case 'pool_remove':      return ok(await poolRemove(args.job, args.ids ?? []));
case 'pool_mark':        return ok(await poolMark(args.job, args.id, args.tag));
case 'pool_greet_all':   return ok(await greetAll(args.job, args.dryRun !== false, args.limit)); // 默认 dryRun

```

> 注意 `pool_greet_all` 默认 `dryRun=true`（`args.dryRun !== false`），必须显式传 `dryRun:false` 才真发，作为最后一道保险。

### 9.7 新增工具的 JSON Schema（追加进 TOOLS 数组）

```ts
{ name: 'pool_add', description: '把搜索到的候选人加入指定岗位集合（自动去重）', inputSchema: { type: 'object', properties: { job: { type: 'string' }, core: { type: 'array', items: { type: 'string' } }, bonus: { type: 'array', items: { type: 'string' } }, candidates: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, matchReason: { type: 'string' } }, required: ['name'] } } }, required: ['job', 'candidates'] } },
{ name: 'pool_list', description: '查看指定岗位候选人集合', inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'] } },
{ name: 'pool_remove', description: '按 id 从集合删除候选人', inputSchema: { type: 'object', properties: { job: { type: 'string' }, ids: { type: 'array', items: { type: 'number' } } }, required: ['job', 'ids'] } },
{ name: 'pool_mark', description: '给集合中某候选人打标记', inputSchema: { type: 'object', properties: { job: { type: 'string' }, id: { type: 'number' }, tag: { type: 'string' } }, required: ['job', 'id', 'tag'] } },
{ name: 'pool_greet_all', description: '【消耗打招呼配额】对集合中未打招呼者批量打招呼；默认 dryRun 只预演，须显式传 dryRun:false 才真发；limit 限制单次数量', inputSchema: { type: 'object', properties: { job: { type: 'string' }, dryRun: { type: 'boolean' }, limit: { type: 'number' } }, required: ['job'] } },

```

### 9.8 实际对话体验（改造后）

> **你**：（粘贴一大段前端 JD）"按这个 JD 在 Boss 上匹配候选人" **AI**：已解析【核心：3年React、大项目落地；加分：Node全栈】，深度匹配到 18 人，已存入"前端工程师"集合。要看列表吗？ **你**："看一下，把没有大项目经验的删掉" **AI**：（展示 18 人）→ 已删掉 5 人，剩 13 人。 **你**："第 3 个标记为重点，看看他细节" **AI**：已标记张三为「重点」；他的简历要点：…… **你**："给剩下的都打招呼" **AI**：【预演】将对 13 人打招呼（消耗 13 次配额），确认？ **你**："确认" **AI**：✅ 已完成 11 个打招呼，2 个因今日配额上限跳过。

### 9.9 落地增量（相对基础方案）

- 新增 1 个文件：`src/mcp/pool.ts`（集合读写，约 120 行）。
- `src/mcp/server.ts`：新增 5 个工具分支 + `greetAll` 函数 + 5 条 Schema。
- **零新增依赖**（仅用 Node 内置 `fs`）。
- `boss_deep_search_match` 返回的候选人文本，由 LLM 解析后调 `pool_add` 入库——LLM 承担解析，MCP 承担存储与执行。

