#!/usr/bin/env node
/**
 * boss-mcp 的 **stdio** 传输入口（MCP 客户端本机拉起时的默认形态）。
 *
 * stdio 是单会话协议：一个进程对应一个客户端，客户端关闭 stdin 即视为断开、进程随之退出。
 * 因此这里只 {@link buildServer} 一次，也不需要会话表——那是 HTTP 入口的事，见 `http_server.ts`。
 *
 * 注意：stdout 被 JSON-RPC 独占，任何日志必须走 stderr（`app.ts` 已把 console.log/info/warn 改写到 stderr）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  buildServer,
  installProcessSafetyNets,
  logStartupBanner,
  releaseSharedResources,
} from './app.js';

installProcessSafetyNets();

let shuttingDown = false;

/**
 * stdio 下进程与会话一一对应，所以传输关闭就等于该退出了。
 * 退出前 detach CDP 但**保留浏览器窗口**（`releaseSharedResources` 内已带超时保护）。
 */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error(`[boss-mcp] 正在退出（${reason}），断开 CDP 但保留浏览器窗口…`);
  await releaseSharedResources();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const server = buildServer();
// stdio 传输下客户端关闭 stdin 即视为断开
server.onclose = () => void shutdown('transport closed');

const transport = new StdioServerTransport();
await server.connect(transport);

await logStartupBanner('stdio');
