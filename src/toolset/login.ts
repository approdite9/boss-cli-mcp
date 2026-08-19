import type { Browser, Page } from 'puppeteer-core';
import {
  detachBrowserSession,
  disconnectBrowserSession,
  ensureAndGetBrowser,
  ensureBrowserSession,
  getBrowserRef,
  getPageRef,
  setSessionPage,
  wasLastChromeLaunchHeadless,
} from '../browser/index.js';

import { runHeadlessLogin } from './login_headless.js';
const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';

async function pickExistingPage(browser: Browser): Promise<Page | null> {
  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  if (pages.length === 0) return null;

  const urls = await Promise.all(
    pages.map((p) => {
      try {
        return p.url();
      } catch {
        return '';
      }
    }),
  );

  const zhipin = pages.find((p, i) => {
    const u = urls[i] ?? '';
    return u.length > 0 && u !== 'about:blank' && u.includes('zhipin.com');
  });
  if (zhipin) return zhipin;

  const nonBlank = pages.find((p, i) => {
    const u = urls[i] ?? '';
    return u.length > 0 && u !== 'about:blank';
  });
  return nonBlank ?? null;
}

/**
 * 登录（手动）：只负责打开 Boss 登录页，让用户在浏览器中自行完成登录。
 * 不做登录态校验/等待/超时判断；成功与否由后续命令自行体现。
 */
export async function runLogin(): Promise<string> {
  // 判断运行模式：环境变量 BOSS_BROWSER_HEADLESS=true 时走纯无头截图二维码流程
  const isHeadlessMode =
    (process.env.BOSS_BROWSER_HEADLESS ?? '').trim().toLowerCase() === 'true' ||
    (process.env.BOSS_BROWSER_HEADLESS ?? '').trim() === '1';

  if (isHeadlessMode) {
    // 纯无头模式：截图二维码 + 轮询等待
    const result = await runHeadlessLogin({ waitForLogin: true, timeoutMs: 5 * 60 * 1000 });
    const lines: string[] = [];
    if (result.qrcodePath) {
      lines.push(`二维码已保存: ${result.qrcodePath}`);
    }
    if (result.qrcodeBase64) {
      lines.push(`二维码 Base64 (前100字符): ${result.qrcodeBase64.slice(0, 100)}...`);
    }
    lines.push(result.message);
    return lines.join('\n');
  }

  // 有头模式：原有逻辑，弹出浏览器窗口让用户手动扫码
  process.env.BOSS_BROWSER_HEADLESS = 'false';
  const existing = getBrowserRef();
  try {
    const args = existing?.process?.()?.spawnargs ?? [];
    const isHeadless =
      wasLastChromeLaunchHeadless() ||
      args.some((a) => typeof a === 'string' && a.startsWith('--headless'));
    if (existing?.connected && isHeadless) {
      await disconnectBrowserSession().catch(() => {});
    }
  } catch {
    // ignore
  }

  let browser: Browser | null = null;
  try {
    browser = (await ensureAndGetBrowser()) ?? (getBrowserRef() ?? null);
    if (!browser) {
      await ensureBrowserSession();
      browser = getBrowserRef() ?? null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`连接浏览器失败：${msg}`);
  }
  if (!browser) {
    throw new Error('无法获取浏览器实例，登录失败。');
  }

  let page: Page | null = getPageRef() ?? null;
  if (!page || page.isClosed()) {
    page = (await pickExistingPage(browser)) ?? (await browser.newPage());
  }
  setSessionPage(page);
  await page.bringToFront();
  await page.goto(BOSS_LOGIN_URL, { waitUntil: 'load', timeout: 60_000 });

  await detachBrowserSession();

  // 不做任何登录校验：只把浏览器打开到登录页；立即断开 CDP，CLI 不与浏览器进程长期绑定。
  return [
    `已在浏览器中打开 Boss 登录页：${BOSS_LOGIN_URL}`,
    '本命令已同步结束并立即返回，CLI 不会等待 / 轮询 / 校验登录结果。',
    'Agent调用方：把控制权交还给人类，不要在这一步自行 sleep / poll / retry',
  ].join('\n');
}

