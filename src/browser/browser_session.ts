import type { ChildProcess } from 'node:child_process';
import type { Browser, Page, Target } from 'puppeteer-core';
import { clearSpawnedChromeProcessRef, connectBrowser } from './cdp_browser.js';
import {
  attachPageForTarget,
  installBossBrowserPageGuards,
  installBossPageGuards,
} from '../common/boss_page_guards.js';

/**
 * 读一个 target 的 URL。
 *
 * 这里用 `Target` 而不是 `Page`，是因为 `browser.pages()` 为了给出 `Page` 会把**每个**标签
 * attach 并初始化（内部发 `Page.enable` / `Runtime.enable` / `Network.enable`），
 * 只要有一个标签的渲染进程僵死，这一句就挂到 protocolTimeout（本仓库 60s）——
 * 而下面这几个函数其实只需要 URL 就能做决策。`targets()` 与 `target.url()` 都不发 CDP 命令。
 */
function targetUrl(t: Target): string {
  try {
    return t.url();
  } catch {
    return '';
  }
}

function pageTargets(b: Browser): Target[] {
  return b.targets().filter((t) => t.type() === 'page');
}
let browserRef: Browser | null = null;
let pageRef: Page | null = null;
let connectPromise: Promise<void> | null = null;

function attachDisconnectedHandler(b: Browser): void {
  b.once('disconnected', () => {
    if (browserRef === b) {
      browserRef = null;
      pageRef = null;
      console.error(
        '[boss-cli] 与浏览器断开连接（窗口关闭或进程退出）；下次使用工具时会自动重连。',
      );
    }
  });
}

/**
 * 选一个「主」标签：避免始终把 `pages()[0]` 当主页——用户常在第二个及以后的 Boss 标签上操作，
 * 而第一个是 `about:blank` 或残留空页时，错误地读到 blank 会让登录/页面检查类操作误判。
 */
async function pickOrCreatePage(b: Browser): Promise<Page> {
  const targets = pageTargets(b);
  if (targets.length === 0) {
    return b.newPage();
  }

  const zhipin = targets.find((t) => {
    const u = targetUrl(t);
    return u.length > 0 && u !== 'about:blank' && u.includes('zhipin.com');
  });
  const nonBlank = targets.find((t) => {
    const u = targetUrl(t);
    return u.length > 0 && u !== 'about:blank';
  });

  // 先按 URL 选定，再只对选中的那一个 attach。选中的标签若僵死，attach 会在 15s 内
  // 带着页面 URL 报错——这正是应该发生的：工作页僵死时工具必须失败。
  const chosen = zhipin ?? nonBlank ?? targets[0]!;
  const page = await attachPageForTarget(chosen);
  if (page) {
    return page;
  }
  // attach 成功但页面已关闭（选定与 attach 之间标签被关掉）。这不是降级，是重新选一次。
  return b.newPage();
}

async function closeRedundantBlankPages(b: Browser, keep: Page | null): Promise<void> {
  const targets = pageTargets(b);
  if (targets.length <= 1) return;

  const blanks = targets.filter((t) => {
    const u = targetUrl(t);
    return u === '' || u === 'about:blank';
  });
  if (blanks.length === 0) return;

  const hasNonBlank = targets.some((t) => {
    const u = targetUrl(t);
    return u !== '' && u !== 'about:blank';
  });
  const keepTarget = (() => {
    try {
      return keep ? keep.target() : null;
    } catch {
      return null;
    }
  })();

  // 只对**准备关掉的空白页**做 attach。空白页不跑 Boss 的页面脚本，不会被页面 JS 堵死；
  // 若连它都 attach 不上，说明僵死的是浏览器本身而不是某个渲染进程，这条日志值得留下。
  for (const t of blanks) {
    if (keepTarget && t === keepTarget) continue;
    if (!hasNonBlank && t === blanks[0]) continue;
    try {
      const page = await attachPageForTarget(t);
      if (!page) continue;
      await page.close({ runBeforeUnload: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[boss-cli] 清理空白标签失败（已跳过）：${targetUrl(t) || '(about:blank)'} —— ${msg}`);
    }
  }
}

function isSessionHealthy(): boolean {
  return !!(browserRef?.connected && pageRef && !pageRef.isClosed());
}

async function establishSession(): Promise<void> {
  const prev = browserRef;
  if (prev) {
    try {
      prev.removeAllListeners('disconnected');
      await prev.close();
    } catch {
      /* 已断开时忽略 */
    }
    browserRef = null;
    pageRef = null;
  }

  const b = await connectBrowser();
  browserRef = b;
  attachDisconnectedHandler(b);
  await installBossBrowserPageGuards(b);
  pageRef = await pickOrCreatePage(b);
  await installBossPageGuards(pageRef);
  await closeRedundantBlankPages(b, pageRef);
}

/**
 * 在 {@link ensureBrowserSession} 之后返回当前已连接的 Browser；
 * 用于工具内单次获取句柄，避免与异步 ensure 不同步的 `getBrowser()` 竞态。
 */
export async function ensureAndGetBrowser(): Promise<Browser | null> {
  await ensureBrowserSession();
  return getBrowserRef();
}

export async function ensureBrowserSession(): Promise<void> {
  if (browserRef?.connected) {
    await installBossBrowserPageGuards(browserRef);
    if (pageRef && !pageRef.isClosed()) {
      try {
        const u = pageRef.url();
        if (u === 'about:blank' || u === '') {
          const preferred = await pickOrCreatePage(browserRef);
          if (preferred !== pageRef && !(preferred.url() === 'about:blank')) {
            pageRef = preferred;
          }
        }
        await closeRedundantBlankPages(browserRef, pageRef);
      } catch (e) {
        // 这一段是整理工作（当前页是空白时换一个、关掉多余空白页），失败不该挡住工具：
        // 真正要用的 pageRef 紧接着会单独装一次防护，那一次失败才该让工具失败。
        // 但原因必须留下——这里能失败的原因之一正是 attach 卡在僵死标签上 15s。
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[boss-cli] 会话页整理失败（不影响本次调用）：${msg}`);
      }
      await installBossPageGuards(pageRef);
      return;
    }
    pageRef = await pickOrCreatePage(browserRef);
    await installBossPageGuards(pageRef);
    await closeRedundantBlankPages(browserRef, pageRef);
    return;
  }

  if (connectPromise) {
    await connectPromise;
    return;
  }

  connectPromise = (async () => {
    if (isSessionHealthy()) return;
    await establishSession();
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export function getBrowserRef(): Browser | null {
  return browserRef?.connected ? browserRef : null;
}

export function getPageRef(): Page | null {
  if (!pageRef || pageRef.isClosed()) return null;
  if (!browserRef?.connected) return null;
  return pageRef;
}

/**
 * 将当前会话的主操作页设为 `page`（须属于已连接的 `browserRef`）。
 * 供“导航/打开页面”类流程在新建或选中标签后同步，便于其它工具通过 `getPageRef` 复用。
 */
export function setSessionPage(page: Page): void {
  if (!browserRef?.connected) return;
  try {
    if (page.browser() !== browserRef) return;
  } catch {
    return;
  }
  if (page.isClosed()) return;
  pageRef = page;
}

/** 进程退出时断开 CDP，避免残留子进程 */
export async function disconnectBrowserSession(): Promise<void> {
  const b = browserRef;
  if (!b) return;
  try {
    b.removeAllListeners('disconnected');
    await b.close();
  } catch {
    /* ignore */
  }
  browserRef = null;
  pageRef = null;
  clearSpawnedChromeProcessRef();
}

function unrefBrowserChildProcess(proc: ChildProcess | null | undefined): void {
  if (!proc) return;
  try {
    proc.unref();
  } catch {
    /* ignore */
  }
}

/**
 * 仅断开与浏览器的 CDP 连接，但不主动关闭浏览器进程。
 * 用于 `boss login` 这类“需要用户继续在浏览器里操作”的场景：
 * CLI 可以立刻退出，而浏览器窗口仍保留给用户完成登录。
 *
 * 必须在 disconnect 后对 Chrome 子进程 `unref`，否则 Node 会因子进程仍存活而无法退出。
 *
 * 注意：**绝不调用 `browser.close()`**——历史上在 disconnect 抛错时误走 close 会导致退出 CLI 时浏览器被关掉。
 */
export async function detachBrowserSession(): Promise<void> {
  const b = browserRef;
  if (!b) return;
  let proc: ChildProcess | null | undefined;
  try {
    proc = typeof b.process === 'function' ? b.process() : undefined;
  } catch {
    proc = undefined;
  }
  try {
    b.removeAllListeners('disconnected');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyB = b as any;
    if (typeof anyB.disconnect === 'function') {
      await Promise.resolve(anyB.disconnect());
    }
  } catch {
    /* 仍不 close；仅断开失败时依赖下方 unref 与进程退出行为 */
  }
  unrefBrowserChildProcess(proc ?? null);
  clearSpawnedChromeProcessRef();
  browserRef = null;
  pageRef = null;
}
