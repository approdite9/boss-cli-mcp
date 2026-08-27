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
export async function ocrResumePngsToTextFile(
  pngAbsPaths: string[],
): Promise<{ textPath: string; text: string }> {
  ensureAppDataLayout();

  if (pngAbsPaths.length === 0) {
    throw new Error('没有可 OCR 的简历截图。');
  }

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

  // 文本文件按第一张截图命名：长简历会被切成 `x-p1.png`、`x-p2.png`…，
  // 但它们是同一份简历，正文必须拼成一份，不能散成多个 .txt。
  const base = basename(pngAbsPaths[0]!)
    .replace(/-p\d+\.png$/i, '.png')
    .replace(/\.png$/i, '.txt');
  const textPath = join(RESUME_OCR_DIR, base);

  const run = async (): Promise<{ textPath: string; text: string }> => {
    const parts: string[] = [];
    for (const png of pngAbsPaths) {
      const buf = await readFile(png);
      const imageBase64 = buf.toString('base64');
      // 分段之间没有重叠，所以按顺序直接拼接即可；切口处可能有一行被切成两半，
      // 那是刻意选择（重叠会产生重复的经历条目，对读简历的干扰更大）。
      parts.push(
        useAliyun ? await aliyunOcrImageBase64(imageBase64) : await baiduOcrImageBase64(imageBase64),
      );
    }
    const text = parts.join('\n');

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
