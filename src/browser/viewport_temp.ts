import type { CDPSession, Page } from 'puppeteer-core';

/** 临时拉高视口时的默认高度（CSS px）。可用 `BOSS_RESUME_SCREENSHOT_VIEWPORT_HEIGHT` 覆盖。 */
const DEFAULT_TEMP_VIEWPORT_HEIGHT_PX = 5000;

type ViewportState = Awaited<ReturnType<Page['viewport']>>;
export type BossViewportSnapshot = NonNullable<ViewportState>;

/**
 * 每个 Page 当前持有的临时视口 CDP 会话。
 *
 * 必须记住会话：`Emulation.clearDeviceMetricsOverride` 是**按会话**生效的，
 * 从另一个会话发清除命令对本会话设下的 override 完全没有作用。
 * （现场踩过：服务重启后新会话反复 clear，页面上旧会话留下的 override 一动不动。）
 */
const tempHeightSessions = new WeakMap<Page, CDPSession>();

function resolvedTempHeightPx(heightPx?: number): number {
  if (heightPx !== undefined) {
    return heightPx;
  }
  const envH = Number.parseInt(process.env.BOSS_RESUME_SCREENSHOT_VIEWPORT_HEIGHT?.trim() ?? '', 10);
  return Number.isFinite(envH) && envH > 0 ? envH : DEFAULT_TEMP_VIEWPORT_HEIGHT_PX;
}

/**
 * 读取当前视口快照。现在只用于拿**真实的** `deviceScaleFactor`
 * （在线简历截图要用它换算 OCR 边长上限），不再作为「恢复基准」。
 *
 * 之所以现在可信：{@link setTempHeight} 已经不覆盖宽度与 dsf，
 * 所以 `window.devicePixelRatio` 全程保持真实值。
 */
export async function snapshotBossPageViewport(page: Page): Promise<BossViewportSnapshot> {
  const v = await page.viewport();
  if (v) {
    return {
      width: v.width,
      height: v.height,
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      isMobile: v.isMobile ?? false,
      hasTouch: v.hasTouch ?? false,
      isLandscape: v.isLandscape ?? false,
    };
  }
  // 必须用字符串自执行脚本，不能写成 `page.evaluate(() => ({...}))`：
  // 构建后 TS/esbuild 可能往回调体里注入 `__name` 辅助符号，而浏览器上下文里没有这个符号，
  // 运行时会抛 `__name is not defined`（见 AGENTS.md「Puppeteer evaluate 约束」）。
  // 本脚本不需要外部参数，所以没有需要 JSON.stringify 内联的东西。
  const dims = (await page.evaluate(`(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }))()`)) as { width: number; height: number; dpr: number };
  const width = Math.max(320, Math.round(dims.width));
  const height = Math.max(240, Math.round(dims.height));
  return {
    width,
    height,
    deviceScaleFactor: dims.dpr,
    isMobile: false,
    hasTouch: false,
    isLandscape: width > height,
  };
}

/**
 * 临时把视口**只**拉高，不动宽度、不动设备像素比。
 *
 * 为什么不用 `page.setViewport()`：那个 API 必须同时给出宽度与 deviceScaleFactor，
 * 于是上一版只能从 `window.innerWidth` / `window.devicePixelRatio` 推。这两个值**受浏览器缩放影响**，
 * 而 `setViewport` 设的是缩放无关的 CSS 尺寸，两者口径不一致，导致：
 *   - 浏览器缩放 ≠ 100% 时，每调一轮视口就被按 1/zoom 放大一次，且会累积；
 *   - dsf 被替换成「真实 dsf × zoom」，在线简历截图分辨率随之下降，OCR 识别率跟着掉。
 * 现场事故：缩放 67% 的机器上几轮之后页面认为自己是 4860×2188（真实窗口 1444×774），
 * 推荐页按 4860px 排版、窗口只画得出最左边约 30%，看起来就是「页面坏了」。
 *
 * CDP 原语没有这个问题：`Emulation.setDeviceMetricsOverride` 里
 * `width: 0` / `deviceScaleFactor: 0` 表示**该维度不覆盖、沿用真实值**。
 * 实测（1920×909 dpr 2 的页面）：只覆盖高度 3000 后为 1920×3000 dpr 2，宽度与 dpr 分毫未动。
 *
 * 与 {@link resumeHeight} 成对使用，请放在 try/finally 里。
 */
export async function setTempHeight(page: Page, heightPx?: number): Promise<void> {
  // 幂等：上一轮若因异常没释放干净，先释放，避免会话越堆越多
  await resumeHeight(page);

  const target = resolvedTempHeightPx(heightPx);
  const client = await page.createCDPSession();
  tempHeightSessions.set(page, client);
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 0,
    height: target,
    deviceScaleFactor: 0,
    mobile: false,
  });

  // CDP 命令返回 ≠ 页面已按新视口重新布局。必须等 `innerHeight` 真的变过来，
  // 否则紧接着的截图会拍到「按旧视口布局、只画了顶部一小块」的画面。
  //
  // 这一步是上一版漏掉的：改用裸 CDP 之前走的是 `page.setViewport()`，
  // puppeteer 内部会处理视口变更的生效；换成裸 CDP 后立即返回，中间的等待没了。
  // 后果是在线简历截图从 09-03 起大面积变成「顶部有内容 + 中间空白 + 底部残帧」，
  // OCR 字符数从日均 ~2400 掉到 ~600，而全链路没有任何一处报错。
  await waitForViewportHeight(page, target);
}

/** 视口高度生效的等待上限；正常在一两帧内就到位。 */
const VIEWPORT_SETTLE_TIMEOUT_MS = 3_000;
const VIEWPORT_SETTLE_POLL_MS = 60;

/**
 * 等到页面自己看到的 `innerHeight` 达到目标高度，再额外等一帧绘制。
 *
 * 不达标也不抛错：视口高度本身不是业务正确性的一部分，真正会因此失败的是截图，
 * 那里有自己的校验。这里只把「没等到」如实记下来，便于事后对齐时间线。
 */
async function waitForViewportHeight(page: Page, target: number): Promise<void> {
  const deadline = Date.now() + VIEWPORT_SETTLE_TIMEOUT_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = (await page.evaluate('(() => window.innerHeight)()')) as number;
    if (typeof seen === 'number' && seen >= target) {
      // 布局已按新视口跑完，再等两帧让合成器把新暴露的区域画出来。
      await page.evaluate(`(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }))()`);
      return;
    }
    await new Promise((r) => setTimeout(r, VIEWPORT_SETTLE_POLL_MS));
  }
  console.error(
    `[boss-cli] 临时视口高度未在 ${VIEWPORT_SETTLE_TIMEOUT_MS}ms 内生效：目标 ${target}px，实测 ${seen}px。`
      + '接下来的截图可能不完整。',
  );
}

/**
 * 与 {@link setTempHeight} 配对：清除临时高度 override，让页面回到真实窗口尺寸。
 *
 * 没有对应会话时直接返回——说明本轮没设过，无需（也无法）清除。
 */
export async function resumeHeight(page: Page): Promise<void> {
  const client = tempHeightSessions.get(page);
  if (!client) {
    return;
  }
  tempHeightSessions.delete(page);
  try {
    await client.send('Emulation.clearDeviceMetricsOverride');
  } finally {
    try {
      await client.detach();
    } catch (e) {
      // 页面已关闭 / 会话已随目标销毁时 detach 会失败。这不影响 override 已被清除的事实，
      // 但也不能静默吞掉：本函数常在 finally 里调用，抛出去会盖住调用方真正的错误。
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[boss-cli] 临时视口会话 detach 失败（不影响已清除的 override）：${msg}`);
    }
  }
}
