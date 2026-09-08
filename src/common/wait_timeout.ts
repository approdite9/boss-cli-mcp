/**
 * 给 puppeteer 的等待类超时补上下文。
 *
 * 为什么需要它：`waitForSelector` / `waitForFunction` 超时抛出的原话是
 * `Waiting failed: 18000ms exceeded`——既不说等的是哪个选择器、也不说页面当时在哪。
 * 审计日志里这条签名出现了 43 次，是当前频次最高的活跃错误，而且**同一句话对应两种
 * 完全不同的故障**：推荐页那两个等待恰好都设成 18000ms，一个是「主文档里连推荐 iframe
 * 都没有」，一个是「iframe 有了但列表容器没挂载」，处置方式不同，日志里却分辨不出来。
 *
 * 这里只做一件事：把超时换成一句带现场的错误。不改重试、不改时长、不吞任何错误——
 * 非超时的异常原样抛出，因为那些错误本身已经指得清（如 `frame got detached`）。
 */

/**
 * 是否是等待类超时。
 *
 * 判据与 `boss_session_page.ts` 里那处保持一致：puppeteer 在不同版本里既可能抛
 * `TimeoutError`，也可能抛普通 Error 而把 `Waiting failed` 写在 message 里。
 */
export function isWaitTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'TimeoutError' || /timeout|waiting failed/i.test(e.message);
}

/**
 * 超时则换成带现场的错误抛出；非超时原样抛出。
 *
 * `context` 由调用方给出，必须包含：等的是什么、等了多久、页面当前在哪。
 * 原始信息附在末尾，便于把日志和 puppeteer 版本行为对上。
 */
export function rethrowWaitTimeout(e: unknown, context: string): never {
  if (!isWaitTimeoutError(e)) {
    throw e;
  }
  const raw = e instanceof Error ? e.message : String(e);
  throw new Error(`${context}（原始信息：${raw}）`);
}
