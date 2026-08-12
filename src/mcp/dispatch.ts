/**
 * 单次 tool 调用的执行外壳：取消检查 + 心跳保活 + 看门狗超时。
 *
 * 拆成独立模块的原因：这三件事是 MCP 长驻进程能不能用的关键，必须能在不启动浏览器的前提下
 * 单独验证（`server.ts` 里全是真实业务依赖，测不动）。
 *
 * 三个行为：
 * 1. **取消**：客户端超时或主动取消后，排队中的调用绝不能再执行——否则客户端早已放弃，
 *    真实配额（打招呼 / 简历查看 / 深搜匹配）还在被消耗。
 * 2. **心跳**：客户端普遍有 60s 请求超时，长任务期间周期性推 progress，避免被误判为卡死。
 * 3. **看门狗**：超过上限就放弃等待、重置浏览器会话并放行队列。挂死的操作在会话被 detach 后
 *    下一次 CDP 调用即失败并自行解开，比让整个 server 永久卡住好得多。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** 传给每个工具实现的运行期上下文 */
export type ToolContext = {
  /** 客户端取消（含客户端超时后自动取消）时被 abort，长任务据此提前收手 */
  signal: AbortSignal;
  /** 向客户端推一条 progress，用于长任务保活与可观测 */
  tick: (message?: string) => void;
};

export type RunToolCallOptions = {
  toolName: string;
  signal: AbortSignal;
  tick: (message?: string) => void;
  /** 看门狗上限；<= 0 表示关闭看门狗 */
  timeoutMs: number;
  /** 心跳间隔；<= 0 表示不发心跳 */
  heartbeatMs: number;
  /** 看门狗触发时用于重置浏览器会话（正常是 detachBrowserSession） */
  resetSession: () => Promise<void>;
  /** 可选：返回当前队列中（含自己）的调用数，仅用于超时文案 */
  pendingCount?: () => number;
  /** 可选：把已知的底层错误文案改写成可操作指引 */
  mapErrorMessage?: (message: string) => string;
  /** 真正的业务执行体，返回结构化纯文本 */
  execute: (ctx: ToolContext) => Promise<string>;
};

export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function runToolCall(options: RunToolCallOptions): Promise<CallToolResult> {
  const { toolName, signal, tick, timeoutMs, heartbeatMs, resetSession, execute } = options;

  // 1) 取消检查：必须在任何副作用之前
  if (signal.aborted) {
    console.error(`[boss-mcp] ${toolName} 在排队期间被客户端取消，跳过执行（未消耗任何配额）`);
    return textResult(`调用已被客户端取消，${toolName} 未执行。`, true);
  }

  // 2) 心跳
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      tick(`${toolName} 执行中…已 ${seconds}s`);
    }, heartbeatMs);
    heartbeat.unref?.();
  }
  tick(`${toolName} 已开始`);

  // 3) 看门狗
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watchdogPromise =
    timeoutMs > 0
      ? new Promise<CallToolResult>((resolve) => {
          watchdog = setTimeout(() => {
            console.error(
              `[boss-mcp] ${toolName} 超过 ${timeoutMs}ms 未完成，重置浏览器会话并放行队列`,
            );
            void resetSession()
              .catch(() => {})
              .finally(() => {
                const queued = options.pendingCount?.() ?? 0;
                resolve(
                  textResult(
                    [
                      `❌ ${toolName} 执行超过 ${Math.round(timeoutMs / 1000)}s 未返回，已中止等待。`,
                      '已断开并重置浏览器 CDP 会话（浏览器窗口保留），后续调用会自动重连。',
                      queued > 1 ? `队列中还有 ${queued - 1} 个待执行调用。` : '',
                      '若该操作本身确实耗时较长，可用环境变量 BOSS_MCP_TOOL_TIMEOUT_MS 调大上限。',
                    ]
                      .filter(Boolean)
                      .join('\n'),
                    true,
                  ),
                );
              });
          }, timeoutMs);
        })
      : null;

  // 业务异常统一转成 isError 文本：Agent 需要读到原因（未登录 / 不在目标页）才能自我纠正
  const guarded = async (): Promise<CallToolResult> => {
    try {
      const text = await execute({ signal, tick });
      return textResult(text.trimEnd() || '(空结果)');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.error(`[boss-mcp] ${toolName} 执行失败: ${raw}`);
      return textResult(options.mapErrorMessage?.(raw) ?? raw, true);
    }
  };

  try {
    return watchdogPromise ? await Promise.race([guarded(), watchdogPromise]) : await guarded();
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
    }
  }
}
