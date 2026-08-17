/**
 * 调用前置检查：把「已经消耗掉真实配额之后才失败」的路径提前拦在动手之前。
 *
 * 背景：在线简历 OCR 默认开启（`BOSS_RESUME_OCR` 未设为 0 即为开），但 OCR 需要阿里云或百度密钥。
 * 缺密钥时业务层的执行顺序是：点开简历（**平台配额已扣**）→ 截图 → OCR → 抛错。
 * CLI 下有人盯着，看到报错就去配密钥；MCP 下 Agent 只看到「失败」，很可能直接重试，
 * 于是每重试一次就再扣一次每日简历查看次数。所以这里在 MCP 层先做一次纯本地检查。
 *
 * 依赖用参数注入，便于在不改环境变量的前提下单测。
 */
import { isOcrConfigured, isResumeOcrEnabled } from '../ocr/index.js';

export type ResumeOcrDeps = {
  ocrEnabled: () => boolean;
  ocrConfigured: () => boolean;
};

const DEFAULT_DEPS: ResumeOcrDeps = {
  ocrEnabled: isResumeOcrEnabled,
  ocrConfigured: isOcrConfigured,
};

/**
 * 在任何会「打开在线简历」的操作之前调用。
 * - OCR 关闭：只出截图，不会失败 → 放行。
 * - OCR 开启且密钥齐全 → 放行。
 * - OCR 开启但缺密钥 → 立即抛错，一次配额都不消耗。
 */
export function assertResumeOcrReady(tool: string, deps: ResumeOcrDeps = DEFAULT_DEPS): void {
  if (!deps.ocrEnabled()) {
    return;
  }
  if (deps.ocrConfigured()) {
    return;
  }
  throw new Error(
    [
      `❌ ${tool} 已提前中止，未消耗任何简历查看配额。`,
      '原因：在线简历 OCR 默认开启，但未配置 OCR 密钥。若继续执行，会先扣掉一次每日简历查看次数再因 OCR 失败而报错。',
      '',
      '解决方案（三选一）：',
      '1) 配置阿里云 OCR 密钥（推荐）：在 ~/.boss-cli/.env 中设置 BOSS_ALIYUN_ACCESS_KEY_ID 和 BOSS_ALIYUN_ACCESS_KEY_SECRET；',
      '2) 配置百度 OCR 密钥：在 ~/.boss-cli/.env 中设置 BOSS_BAIDU_API_KEY 和 BOSS_BAIDU_SECRET_KEY；',
      '3) 关闭 OCR，只要截图：在 MCP 客户端配置的 env 里加 BOSS_RESUME_OCR=0，然后重启 MCP server。',
      '',
      '（注意：MCP 客户端的工作目录不可控，项目里的 .env 通常不会被读到，请用 ~/.boss-cli/.env 或客户端 env 配置。）',
    ].join('\n'),
  );
}
