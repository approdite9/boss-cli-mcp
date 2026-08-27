/**
 * boss-mcp 的落盘日志。
 *
 * 为什么需要：stdio 入口的日志走 stderr、由 MCP 客户端接管；HTTP 入口是后台常驻进程，
 * 以隐藏窗口运行时**没有任何人在看 stderr**。而这个服务的故障排查几乎完全依赖事后翻日志
 * （哪一步没打出下一条、请求耗时多少、哪个工具花掉了配额）。
 *
 * 四个文件分工：
 * - `mcp-server.log`  运行事件 + **所有 console 输出**（见 {@link installConsoleCapture}）
 * - `mcp-access.log`  逐请求一行（方法、工具名、状态码、耗时、session、ip）
 * - `mcp-audit.log`   工具调用审计：调了什么、参数、结果、是否消耗配额
 * - `stdout.log`      由 `run-mcp.cmd` 重定向产生，兜住进程级崩溃前的最后输出
 *
 * 写入用同步 append：日志量很小（每请求几行），而一旦改成异步缓冲，
 * 进程被强杀或被控制台挂起时最关键的那几行恰好会丢——那正是要看的内容。
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { ensureAppDataLayout, LOGS_DIR } from '../config.js';

const SERVER_LOG = join(LOGS_DIR, 'mcp-server.log');
const ACCESS_LOG = join(LOGS_DIR, 'mcp-access.log');
const AUDIT_LOG = join(LOGS_DIR, 'mcp-audit.log');

/**
 * 单文件轮转阈值与保留代数。
 *
 * 「全部留存」的前提是有轮转：`mcp-access.log` 每个请求一行、`mcp-server.log` 收所有 console 输出，
 * 长驻服务下无上限增长迟早撑爆磁盘，而且几百 MB 的单文件根本没法读。
 * 轮转而不是截断——历史内容移到 `.1` ~ `.5`，不丢。
 */
const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_GENERATIONS = 5;

/**
 * 在包装 console 之前抓住原始实现。
 * {@link logServer} 必须用它，否则会和 {@link installConsoleCapture} 互相调用、重复落盘。
 */
const rawConsoleError = console.error.bind(console);

function ts(): string {
  return new Date().toISOString();
}

/**
 * 首次创建日志文件时写入 UTF-8 BOM。
 *
 * 日志含中文，而主要读者是 Windows 上的 `type` 与 `Get-Content`——两者默认按系统 ANSI
 * 代码页（简中环境 GBK）解码，会把 UTF-8 显示成乱码，甚至因多字节序列吞掉换行、
 * 让整段日志连成一行。BOM 能让它们正确识别编码。
 */
function ensureLogFile(file: string): void {
  if (existsSync(file)) return;
  writeFileSync(file, '\uFEFF', 'utf8');
}

/** `x.log` → `x.log.1`，原 `.1` → `.2`，超出保留代数的丢弃。 */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  try {
    const oldest = `${file}.${KEEP_GENERATIONS}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = KEEP_GENERATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
    // 新文件由下一次 ensureLogFile 带 BOM 重建
  } catch {
    /* 轮转失败不该影响服务；继续往原文件追加 */
  }
}

function write(file: string, line: string): void {
  try {
    ensureAppDataLayout();
    rotateIfNeeded(file);
    ensureLogFile(file);
    appendFileSync(file, line + '\r\n', 'utf8');
  } catch {
    /* 日志写不进去不该影响服务本身 */
  }
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/**
 * 运行事件：先落盘，再写 stderr。
 *
 * **落盘必须在 console 之前**：Windows 控制台开启「快速编辑模式」时，只要有人在窗口里
 * 点一下或拖选文本，进程就会在下一次写 stdout/stderr 时被**挂起**（不是崩溃，不是退出）。
 * 若先写 console，进程冻在那一行，文件日志一个字都留不下——排查时会看到
 * 「Nginx 有请求记录、应用日志完全空白」这种对不上的现象，极难定位（已实际发生过）。
 * 先落盘至少能保住最后一条线索。
 *
 * 根治办法是别让服务依赖交互式控制台（`run-mcp.vbs` 以隐藏窗口运行 + 输出重定向）。
 */
export function logServer(level: LogLevel, message: string): void {
  write(SERVER_LOG, `${ts()} [${level}] ${message}`);
  rawConsoleError(`[boss-mcp] ${message}`);
}

function formatConsoleArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * 把**所有** `console` 输出也落盘到 `mcp-server.log`。
 *
 * 必要性：共享层（`app.ts`、`toolset/`、`browser/`、`common/`）到处直接用 `console.error`，
 * 其中包括最有诊断价值的几类——工具执行失败、CDP 断连、未捕获异常。
 * 在此之前这些只出现在 `stdout.log` 里，不带级别、不在结构化日志中，
 * 而 `stdout.log` 又依赖 cmd 重定向（前台手工启动时压根不存在）。
 *
 * `app.ts` 已把 `console.log/info/warn` 全部改写到 `console.error`（stdio 下 stdout 被
 * JSON-RPC 独占），所以这里只需包装 `console.error` 一处即可覆盖全部输出。
 */
export function installConsoleCapture(): void {
  console.error = (...args: unknown[]): void => {
    const text = args.map(formatConsoleArg).join(' ');
    write(SERVER_LOG, `${ts()} [LOG] ${text}`);
    rawConsoleError(...args);
  };
}

export type AccessRecord = {
  method: string;
  /** JSON-RPC method（如 initialize / tools/call），非 JSON-RPC 请求为 undefined */
  rpcMethod?: string;
  /** `tools/call` 时的具体工具名——只看 rpcMethod 分不出是 pool_list 还是 boss_greet */
  toolName?: string;
  sessionId?: string;
  /** 对端地址；经 Nginx 时取 X-Forwarded-For，用于区分本机探测与远程客户端 */
  ip?: string;
  status: number;
  /**
   * 处理耗时：从收到请求到 `transport.handleRequest` 返回。
   * 这才是「服务端是否慢」的度量。
   */
  handlerMs?: number;
  /**
   * 响应流存活时长：从收到请求到 HTTP 响应真正结束（`finish` / `close`）。
   *
   * SSE 模式下这个值**远大于** `handlerMs` 是正常的：应答写完后 SDK 调 `res.end()`，
   * 若对端已静默消失，终止 chunk 刷不出去，内核重传退避可以让它挂十几分钟。
   * 那种情况下 `handlerMs` 很小而 `streamMs` 极大——**这个组合表示对端死了，不是服务端卡了**。
   */
  streamMs: number;
};

/**
 * 逐请求一行。
 *
 * 为什么要把 handler 与 stream 分开记：早期只记一个 `duration`（等价于这里的 `streamMs`），
 * 结果把「对端消失导致响应流挂住」误读成「服务端处理阻塞」，排查绕了一大圈。
 * 两个字段分开后：
 *   handler 大            → 服务端真的慢，查业务与队列
 *   handler 小 stream 大  → 对端已消失，属正常的 TCP 收尾，服务本身健康
 */
export function logAccess(rec: AccessRecord): void {
  write(
    ACCESS_LOG,
    [
      ts(),
      rec.method,
      rec.rpcMethod ?? '-',
      rec.toolName ? `tool=${rec.toolName}` : 'tool=-',
      `ip=${rec.ip ?? '-'}`,
      `session=${rec.sessionId ?? '-'}`,
      `status=${rec.status}`,
      `handler=${rec.handlerMs === undefined ? '-' : `${rec.handlerMs}ms`}`,
      `stream=${rec.streamMs}ms`,
    ].join(' '),
  );
}

export type AuditRecord = {
  toolName: string;
  /** 是否属于消耗平台配额的工具（打招呼次数 / 每日简历查看次数） */
  consumesQuota: boolean;
  /** 入参；已在调用方做长度截断，避免把简历正文之类的大字段写进日志 */
  args: string;
  outcome: 'ok' | 'error';
  /** 总时长：从收到请求到返回结果，= queueMs + execMs */
  durationMs: number;
  /** 串行队列里的等待时长 */
  queueMs: number;
  /** 出队后真正执行的时长；与单次调用看门狗（BOSS_MCP_TOOL_TIMEOUT_MS）对应的是这个值 */
  execMs: number;
  /** 结果摘要（成功时取首行，失败时取错误消息），同样已截断 */
  summary: string;
};

/**
 * 采样内存，附在每条审计后面。
 *
 * 为什么值得记：远端机器只有 5GB，而这个服务会临时把视口拉到 5000px 给长简历整框截图，
 * 单张位图就能到几十 MB。现场出现过 Chrome 连续约 55 分钟无法处理 CDP 命令后自行恢复
 * ——「自行恢复」这个形态最像内存压力/换页，而不是死锁，但当时没有任何内存数据可查，
 * 只能停在猜测。每条审计一个采样，成本可忽略，下次同样的故障就能直接定性。
 *
 * 注意 `os.freemem()` 是**整机**空闲内存（含 Chrome 的占用），`rss` 只是本 node 进程；
 * 两个一起看才能区分「是我们涨上去了」还是「整机被别人吃满了」。
 */
function memorySample(): string {
  const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}MB`;
  return `rss=${mb(process.memoryUsage().rss)} free=${mb(freemem())}/${mb(totalmem())}`;
}

/**
 * 工具调用审计。
 *
 * 单独一个文件而不是混进 access log：这个服务花掉的是**不可逆且计量**的东西——
 * 打招呼次数、每日在线简历查看次数。事后需要能回答「今天谁在什么时候对谁打了招呼、
 * 花了多少额度」，这条线索不能和几千行 HTTP 请求混在一起。
 *
 * `quota=yes` 的行就是花掉真实额度的动作，排查配额异常消耗时直接筛这一个字段。
 *
 * 时长记三个值（`duration` = `queue` + `exec`）：只记总时长时，「排在前面的调用超时 180s」
 * 会被读成「本次调用自己跑了 364s」，从而误判单次调用看门狗失效。看门狗管的是 `exec`。
 */
export function logAudit(rec: AuditRecord): void {
  write(
    AUDIT_LOG,
    [
      ts(),
      `tool=${rec.toolName}`,
      `quota=${rec.consumesQuota ? 'yes' : 'no'}`,
      `outcome=${rec.outcome}`,
      `duration=${rec.durationMs}ms`,
      `queue=${rec.queueMs}ms`,
      `exec=${rec.execMs}ms`,
      memorySample(),
      `args=${rec.args}`,
      `result=${rec.summary}`,
    ].join(' '),
  );
}
