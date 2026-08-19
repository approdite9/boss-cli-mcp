/**
 * 纯无头登录：截图二维码 → 输出路径/base64 → 轮询等待扫码完成。
 *
 * 流程：
 * 1. 无头启动 CloakBrowser，导航到 Boss 登录页
 * 2. 等待二维码渲染（canvas 或 img）
 * 3. 截图保存到 ~/.boss-cli/.cache/qrcode.png 并输出 base64
 * 4. 轮询检测登录成功（URL 跳转或 cookie 变化）
 * 5. 成功后返回，登录态自动持久化在 browser-data 中
 */

import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { Page } from 'puppeteer-core';
import {
  ensureBrowserSession,
  getBrowserRef,
  getPageRef,
  setSessionPage,
  disconnectBrowserSession,
} from '../browser/index.js';
import { CACHE_DIR } from '../config.js';
import { probeLoggedInFromPage } from '../common/auth.js';

const BOSS_LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
const QRCODE_DIR = join(CACHE_DIR, 'qrcode');
const QRCODE_PATH = join(QRCODE_DIR, 'login_qrcode.png');

/** 二维码刷新周期（Boss 二维码约 5 分钟过期） */
const QR_REFRESH_INTERVAL_MS = 4 * 60 * 1000;
/** 轮询登录状态的间隔 */
const POLL_INTERVAL_MS = 2000;
/** 最大等待时间（5 分钟） */
const MAX_WAIT_MS = 5 * 60 * 1000;

export type HeadlessLoginResult = {
  success: boolean;
  qrcodePath?: string;
  qrcodeBase64?: string;
  message: string;
};

/**
 * 等待二维码元素出现并截图。
 * Boss 登录页二维码可能在 canvas 或 img 元素中。
 */
async function waitAndCaptureQRCode(page: Page): Promise<{ path: string; base64: string } | null> {
  // 等待二维码容器出现
  try {
    await page.waitForSelector(
      '.qr-code-box canvas, .qr-code-box img, .boss-login-qrcode canvas, .boss-login-qrcode img, .qrcode-img, canvas[width="200"], canvas[width="180"]',
      { timeout: 15_000 },
    );
  } catch {
    // fallback: 任何 canvas 元素
    try {
      await page.waitForSelector('canvas', { timeout: 5_000 });
    } catch {
      return null;
    }
  }

  // 给渲染一点时间
  await new Promise(r => setTimeout(r, 1000));

  // 尝试截取二维码区域
  const qrElement = await page.$(
    '.qr-code-box, .boss-login-qrcode, .qrcode-wrap, .qrcode-img'
  ) ?? await page.$('canvas');

  if (!qrElement) return null;

  // 确保输出目录存在
  if (!existsSync(QRCODE_DIR)) {
    mkdirSync(QRCODE_DIR, { recursive: true });
  }

  // 截图
  const buffer = await qrElement.screenshot({ type: 'png' }) as Buffer;
  writeFileSync(QRCODE_PATH, buffer);

  const base64 = buffer.toString('base64');

  return { path: QRCODE_PATH, base64 };
}

/**
 * 轮询等待登录成功。
 * 判断标准：URL 跳转离开 /web/user/ 或 probeLoggedInFromPage 返回 true。
 */
async function pollForLoginSuccess(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const url = page.url();
      // Boss 登录成功后会跳转到 /web/chat/ 或首页
      if (url.includes('/web/chat/') || url.includes('/web/geek/')) {
        return true;
      }

      // 也可能停留在同页但 cookie 已设置
      const probeResult = await probeLoggedInFromPage(page);
      if (probeResult.loggedIn) {
        return true;
      }
    } catch {
      // 页面可能在导航中，忽略
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  return false;
}

/**
 * 纯无头登录入口。
 *
 * 返回二维码截图路径和 base64，调用方（MCP/Agent）可自行决定如何展示给用户扫码。
 * 调用后会阻塞直到登录成功或超时。
 *
 * 使用方式：
 *   const result = await runHeadlessLogin();
 *   // result.qrcodeBase64 → 发给用户扫码
 *   // result.success → 是否登录成功
 */
export async function runHeadlessLogin(options?: {
  /** 最大等待时间（毫秒），默认 5 分钟 */
  timeoutMs?: number;
  /** 是否阻塞等待登录完成。false 时只截图二维码就返回 */
  waitForLogin?: boolean;
}): Promise<HeadlessLoginResult> {
  const timeoutMs = options?.timeoutMs ?? MAX_WAIT_MS;
  const waitForLogin = options?.waitForLogin !== false;

  // 确保无头模式
  process.env.BOSS_BROWSER_HEADLESS = 'true';

  try {
    await ensureBrowserSession();
    const browser = getBrowserRef();
    if (!browser) {
      return { success: false, message: '无法启动浏览器实例。' };
    }

    let page = getPageRef();
    if (!page || page.isClosed()) {
      page = await browser.newPage();
      setSessionPage(page);
    }

    // 导航到登录页
    await page.goto(BOSS_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30_000 });

    // 检查是否已经登录
    const alreadyResult = await probeLoggedInFromPage(page);
    if (alreadyResult.loggedIn) {
      return { success: true, message: '已处于登录状态，无需重复登录。' };
    }

    // 截取二维码
    const qrResult = await waitAndCaptureQRCode(page);
    if (!qrResult) {
      return {
        success: false,
        message: '未能捕获到登录二维码，请检查页面是否正常加载。',
      };
    }

    console.error(`[boss-cli] 二维码已保存: ${qrResult.path}`);
    console.error(`[boss-cli] 请使用 Boss 直聘 App 扫描二维码完成登录。`);

    if (!waitForLogin) {
      return {
        success: false,
        qrcodePath: qrResult.path,
        qrcodeBase64: qrResult.base64,
        message: `二维码已截图保存至 ${qrResult.path}，请扫码登录。`,
      };
    }

    // 轮询等待登录完成
    const loggedIn = await pollForLoginSuccess(page, timeoutMs);

    if (loggedIn) {
      return {
        success: true,
        qrcodePath: qrResult.path,
        qrcodeBase64: qrResult.base64,
        message: '扫码登录成功！登录态已持久化。',
      };
    } else {
      // 超时 — 可能二维码过期了，截新的
      return {
        success: false,
        qrcodePath: qrResult.path,
        qrcodeBase64: qrResult.base64,
        message: `等待超时（${Math.round(timeoutMs / 1000)}秒）。二维码可能已过期，请重新执行登录。`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `无头登录失败：${msg}` };
  }
}

/**
 * 仅截图二维码（不阻塞等待），适合 MCP tool 调用后立即返回给 Agent。
 * Agent 拿到 base64 后可以发给用户，然后另起一个 poll 确认登录状态。
 */
export async function captureLoginQRCode(): Promise<HeadlessLoginResult> {
  return runHeadlessLogin({ waitForLogin: false });
}

/**
 * 检查当前是否已登录（不打开新页面，复用现有会话）。
 */
export async function checkLoginStatus(): Promise<{ loggedIn: boolean; message: string }> {
  try {
    await ensureBrowserSession();
    const page = getPageRef();
    if (!page || page.isClosed()) {
      return { loggedIn: false, message: '无可用页面，请先执行登录。' };
    }
    const probe = await probeLoggedInFromPage(page);
    return {
      loggedIn: probe.loggedIn,
      message: probe.loggedIn ? '当前已登录。' : '当前未登录，请执行登录。',
    };
  } catch (e) {
    return { loggedIn: false, message: `检查登录状态失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
