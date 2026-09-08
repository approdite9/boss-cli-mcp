/**
 * Boss 直聘 URL 约定、登录态探测文案与 `Page` 上只读探测（不连 CDP、不启动浏览器）。
 */
import type { Page } from 'puppeteer-core';
import { PROBE_LOGIN_POLL_MS } from '../browser/human_delay.js';
import { sleepRandom } from '../browser/timing.js';

/** Boss 直聘首页 */
export const BOSS_ZHIPIN_HOME = 'https://www.zhipin.com/';

/** 默认落地页（杭州 SEO 首页）；CLI 等未配置环境变量时使用 */
export const BOSS_DEFAULT_LANDING_URL =
  'https://www.zhipin.com/hangzhou/?seoRefer=index';

/** 沟通页（登录成功后的典型落地页之一） */
export const BOSS_CHAT_INDEX_URL = 'https://www.zhipin.com/web/chat/index';

/** 尚未有可用的浏览器会话时的提示文本（供工具抛错复用）。 */
export function createWaitManualLoginRequiredText(action: string): string {
  return `浏览器尚未初始化，无法${action}。请先运行 boss login 并在浏览器中完成登录。`;
}

/** 当前 URL 是否属于 Boss 直聘站点（hostname 含 `zhipin.com`）；`about:blank` / 空 / 非法视为否 */
export function isBossZhipinSiteUrl(url: string): boolean {
  if (!url || url === 'about:blank') {
    return false;
  }
  try {
    const u = new URL(url);
    return u.hostname.includes('zhipin.com');
  } catch {
    return false;
  }
}

/** 当前 URL 是否为沟通页 `/web/chat/index`（允许带 query） */
export function isBossChatIndexUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zhipin.com')) {
      return false;
    }
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return p === '/web/chat/index';
  } catch {
    return false;
  }
}

/**
 * 是否已经位于 Boss 已登录主壳页（pathname 以 `/web/chat/` 开头）。
 * 当前已知主壳页：`/web/chat/index`、`/web/chat/recommend`、`/web/chat/aiform`、`/web/chat/job/list`。
 * 它们共享同一套侧栏 `.menu-list`，校验登录态时不必再额外跳回 `/web/chat/index`。
 */
export function isBossChatShellUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zhipin.com')) {
      return false;
    }
    const p = u.pathname.replace(/\/+$/, '') || '/';
    return p === '/web/chat' || p.startsWith('/web/chat/');
  } catch {
    return false;
  }
}

/**
 * 登录态失效时给操作者的统一文案。
 *
 * 为什么必须有这么一条：实测登录掉线时，日志里报出来的是四种互不相干的话——
 * 「等推荐列表就绪超时」、「点了侧栏但页面没跳」、「当前不在推荐列表页」、
 * 以及最有害的那条「目标页面被导航或刷新…**这与登录态无关，不要调 boss_login**」。
 * 最后这条在登录真的掉了的时候仍然照说，等于把唯一的解法排除掉；它在审计日志里出现过 4 次。
 * `isWebUserLoginUrl` 这个判据早就存在，但业务路径一处都没用过。
 *
 * `/web/user/?ka=bticket` 里的 `bticket` 就是 Boss 判票失败的落地标记。
 * 注意：偶发的一次 `bticket` 弹跳重试即可恢复（实测遇到过），**连续多次**才说明票据真的失效了。
 */
export function formatLoggedOutMessage(currentUrl: string, actionName?: string): string {
  // 两种落点，确定性不同，开头那句必须分开写，不能都断言成「登录页」。
  // 实测：票据失效时 Boss 更常把 B 端会话弹到**首页** `https://www.zhipin.com/`，
  // 而不是 `/web/user/?ka=bticket`；只认后者会漏掉主要路径（这一版就是这么漏的）。
  const onLoginPage = isWebUserLoginUrl(currentUrl);
  const head = onLoginPage
    ? `❌ Boss 登录态已失效${actionName ? `，无法${actionName}` : ''}：页面停在登录页 ${currentUrl || '(unknown)'}。`
    : `❌ 已被弹出 Boss 主壳${actionName ? `，无法${actionName}` : ''}：明确导航到 /web/chat/* 之后，页面被送到了 ${currentUrl || '(unknown)'}。`;
  return [
    head,
    '',
    onLoginPage
      ? '这不是前端改版、也不是渲染进程僵死——是登录票据被服务端判为无效（`?ka=bticket` 即判票失败标记）。'
      : '主动进主壳却被踢出来，最可能是登录票据被服务端判为无效（另一种落点是 `/web/user/?ka=bticket`）。',
    '',
    '怎么确认：再调一次读列表的工具。**又被弹出**就是票据失效；能正常进去就是一次性抖动。',
    '',
    '处理办法：在这台机器的**桌面会话**里执行 `boss login`，用 Boss App 扫码。',
    'MCP 的 boss_login 工具只能把标签导航到登录页，替不了扫码这一步；纯 SSH / 无桌面会话下扫不了码。',
  ].join('\n');
}

/**
 * 页面是否已经不在 Boss 主壳里（`/web/chat/*` 之外的 zhipin 页面）。
 *
 * 用途：区分「页面被导航走」与「会话被服务端踢出」。在我们**刚刚主动导航到 `/web/chat/*`**
 * 之后仍然落在主壳外，就不是随机的页面漂移，而是被拒绝进入——这是推断，不是猜测。
 * 首页与 `/web/user/*` 都属于主壳外；`/web/frame/*` 只出现在 iframe 里，不会是顶层页面 URL。
 */
export function isOutsideBossShellUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zhipin.com')) {
      return false;
    }
    return !isBossChatShellUrl(url);
  } catch {
    return false;
  }
}

/** 未登录时常见跳转：如 `https://www.zhipin.com/web/user/?ka=bticket` */
export function isWebUserLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('zhipin.com')) {
      return false;
    }
    return u.pathname.includes('/web/user/');
  } catch {
    return false;
  }
}

export type ProbeLoggedInSignals = {
  hasNickname: boolean;
  navLoginCta: boolean;
  hasLogoutHint: boolean;
};

/**
 * 必须在页面里执行的探测脚本（纯字符串）。
 * `tsx`/esbuild 转译 `page.evaluate(() => { ... })` 时可能注入 `__name(...)`，序列化到浏览器后会报 `__name is not defined`。
 */
const PROBE_LOGGED_IN_SIGNALS_SCRIPT = `(() => {
  function isNick(t) {
    const s = t.replace(/\\s+/g, " ").trim();
    if (s.length < 2 || s.length > 64) return false;
    return !/^(我要登录|登录|注册|登录\\/注册)$/u.test(s);
  }
  var hasNickname = false;
  var nickSelectors = [
    ".user-name",
    "span.user-name",
    "[class*='user-name']",
    ".label-name",
    ".nav-user .name",
    ".nav-user-name",
    "a.nav-user",
    ".header-nav [class*='name']",
  ];
  var si, i, els, el, t;
  for (si = 0; si < nickSelectors.length; si++) {
    els = document.querySelectorAll(nickSelectors[si]);
    for (i = 0; i < els.length; i++) {
      el = els[i];
      t = (el.textContent || "").trim();
      if (isNick(t)) {
        hasNickname = true;
        break;
      }
    }
    if (hasNickname) break;
  }
  var navRoots = [];
  var navSels = ["header", ".nav-header", ".nav-wrap", ".top-header", "#header", ".header", ".navbar"];
  var j, ne;
  for (j = 0; j < navSels.length; j++) {
    ne = document.querySelector(navSels[j]);
    if (ne instanceof HTMLElement) navRoots.push(ne);
  }
  var navLoginCta = false;
  for (i = 0; i < navRoots.length; i++) {
    if (/\\b我要登录\\b/u.test(navRoots[i].innerText || "")) {
      navLoginCta = true;
      break;
    }
  }
  var bodyText = document.body instanceof HTMLElement ? document.body.innerText || "" : "";
  var hasLogoutHint =
    /\\b退出登录\\b/u.test(bodyText) ||
    !!document.querySelector("a[href*='logout'], a[href*='signout'], [data-url*='logout']");
  return { hasNickname: hasNickname, navLoginCta: navLoginCta, hasLogoutHint: hasLogoutHint };
})()`;

async function probeLoggedInSignals(page: Page): Promise<ProbeLoggedInSignals> {
  return (await page.evaluate(PROBE_LOGGED_IN_SIGNALS_SCRIPT)) as ProbeLoggedInSignals;
}

/**
 * 根据当前页判断是否已登录（不导航）。
 *
 * **已登录（true）**：检测到顶栏昵称、或「退出登录」/logout 等信号。
 * 会短轮询等待 SPA 渲染，避免 `goto` 后立即读静态 HTML 误判。
 *
 * **未登录（false）**：`/web/user/` 登录流 URL、顶栏出现「我要登录」入口、且轮询结束仍无昵称/退出类信号。
 */
export async function probeLoggedInFromPage(
  page: Page,
): Promise<{ loggedIn: boolean; url: string }> {
  const url = page.url();
  if (!url || url === 'about:blank') {
    return { loggedIn: false, url: url || '' };
  }
  if (isWebUserLoginUrl(url)) {
    return { loggedIn: false, url };
  }

  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const s = await probeLoggedInSignals(page);
    if (s.hasNickname || s.hasLogoutHint) {
      return { loggedIn: true, url };
    }
    if (s.navLoginCta) {
      return { loggedIn: false, url };
    }
    if (attempt < maxAttempts - 1) {
      await sleepRandom(PROBE_LOGIN_POLL_MS.min, PROBE_LOGIN_POLL_MS.max);
    }
  }

  return { loggedIn: false, url };
}

/** 沟通页且已登录（与 {@link probeLoggedInFromPage} 一致）。 */
export async function probeBossChatIndexLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (!isBossChatIndexUrl(url)) {
    return false;
  }
  const { loggedIn } = await probeLoggedInFromPage(page);
  return loggedIn;
}
