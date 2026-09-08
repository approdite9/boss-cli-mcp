/**
 * 单次工具调用的附加指标，供审计日志落盘。
 *
 * 为什么需要它：批量工具（`pool_greet_all` / `pool_batch_resume`）把单人失败收进返回文本的
 * 摘要里，而审计行只反映「批量流程本身跑完了」，于是 `outcome` 恒为 `ok`。
 * 实测审计日志里 322 次批量调用中有 101 次摘要写着「失败 N（N≥1）」，
 * 而 `outcome=error` 的是 **0 次**——按 `outcome` 统计打招呼失败率会得到 0，
 * 打招呼真实失败率因此不可查。这正是「全链路 outcome=ok 但结果是坏的」那个形态，
 * 视口残帧那次已经吃过一遍。
 *
 * 为什么用模块级插槽而不是改工具返回类型：工具返回的是给人看的字符串，
 * 塞结构化字段会污染输出；从文本里正则解析「失败 N」则是把日志格式当 API，更脆。
 * 而 `app.ts` 里工具执行是 `serialize()` 串行的、`logAudit` 紧跟其后，
 * 所以「调用开始清零 → 执行中写入 → 落审计时取走」这条路径不存在并发歧义。
 * `take` 语义保证读完即清，不会把上一次调用的数字带到下一次。
 */

let partialFailures = 0;

/** 每次工具调用开始时清零。必须调用，否则上一次的数字会被带过来。 */
export function resetToolMetrics(): void {
  partialFailures = 0;
}

/** 由批量执行器在返回前写入：本次有多少个子项失败了。 */
export function reportPartialFailures(count: number): void {
  partialFailures = count > 0 ? count : 0;
}

/** 落审计时取走并清零。 */
export function takePartialFailures(): number {
  const n = partialFailures;
  partialFailures = 0;
  return n;
}
