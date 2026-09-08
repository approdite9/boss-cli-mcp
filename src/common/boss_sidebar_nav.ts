import type { Page } from 'puppeteer-core';
import { SIDEBAR_NAV_AFTER_CLICK_MS, sleepRandom, humanClick } from '../browser/index.js';
import { randomIntInclusive, sleep } from '../browser/timing.js';
import { rethrowWaitTimeout } from './wait_timeout.js';

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
  //
  // 参数必须用 JSON.stringify 内联进脚本文本：puppeteer 对**字符串** pageFunction 走
  // `Runtime.evaluate`，额外参数会被直接丢弃（见 cdp/ExecutionContext #evaluate）。
  // 之前写成 `(({label, path}) => {...})` + 传参，实际返回的是那个未被调用的函数对象，
  // returnByValue 序列化后得到 `{}`——非 null 于是通过了下面的判空，
  // 再取 `.x/.y` 得到 undefined，最终以 `Input.dispatchMouseEvent ... params.x` 报错。
  const labelLiteral = JSON.stringify(menuLabel);
  const pathLiteral = JSON.stringify(targetPath);
  const targetBox = (await page.evaluate(
    `(() => {
      const label = ${labelLiteral};
      const path = ${pathLiteral};
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
    })()`,
  )) as { x: number; y: number } | null;

  if (!targetBox) {
    throw new Error(`未找到侧边栏菜单"${menuLabel}"，无法跳转到 ${targetPath}。`);
  }
  if (!Number.isFinite(targetBox.x) || !Number.isFinite(targetBox.y)) {
    throw new Error(
      `侧边栏菜单"${menuLabel}"坐标非法（x=${targetBox.x} y=${targetBox.y}），无法点击跳转到 ${targetPath}。`,
    );
  }

  // Step 2: 用真实鼠标事件点击（贝塞尔曲线轨迹 + isTrusted=true）
  await sleep(randomIntInclusive(80, 200));
  await humanClick(page, targetBox.x, targetBox.y);

  await sleepRandom(SIDEBAR_NAV_AFTER_CLICK_MS.min, SIDEBAR_NAV_AFTER_CLICK_MS.max);

  // Step 3: 等待 SPA 路由切换完成
  //
  // 同样必须内联参数并自执行：`waitForFunction` 对字符串会包成 `() => { return (表达式); }`，
  // 传入的参数不会到达表达式内部。写成未调用的箭头函数时，表达式的值是函数对象（恒为真），
  // 于是这个等待会立刻「成功」——路由根本没校验过。
  // 超时原本报的是裸的 `Waiting failed: 15000ms exceeded`，一路冒到工具层变成
  // 「获取岗位列表失败：Waiting failed: 15000ms exceeded」——看不出点没点中、页面停在哪。
  // 实测这条签名在审计日志里出现 14 次，全是 boss_list_positions。
  await page
    .waitForFunction(
      `(() => {
      try {
        const p = window.location.pathname.replace(/\\/+$/, "") || "/";
        return p === ${pathLiteral};
      } catch {
        return false;
      }
    })()`,
      { timeout: SIDEBAR_NAV_WAIT_MS },
    )
    .catch((e: unknown) =>
      rethrowWaitTimeout(
        e,
        `点了侧栏「${menuLabel}」但 ${SIDEBAR_NAV_WAIT_MS}ms 内页面没跳到 ${targetPath}。` +
          `当前页面：${page.url() || 'unknown'}。` +
          `点击本身是发出去了（已按坐标 ${Math.round(targetBox.x)},${Math.round(targetBox.y)} 派发可信点击），` +
          `所以要么菜单项换了目标地址、要么点被浮层挡住、要么该标签的渲染进程已经不响应。`,
      ),
    );
}
