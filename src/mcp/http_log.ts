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
  status: number;
  durationMs: number;
};

/**
 * 逐请求一行。`durationMs` 是定位假死的关键字段——
 * 历史上那次 6 分钟卡死就是靠 `initialize ... 347656ms` 这一行才定位到 `close()` 上的。
 */
export function logAccess(rec: AccessRecord): void {
  write(
    ACCESS_LOG,
    [
      ts(),
      rec.method,
      rec.rpcMethod ?? '-',
      `session=${rec.sessionId ?? '-'}`,
      `status=${rec.status}`,
      `duration=${rec.durationMs}ms`,
    ].join(' '),
  );
}
