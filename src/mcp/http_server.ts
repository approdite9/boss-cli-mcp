#!/usr/bin/env node
/**
 * boss-mcp 的 **StreamableHTTP** 传输入口（远程 Agent 通过 Nginx 反代访问时的形态）。
 *
 * ## 与 stdio 入口的核心差异：多会话
 *
 * stdio 是一进程一客户端；HTTP 下客户端会随时断开重连，每次重连都是一次新的 `initialize`。
 * 而 SDK 的 `Server` 内部记录初始化状态，**一个实例只能 initialize 一次**，复用它会被拒绝
 * （"Server already initialized"）。所以这里按 `Mcp-Session-Id` 维护会话表，每次 initialize
 * 建一套全新的 Server+Transport，互不影响。
 *
 * ## 为什么不能「重建单例」
 *
 * 历史实现是全局单例 `currentTransport` + 每次 initialize 调 `rebuildSession()`（内部
 * `await transport.close()`）。这个做法造成过 6-14 分钟的整体假死，原因有两层：
 *
 * 1. **拆解操作被放在请求关键路径上。** `transport.close()` 要收掉活跃的 SSE 流，走的是
 *    `res.end()`；当对端（公网客户端）静默消失、没发 FIN 时，终止 chunk 刷不出去，
 *    内核开始重传退避，`close()` 就一直等。实测解除时机由 Nginx 的 `proxy_read_timeout`
 *    决定（300s），**不是应用能控制的量级**。期间 HTTP handler 被 await 卡住，所有请求排队超时。
 * 2. **全局单例 + 无互斥 = 竞态。** 两个 initialize 并发时，B 会关掉 A 刚建好、正在服务 A
 *    自己的 transport，A 的响应永远不被 `end()`，挂到 TCP 超时。
 *
 * 因此本实现的两条硬规则：
 * - **会话表按 id 隔离**，新会话的建立永不触碰任何已有会话；
 * - **任何 `close()` 都不在请求路径上 await**，一律先从表里摘除、再后台异步关闭。
 *   哪怕某个 `close()` 真卡十几分钟，也没有任何请求在等它。
 *
 * ## 不随会话数放宽的约束
 *
 * 只有协议状态（Server / Transport）按会话隔离。串行队列、调用节流、浏览器会话与
 * `session.lock` 都是**进程级单份**——本机只有一只 Chrome。详见 `app.ts` 的 `buildServer` 注释。
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  buildServer,
  installProcessSafetyNets,
  logStartupBanner,
  releaseSharedResources,
} from './app.js';
import { installConsoleCapture, logAccess, logServer } from './mcp_log.js';

// 必须在任何输出之前：共享层到处直接用 console.error（工具失败、CDP 断连、未捕获异常），
// 这些是最有诊断价值的行，而隐藏窗口运行时没人看 stderr。装上后它们一并落盘。
installConsoleCapture();

// ── 配置 ──────────────────────────────────────────────────────

const PORT = (() => {
  const raw = process.env.BOSS_MCP_PORT?.trim();
  if (!raw) return 3101;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`❌ BOSS_MCP_PORT 非法: ${raw}（需为 1-65535 的整数）`);
  }
  return n;
})();

/**
 * 默认只绑回环。
 *
 * 这个进程**自身不做任何鉴权**——Token 校验、TLS、限流全在 Nginx 上。
 * 绑到 0.0.0.0 等于把一个无鉴权的 MCP 端点直接暴露到网络上，
 * 任何人都能调 `boss_greet` / `pool_greet_all` 消耗真实配额。
 * 允许覆盖是为了容器化等场景，但非回环地址会在启动时打出明确告警。
 */
const HOST = process.env.BOSS_MCP_HOST?.trim() || '127.0.0.1';

const MCP_PATH = '/mcp';

/**
 * 健康检查路径（仅回环，**不要**在 Nginx 里代理出去）。
 *
 * 为什么需要它：本服务的两类历史故障——控制台快速编辑挂起进程、以及请求路径上
 * `await close()` 阻塞——期间进程都没有退出、端口都还在 LISTENING。也就是说
 * 「查 PID」「查端口」这类检查**一个都抓不到**，看门狗必须发一次真实请求。
 *
 * 刻意不走 `/mcp`：`initialize` 会在会话表里建一条记录，看门狗每分钟探一次会不断
 * 挤占 {@link MAX_SESSIONS}，把真实客户端的会话按 LRU 淘汰掉。这里零协议副作用，
 * 也不碰浏览器、不消耗任何配额。
 */
const HEALTH_PATH = '/health';

const startedAtMs = Date.now();

/** 请求体上限：MCP 请求都很小，给足余量即可，避免无上限读取被打爆内存。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * 会话空闲回收阈值。
 *
 * 这只是**兜底**，不是主回收路径：客户端正常断开会触发 `transport.onclose` 立即摘除。
 * 它存在的唯一目的是防止「静默消失、连 FIN 都没发」的会话让表无限增长。
 *
 * 因此阈值要给得宽。交互式 MCP 客户端在人思考、读结果时可以空闲很久，而空闲期间
 * 它只是挂着 GET 通知流、不发新请求。摘掉这种会话会让客户端下一次调用拿到 404，
 * 表现为「MCP 未连接」——而它其实一直连着。会话对象本身很小，留久一点没有代价。
 */
const SESSION_IDLE_MS = (() => {
  const fallback = 4 * 60 * 60_000;
  const raw = process.env.BOSS_MCP_SESSION_IDLE_MS?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 60_000) return fallback;
  return n;
})();

const REAPER_INTERVAL_MS = 60_000;

/**
 * 会话数硬上限，超出时按 `lastSeen` 摘掉最旧的。
 *
 * 空闲会话本身很便宜（两个小对象，不持有 socket），所以这个上限不是为了省内存，
 * 而是给「客户端在网络抖动时反复重连、每次重连一次 initialize」这种情况一个明确上界——
 * 否则 4 小时的保留窗口配上高频重连，表可以攒到几百条，回收巡检一次性摘除时
 * 会做同样多次同步日志写入。
 *
 * 刻意用 LRU 而不是「新会话到来就清掉旧会话」：后者正是被移除的 `rebuildSession()` 的错误——
 * 会关掉正在服务其它请求的 transport。
 */
const MAX_SESSIONS = 64;

/**
 * TCP keepalive 间隔。
 *
 * 这是对付「对端静默消失」的**正确工具**：它能区分「空闲但活着」和「已经死了」。
 * 单纯用 socket 空闲超时做不到这个区分——standalone GET SSE 流在没有通知要推时本来就是空闲的，
 * 按空闲杀会把正常连接一起杀掉。keepalive 探测失败才会让 socket 出错，
 * 从而解开任何挂在上面的写操作。
 */
const KEEPALIVE_MS = 30_000;

// ── 会话表 ────────────────────────────────────────────────────

type Session = {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** 最后一次收到该会话请求的时刻，供空闲回收判断 */
  lastSeen: number;
};

const sessions = new Map<string, Session>();

/**
 * 从表中摘除并**后台**关闭。
 *
 * 顺序是全部要点：`delete` 必须在 `close()` 之前，且 `close()` 绝不 await。
 * 这样即使 `close()` 因对端消失而卡在 TCP 重传上，也没有任何请求依赖它。
 */
function dropSession(sessionId: string, reason: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  logServer('INFO', `会话 ${sessionId} 已摘除（${reason}），剩余 ${sessions.size} 个；后台关闭中`);
  void s.transport.close().catch(() => {});
  void s.server.close().catch(() => {});
}

/** 超出上限时摘掉最久未活动的会话，保证表大小有确定上界。 */
function evictOverflowSessions(): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const byOldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [id] of byOldest.slice(0, sessions.size - MAX_SESSIONS)) {
    dropSession(id, `会话数超过上限 ${MAX_SESSIONS}，摘除最久未活动的`);
  }
}

/** 空闲回收：兜住静默消失、没触发 onclose 的会话。 */
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastSeen < SESSION_IDLE_MS) continue;
    dropSession(id, `空闲超过 ${Math.round(SESSION_IDLE_MS / 1000)}s`);
  }
}, REAPER_INTERVAL_MS);
reaper.unref();

// ── HTTP 工具 ─────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: unknown = null,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  // 必须显式声明 charset：错误消息是中文，缺 charset 时不少客户端按 latin1 解码成乱码，
  // 而这些消息正是排查时唯一的线索。
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const raw = req.headers['mcp-session-id'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = (v ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── 请求处理 ──────────────────────────────────────────────────

/** 新建一套 Server+Transport 并处理这次 initialize。不触碰任何已有会话。 */
async function handleInitialize(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, { server, transport, lastSeen: Date.now() });
      logServer('INFO', `新会话 ${sessionId} 就绪，当前共 ${sessions.size} 个`);
      evictOverflowSessions();
    },
  });

  /**
   * 客户端正常断开时摘除自己。
   *
   * 这里**绝不能 `process.exit`**：HTTP 下单个会话结束不代表进程该退出，
   * 否则第一个断开的客户端就会把整个服务干掉（stdio 入口才是「传输关闭即退出」）。
   */
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.has(id)) {
      dropSession(id, 'transport onclose');
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * 会话查不到时统一走这里：除了回 404，还要**留一条日志**。
 *
 * 没有这条日志时，「客户端拿着已回收的 session id 来调用」在服务端看起来和「请求没到」
 * 难以区分，只能靠时间戳去反推回收窗口。
 */
function rejectUnknownSession(res: ServerResponse, sessionId: string | undefined): void {
  logServer(
    'INFO',
    `拒绝未知会话 ${sessionId ?? '(无 Mcp-Session-Id)'}：已被回收或从未存在，客户端需重新 initialize` +
      `（当前会话数 ${sessions.size}）`,
  );
  sendJsonRpcError(res, 404, -32001, '未知或已过期的会话，请重新 initialize');
}

/** 每个请求一份的可变上下文，供 access log 回读处理过程中才知道的信息。 */
type RequestTrace = {
  rpcMethod?: string;
  /** `tools/call` 时的具体工具名——只有 rpcMethod 分不出是 pool_list 还是 boss_greet */
  toolName?: string;
  /** `handleMcpRequest` 返回时的耗时；与响应流存活时长分开记，见 mcp_log.ts 的说明 */
  handlerMs?: number;
};

/** 优先取 Nginx 透传的真实客户端地址，回落到直连的 socket 地址。 */
function clientIpOf(req: IncomingMessage): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const first = (raw ?? '').split(',')[0]?.trim();
  if (first) return first;
  return req.socket.remoteAddress ?? undefined;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  trace: RequestTrace,
): Promise<void> {
  // GET（打开 SSE 通知流）与 DELETE（显式结束会话）都不带 body
  if (req.method === 'GET' || req.method === 'DELETE') {
    const id = sessionIdOf(req);
    const s = id ? sessions.get(id) : undefined;
    if (!s) {
      rejectUnknownSession(res, id);
      return;
    }
    s.lastSeen = Date.now();
    try {
      await s.transport.handleRequest(req, res);
    } finally {
      // GET 通知流可能挂很久且期间不产生新请求。流结束时再刷一次时间戳，
      // 否则「挂着长连接但空闲」的活跃客户端会被空闲回收误判为已消失。
      s.lastSeen = Date.now();
    }
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST, DELETE' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method Not Allowed' } }));
    return;
  }

  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    sendJsonRpcError(res, 400, -32700, 'Parse error: 请求体不是合法 JSON');
    return;
  }

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const m = (body as { method?: unknown }).method;
    if (typeof m === 'string') trace.rpcMethod = m;
    const params = (body as { params?: unknown }).params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const n = (params as { name?: unknown }).name;
      if (typeof n === 'string') trace.toolName = n;
    }
  }

  if (isInitializeRequest(body)) {
    await handleInitialize(req, res, body);
    return;
  }

  const id = sessionIdOf(req);
  if (!id) {
    sendJsonRpcError(res, 400, -32000, '缺少 Mcp-Session-Id 请求头（非 initialize 请求必须携带）');
    return;
  }
  const s = sessions.get(id);
  if (!s) {
    rejectUnknownSession(res, id);
    return;
  }
  s.lastSeen = Date.now();
  await s.transport.handleRequest(req, res, body);
}

// ── HTTP server ───────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  const startedAt = Date.now();
  const trace: RequestTrace = {};

  // keepalive：让「静默消失的对端」在 OS 层被探测出来，而不是靠应用超时硬猜。
  req.socket.setKeepAlive(true, KEEPALIVE_MS);
  req.socket.setNoDelay(true);

  let logged = false;
  const logOnce = (): void => {
    if (logged) return;
    logged = true;
    logAccess({
      method: req.method ?? '-',
      rpcMethod: trace.rpcMethod,
      toolName: trace.toolName,
      sessionId: sessionIdOf(req),
      ip: clientIpOf(req),
      status: res.statusCode,
      handlerMs: trace.handlerMs,
      streamMs: Date.now() - startedAt,
    });
  };
  res.on('finish', logOnce);
  res.on('close', logOnce);

  const url = req.url ?? '';
  const path = url.split('?')[0];

  if (path === HEALTH_PATH) {
    // 能返回就说明事件循环没被卡住——这正是看门狗要判断的事。
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        status: 'ok',
        pid: process.pid,
        uptimeMs: Date.now() - startedAtMs,
        sessions: sessions.size,
      }),
    );
    return;
  }

  if (path !== MCP_PATH) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  void handleMcpRequest(req, res, trace)
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      logServer('ERROR', `请求处理失败：${message}`);
      sendJsonRpcError(res, 500, -32603, `Internal error: ${message}`);
    })
    .finally(() => {
      // 处理已结束；此后 streamMs 继续增长的部分全都是「等响应流真正关闭」，与服务端快慢无关。
      trace.handlerMs = Date.now() - startedAt;
    });
});

// ── 生命周期 ──────────────────────────────────────────────────

installProcessSafetyNets();

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logServer('INFO', `正在退出（${reason}），断开 CDP 但保留浏览器窗口…`);

  // 停止接受新连接；已有会话的 close 一律后台，绝不在退出路径上等 TCP。
  httpServer.close();
  for (const id of [...sessions.keys()]) {
    dropSession(id, 'server shutdown');
  }

  await releaseSharedResources();
  logServer('INFO', '已退出（StreamableHTTP）');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/**
 * 非正常退出也要留痕。`schtasks /end`、`taskkill`、以及「事件循环空了自然退出」
 * 都不会经过 {@link shutdown}，此前这类退出在应用日志里完全没有记录，
 * 只有 `run-mcp.cmd` 那句 "exited with code N"——而它不带时间以外的任何上下文。
 */
process.on('exit', (code) => {
  if (!shuttingDown) {
    logServer('WARN', `进程退出（code=${code}），未经过正常 shutdown 流程`);
  }
});

/**
 * 监听失败必须**硬失败并给出非零退出码**。
 *
 * `installProcessSafetyNets()` 的 `uncaughtException` 兜底是给「请求处理中的漏网异常」用的——
 * 长驻服务不该被一条 rejection 静默干掉。但它会连启动期的 listen 错误一起吞掉，后果很隐蔽：
 * 服务器没起来、事件循环空了，进程随即退出，而且**退出码是 0**。于是任务计划的「失败时重启」
 * 不触发，日志里只留下一句「exited with code 0」，看着像正常退出。
 *
 * 端口冲突属于配置/协调错误（通常是启动了第二个实例），和无头运行一样必须让进程起不来。
 */
httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logServer(
      'ERROR',
      `❌ 端口 ${HOST}:${PORT} 已被占用，拒绝启动。` +
        '通常是已经有一个 boss-mcp 实例在跑（两个实例会共用同一只 Chrome，' +
        '并通过跨进程文件锁互相等待，表现为工具调用 30 秒后报 "session is busy"）。' +
        `排查：netstat -ano | findstr ${PORT}`,
    );
  } else {
    logServer('ERROR', `❌ HTTP 服务监听失败（${err.code ?? 'unknown'}）：${err.message}`);
  }
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  logServer('INFO', `StreamableHTTP 监听 http://${HOST}:${PORT}${MCP_PATH}`);
  logServer('INFO', `健康检查 http://${HOST}:${PORT}${HEALTH_PATH}（仅回环，勿在 Nginx 暴露）`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    logServer(
      'WARN',
      `⚠️ 绑定地址 ${HOST} 不是回环地址。本进程自身不做任何鉴权（Token/TLS/限流都在 Nginx 上），` +
        '这等于把一个无鉴权的 MCP 端点暴露到网络上，任何人都能调用消耗配额的工具。请确认这是有意的。',
    );
  }
  logServer('INFO', `会话空闲回收阈值 ${Math.round(SESSION_IDLE_MS / 1000)}s，回收巡检 ${REAPER_INTERVAL_MS / 1000}s`);
});

await logStartupBanner('StreamableHTTP');
