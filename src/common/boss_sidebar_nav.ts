import type { Page } from 'puppeteer-core';
import { SIDEBAR_NAV_AFTER_CLICK_MS, sleepRandom, humanClick } from '../browser/index.js';
import { randomIntInclusive, sleep } from '../browser/timing.js';

const SIDEBAR_NAV_WAIT_MS = 15_000;

/**
 * 点击 Boss 左侧 `.menu-list` 中的菜单项，并等待导航到给定 pathname（如 `/web/chat/index`）。
 * 使用真实鼠标事件（isTrusted=true）以确保 SPA 路由正确响应。
 */
export async function clickBossSidebarMenuToPath(
  page: Page,
  menuLabel: string,
  targetPath: string,
): Promise<void> {
  // Step 1: 在页面中定位目标菜单项并获取其坐标
  const targetBox = (await page.evaluate(
    `(({ label, path }) => {
      const norm = (v) => (v ?? "").replace(/\\s+/g, "");
      const links = Array.from(document.querySelectorAll(".menu-list a"));
      const target = links.find((a) => {
        const href = a.getAttribute("href") ?? "";
        if (href.includes(path)) {
          return true;
        }
        const text = norm(a.querySelector(".menu-item-content span")?.textContent ?? a.textContent);
        return text.includes(label);
      });
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      target.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = target.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    })`,
    { label: menuLabel, path: targetPath },
  )) as { x: number; y: number } | null;

  if (!targetBox) {
    throw new Error(`未找到侧边栏菜单"${menuLabel}"，无法跳转到 ${targetPath}。`);
  }

  // Step 2: 用真实鼠标事件点击（贝塞尔曲线轨迹 + isTrusted=true）
  await sleep(randomIntInclusive(80, 200));
  await humanClick(page, targetBox.x, targetBox.y);

  await sleepRandom(SIDEBAR_NAV_AFTER_CLICK_MS.min, SIDEBAR_NAV_AFTER_CLICK_MS.max);

  // Step 3: 等待 SPA 路由切换完成
  await page.waitForFunction(
    `((path) => {
      try {
        const p = window.location.pathname.replace(/\\/+$/, "") || "/";
        return p === path;
      } catch {
        return false;
      }
    })`,
    { timeout: SIDEBAR_NAV_WAIT_MS },
    targetPath,
  );
}
