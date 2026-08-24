import { basename, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureAppDataLayout, RESUME_OCR_DIR } from '../config.js';
import { baiduOcrImageBase64, isBaiduOcrConfigured } from './baidu_ocr.js';
import { aliyunOcrImageBase64, isAliyunOcrConfigured } from './aliyun_ocr.js';

/**
 * 是否对在线简历截图做 OCR。关闭：`BOSS_RESUME_OCR=0`。
 * 开启时需配置阿里云或百度密钥。
 */
export function isResumeOcrEnabled(): boolean {
  const v = process.env.BOSS_RESUME_OCR?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * 是否有任意 OCR 服务已配置（阿里云 或 百度）。
 * 供 preflight 检查使用。
 */
export function isOcrConfigured(): boolean {
  return isAliyunOcrConfigured() || isBaiduOcrConfigured();
}

/** 串行执行 OCR，避免并发请求交错 */
let ocrChain: Promise<unknown> = Promise.resolve();

/**
 * 对简历区域 PNG 做 OCR，将结果写入 `~/.boss-cli/.cache/ocr/`（与截图同名 `.txt`）。
 *
 * 后端选择：**配了阿里云就只用阿里云，配了百度（且没配阿里云）才用百度。**
 *
 * 注意这里**没有 fallback**——阿里云调用失败时不会自动切百度，而是直接把错误抛出去。
 * 这是 `AGENTS.md`「禁止添加任何回退逻辑」的要求：静默切换后端会掩盖真实故障
 * （欠费、时钟漂移、权限缺失），让人误以为服务正常。
 *
 * 因此「配了百度当备用」是无效的：只要阿里云的两个环境变量还在，百度永远不会被调用。
 * 要切百度必须移除 `BOSS_ALIYUN_ACCESS_KEY_ID` / `BOSS_ALIYUN_ACCESS_KEY_SECRET`。
 */
export async function ocrResumePngToTextFile(pngAbsPath: string): Promise<{ textPath: string; text: string }> {
  ensureAppDataLayout();

  // 优先阿里云，其次百度
  const useAliyun = isAliyunOcrConfigured();
  const useBaidu = isBaiduOcrConfigured();

  if (!useAliyun && !useBaidu) {
    throw new Error(
      '已开启简历 OCR（BOSS_RESUME_OCR），但未配置 OCR 密钥。\n' +
      '请配置以下任一服务：\n' +
      '  阿里云：BOSS_ALIYUN_ACCESS_KEY_ID + BOSS_ALIYUN_ACCESS_KEY_SECRET\n' +
      '  百度：BOSS_BAIDU_API_KEY + BOSS_BAIDU_SECRET_KEY',
    );
  }

  const base = basename(pngAbsPath).replace(/\.png$/i, '.txt');
  const textPath = join(RESUME_OCR_DIR, base);

  const run = async (): Promise<{ textPath: string; text: string }> => {
    const buf = await readFile(pngAbsPath);
    const imageBase64 = buf.toString('base64');

    let text: string;
    if (useAliyun) {
      text = await aliyunOcrImageBase64(imageBase64);
    } else {
      text = await baiduOcrImageBase64(imageBase64);
    }

    await writeFile(textPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return { textPath, text };
  };

  const p = ocrChain.then(run);
  ocrChain = p.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[boss-cli] resume OCR chain reset after failure:', msg);
  });
  return p;
}
