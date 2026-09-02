import type { Page } from 'puppeteer-core';

export type EnsurePageOptions = {
  name: string;
  targetUrl: string;
  matches: (url: string) => boolean;
  timeoutMs?: number;
};

/**
 * 探活超时。只是求值一个常量表达式，活着的页面在毫秒级返回；
 * 给到秒级是为了容忍主线程正忙（大列表渲染、OCR 回来时的批量 DOM 更新）。
 */
const PAGE_LIVENESS_PROBE_TIMEOUT_MS = 3_000;

/**
 * 页面是否还有**活的执行上下文**。
 *
 * 为什么不能只看 URL：标签页的渲染进程被回收后（内存紧张时 Chrome 会回收后台标签），
 * `page.url()` 仍然返回原来的地址、CDP `/json/list` 里 target 也还在列着，
 * 但页面里已经没有能跑 JS 的上下文了。现场特征：
 *   - renderer 工作集从 ~190MB 掉到 2MB，CPU 归零
 *   - `Runtime.evaluate('1+1')` **永不返回**（不是抛错，是不 settle）
 *   - 随后任何 `waitForSelector` / `waitForFunction` 会挂到超时或抛 `frame got detached`
 *
 * 所以探活必须带超时：死页面上的 `evaluate` 不会 reject，只会永远悬着。
 * 这里把「超时」「抛错」「页面已关闭」统一归为「不可用」——对调用方来说这三者的
 * 处置完全相同（重新加载），区分它们不会带来任何不同的动作。
 */
export async function isPageAlive(page: Page): Promise<boolean> {
  if (page.isClosed()) {
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const probe = page.evaluate('1');
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('page liveness probe timeout')), PAGE_LIVENESS_PROBE_TIMEOUT_MS);
    });
    await Promise.race([probe, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function ensurePage(page: Page, opts: EnsurePageOptions): Promise<void> {
  const startUrl = page.url();

  // 判活条件是「URL 对」**且**「页面还能执行 JS」。只判 URL 会漏掉渲染进程被回收的情况：
  // 那时 URL 依旧匹配，于是这里不导航，故障被推迟到后面的 waitForSelector 才炸，
  // 报出来的是 `frame got detached` 这种看不出根因的信息，而且工具自己修不好自己。
  const needsReload = !opts.matches(startUrl) || !(await isPageAlive(page));
  if (needsReload) {
    if (opts.matches(startUrl)) {
      console.error(
        `[boss-cli] ${opts.name} 的 URL 仍匹配但页面已无可执行上下文（渲染进程被回收），重新加载：${opts.targetUrl}`,
      );
    }
    await page.goto(opts.targetUrl, {
      waitUntil: 'load',
      timeout: opts.timeoutMs ?? 60_000,
    });
  }

  const currentUrl = page.url();
  if (!opts.matches(currentUrl)) {
    throw new Error(
      `进入${opts.name}失败。起始页面：${startUrl || 'unknown'}；当前页面：${currentUrl || 'unknown'}；目标页面：${opts.targetUrl}`,
    );
  }
}
