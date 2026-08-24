/**
 * HTTP 传输下的落盘日志。
 *
 * 为什么需要：stdio 入口的日志走 stderr，由 MCP 客户端接管、随手可见。HTTP 入口是后台常驻进程，
 * stderr 往往没人盯着，而假死这类问题**只能靠事后翻日志定位**（哪一步没打出下一条、请求耗时多少）。
 *
 * 两个文件分工：
 * - `mcp-server.log`  运行事件（会话建立/回收、启动横幅、异常）
 * - `mcp-access.log`  逐请求一行（方法、状态码、耗时、session id）
 *
 * 写入用同步 append：日志量很小（每请求一行），而一旦改成异步缓冲，
 * 进程假死或被 taskkill 时最关键的那几行恰好会丢——那正是要看的内容。
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAppDataLayout, LOGS_DIR } from '../config.js';

const SERVER_LOG = join(LOGS_DIR, 'mcp-server.log');
const ACCESS_LOG = join(LOGS_DIR, 'mcp-access.log');

function ts(): string {
  return new Date().toISOString();
}

function write(file: string, line: string): void {
  try {
    ensureAppDataLayout();
    appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去不该影响服务本身 */
  }
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

/** 运行事件：同时写 stderr（便于前台启动时观察）与 mcp-server.log。 */
export function logServer(level: LogLevel, message: string): void {
  const line = `${ts()} [${level}] ${message}`;
  console.error(`[boss-mcp] ${message}`);
  write(SERVER_LOG, line);
}

export type AccessRecord = {
  method: string;
  /** JSON-RPC method（如 initialize / tools/call），非 JSON-RPC 请求为 undefined */
  rpcMethod?: string;
  sessionId?: string;
  /** 对端地址；经 Nginx 时取 X-Forwarded-For，用于区分本机测试与远程客户端 */
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
   * SSE 模式下这个值**远大于** `handlerMs` 是正常的:应答写完后 SDK 调 `res.end()`，
   * 若对端已静默消失，终止 chunk 刷不出去，内核重传退避可以让它挂十几分钟。
   * 那种情况下 `handlerMs` 很小而 `streamMs` 极大——**这个组合表示对端死了，不是服务端卡了**。
   */
  streamMs: number;
};

/**
 * 逐请求一行。
 *
 * 为什么要把 handler 与 stream 分开记:早期只记一个 `duration`（等价于这里的 `streamMs`），
 * 结果把「对端消失导致响应流挂住」误读成「服务端处理阻塞」，排查绕了一大圈。
 * 两个字段分开后:
 *   handler 大        → 服务端真的慢，查业务与队列
 *   handler 小 stream 大 → 对端已消失，属正常的 TCP 收尾，服务本身健康
 */
export function logAccess(rec: AccessRecord): void {
  write(
    ACCESS_LOG,
    [
      ts(),
      rec.method,
      rec.rpcMethod ?? '-',
      `ip=${rec.ip ?? '-'}`,
      `session=${rec.sessionId ?? '-'}`,
      `status=${rec.status}`,
      `handler=${rec.handlerMs === undefined ? '-' : `${rec.handlerMs}ms`}`,
      `stream=${rec.streamMs}ms`,
    ].join(' '),
  );
}
