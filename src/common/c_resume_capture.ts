import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { sleepRandom } from '../browser/timing.js';
import { resumeHeight, setTempHeight } from '../browser/viewport_temp.js';

/** 在线简历 iframe：`src` 常为相对路径 `/web/frame/c-resume/...`，故用子串匹配 */
export const C_RESUME_IFRAME_SELECTOR =
  'iframe[src*="c-resume"], iframe[src*="frame/c-resume"]' as const;

const CLOSE_C_RESUME_PANEL_SCRIPT = `(() => {
  const sel = ${JSON.stringify(C_RESUME_IFRAME_SELECTOR)};
  function hasCResumeIframe(root) {
    return Array.from(root.querySelectorAll('iframe')).some((iframe) => {
      const src = iframe.getAttribute('src') || '';
      return src.includes('c-resume') || src.includes('frame/c-resume');
    });
  }
  const wraps = Array.from(document.querySelectorAll('.dialog-lib-resume, .boss-popup__wrapper, .boss-dialog__wrapper, .dialog-container'));
  for (var wi = 0; wi < wraps.length; wi++) {
    var w = wraps[wi];
    if (hasCResumeIframe(w)) {
      var c =
        w.querySelector('.close-btn') ||
        w.querySelector('.boss-popup__close') ||
        w.querySelector('.boss-dialog__close') ||
        w.querySelector('.drawer-close') ||
        w.querySelector('.icon-close') ||
        w.querySelector('.btn-quxiao');
      if (c) {
        c.click();
        return true;
      }
    }
  }
  var iframe = document.querySelector(sel);
  var node = iframe ? iframe.parentElement : null;
  for (var i = 0; i < 12 && node; i++) {
    var closeBtn = node.querySelector(
      '.close-btn, .boss-popup__close, .boss-dialog__close, .drawer-close, .icon-close, .btn-quxiao',
    );
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    node = node.parentElement;
  }
  return false;
})()`;

const C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS = 3_000;

const VISIBLE_C_RESUME_IN_FRAME_SCRIPT = `(() => {
  var iframe = document.querySelector(${JSON.stringify(C_RESUME_IFRAME_SELECTOR)});
  if (!(iframe instanceof HTMLElement)) return false;
  var r = iframe.getBoundingClientRect();
  return r.width > 8 && r.height > 8;
})()`;

export async function frameHasVisibleCResumeIframe(frame: Frame): Promise<boolean> {
  try {
    return (await frame.evaluate(VISIBLE_C_RESUME_IN_FRAME_SCRIPT)) as boolean;
  } catch {
    return false;
  }
}

/** 阿里云 OCR（RecognizeAllText）对图片边长的硬限制，用于判断这张截图是否根本传不上去。 */
const OCR_MAX_EDGE_PX = 8192;

/**
 * 记录刚落盘的截图实际像素尺寸、字节数与 DPR。
 *
 * 为什么需要：长简历会让整框截图超过 OCR 的 8192px 边长上限，线上只能看到阿里云回的
 * `416 illegalImageSize`，既不知道实际多高，也不知道是 DPR 放大还是简历本身长。
 * PNG 的宽高就在 IHDR 里（固定偏移 16..23），读 24 字节即可，不需要引入图像库。
 *
 * 越界警告是分段逻辑的兜网（不是回退路径）：真出现就说明尺寸计算错了，要修的是分段，
 * 而不是让它带着一张必然被拒的图去调 OCR。
 */
function logCapturedPngMetrics(absPath: string, deviceScaleFactor: number | undefined): void {
  let head: Buffer;
  let bytes: number;
  try {
    bytes = statSync(absPath).size;
    const fd = openSync(absPath, 'r');
    try {
      head = Buffer.alloc(24);
      readSync(fd, head, 0, 24, 0);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    console.error(
      `[boss-cli] 简历截图已落盘但无法读取尺寸：${absPath}（${e instanceof Error ? e.message : String(e)}）`,
    );
    return;
  }

  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  const dpr = deviceScaleFactor ?? 1;
  const over = width > OCR_MAX_EDGE_PX || height > OCR_MAX_EDGE_PX;

  console.error(
    [
      `[boss-cli] 简历截图 ${width}x${height}px`,
      `${Math.round(bytes / 1024)}KB`,
      `dpr=${dpr}`,
      absPath,
      over ? `⚠️ 超过 OCR 边长上限 ${OCR_MAX_EDGE_PX}px，本张 OCR 会被阿里云拒绝` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/** 截图文件名安全段（在线简历 / 推荐预览共用） */
export function safeResumeScreenshotFileBase(name: string): string {
  const t = name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 64);
  return t.length > 0 ? t : 'candidate';
}

/** 关闭含 `c-resume` iframe 的弹层（聊天「在线简历」与推荐「预览」共用）。含 `.boss-popup__close`、`.btn-quxiao`（取消）等。会在主文档与各子 frame 中尝试。 */
export async function closeCResumePanel(page: Page): Promise<void> {
  try {
    for (let round = 0; round < 5; round++) {
      let closedAny = false;
      for (const frame of page.frames()) {
        try {
          const closed = (await frame.evaluate(CLOSE_C_RESUME_PANEL_SCRIPT)) as boolean;
          closedAny = closedAny || closed;
        } catch {
          /* detached / 无权限 */
        }
      }
      if (!closedAny) {
        break;
      }
      await sleepRandom(200, 450);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 在任意 frame（含主 frame、`recommendFrame` 等）中查找已挂载且尺寸可见的 c-resume iframe。
 */
export async function findVisibleCResumeIframeHandle(page: Page): Promise<ElementHandle<Element> | null> {
  for (const frame of page.frames()) {
    try {
      if (!(await frameHasVisibleCResumeIframe(frame))) {
        continue;
      }
      const h = await frame.$(C_RESUME_IFRAME_SELECTOR);
      if (h) {
        return h;
      }
    } catch {
      /* detached */
    }
  }
  return null;
}

export async function waitForVisibleCResumeIframeReady(
  page: Page,
  timeoutMs = 6_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const iframe = await findVisibleCResumeIframeHandle(page);
    if (!iframe) {
      await sleepRandom(100, 180);
      continue;
    }
    try {
      const box = await iframe.boundingBox();
      const contentFrame = await iframe.contentFrame();
      if (box && box.width > 8 && box.height > 8) {
        if (!contentFrame) {
          return true;
        }
        try {
          const ready = (await contentFrame.evaluate(`(() => {
            const body = document.body;
            const doc = document.documentElement;
            const readyStateOk = document.readyState === "complete" || document.readyState === "interactive";
            const contentHeight = Math.max(body?.scrollHeight || 0, doc?.scrollHeight || 0);
            return readyStateOk && contentHeight > 100;
          })()`)) as boolean;
          if (ready) {
            return true;
          }
        } catch {
          return true;
        }
      }
    } finally {
      await iframe.dispose();
    }
    await sleepRandom(100, 180);
  }
  return false;
}

/** 分段文件名：`x.png` → `x-p1.png`。单段时不改名，保持既有路径语义。 */
function slicePath(absPath: string, index: number): string {
  return absPath.replace(/\.png$/i, `-p${index}.png`);
}

/**
 * 在已出现 `c-resume` iframe 的页面上截图并关闭弹层，返回实际生成的文件路径（空数组=失败）。
 *
 * 为什么可能是多张：阿里云 OCR（RecognizeAllText）要求图片边长 ≤ 8192px，
 * 而长简历整框截图的**设备像素**高度 = CSS 高度 × devicePixelRatio，很容易越界——
 * 线上表现是 `416 illegalImageSize`，一条日志里只有这句，既不知道多高也不知道是谁放大的。
 * 所以这里按 OCR 能接受的高度切段，逐段截图，由调用方逐段 OCR 后按顺序拼接文本。
 *
 * 切段用 `page.screenshot({ clip, captureBeyondViewport: true })`：实测能截到视口以外的区域
 * 且偏移正确，因此不需要引入任何图像库去切已生成的 PNG。
 *
 * 切口处可能把一行文字切成两半（OCR 会得到两个残缺段落）。刻意不做重叠：
 * 重叠会在拼接后产生重复的经历条目，对读简历的判断影响比一行被切开更大。
 *
 * `preOpenViewport` 为打开弹层前的视口快照，请用 `snapshotBossPageViewport(page)`
 * （`page.viewport()` 常为 null 时勿直接用默认尺寸）。
 */
export async function captureCResumeIframeToFile(
  page: Page,
  preOpenViewport: Awaited<ReturnType<Page['viewport']>>,
  absPath: string,
): Promise<string[]> {
  try {
    // 只拉高，不动宽度与 dsf。`preOpenViewport` 仍用于下面的 OCR 边长换算：
    // 因为不再覆盖 dsf，它拿到的就是真实设备像素比。
    await setTempHeight(page);
    await waitForVisibleCResumeIframeReady(page, 2_000);

    const iframe = await findVisibleCResumeIframeHandle(page);
    if (!iframe) {
      return [];
    }

    // 用 puppeteer 原生 scrollIntoView：之前写成 `iframe.evaluate("((el) => {...})")`，
    // 字符串脚本走 `Runtime.evaluate`，那个箭头函数从未被调用、`el` 也拿不到句柄，
    // 等于一次空操作——截图前的滚动定位实际没发生。
    await iframe.scrollIntoView();

    const box = await iframe.boundingBox();
    if (!box) {
      await iframe.dispose();
      return [];
    }

    const dpr = preOpenViewport?.deviceScaleFactor ?? 1;
    if (box.width * dpr > OCR_MAX_EDGE_PX) {
      await iframe.dispose();
      throw new Error(
        `在线简历 iframe 宽度 ${Math.round(box.width)}px × dpr ${dpr} = `
          + `${Math.round(box.width * dpr)}px，超过 OCR 边长上限 ${OCR_MAX_EDGE_PX}px。`
          + '纵向分段无法解决宽度越界，请调小 BOSS_BROWSER_VIEWPORT_WIDTH 后重试。',
      );
    }

    // 留出余量，别卡在 8192 边界上（PNG 尺寸受渲染取整影响，可能比算出来的多 1-2px）。
    const maxSliceCssPx = Math.floor((OCR_MAX_EDGE_PX - 192) / dpr);
    const sliceCount = Math.max(1, Math.ceil(box.height / maxSliceCssPx));
    const written: string[] = [];

    try {
      if (sliceCount === 1) {
        await iframe.screenshot({ path: absPath, type: 'png', captureBeyondViewport: true });
        written.push(absPath);
      } else {
        console.error(
          `[boss-cli] 在线简历高 ${Math.round(box.height)}px(css) × dpr ${dpr}，`
            + `超过 OCR 单图上限，切成 ${sliceCount} 段（每段 ≤ ${maxSliceCssPx}px css）。`,
        );
        for (let i = 0; i < sliceCount; i++) {
          const y = box.y + i * maxSliceCssPx;
          const height = Math.min(maxSliceCssPx, box.y + box.height - y);
          const target = slicePath(absPath, i + 1);
          await page.screenshot({
            path: target,
            type: 'png',
            captureBeyondViewport: true,
            clip: { x: box.x, y, width: box.width, height },
          });
          written.push(target);
        }
      }
    } finally {
      await iframe.dispose();
    }

    console.error(
      `[boss-cli] 在线简历 iframe css=${Math.round(box.width)}x${Math.round(box.height)} dpr=${dpr}`
        + `，共 ${written.length} 张截图。`,
    );
    for (const file of written) {
      logCapturedPngMetrics(file, dpr);
    }

    await sleepRandom(
      C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS,
      C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS,
    );
    await closeCResumePanel(page);
    return written;
  } finally {
    await resumeHeight(page);
  }
}
