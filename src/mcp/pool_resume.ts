/**
 * 批量抓在线简历：对集合中还没有简历细节的候选人逐个执行 `implPreview`，
 * 把「截图路径 + OCR 正文」缓存进集合，之后 pool_list / pool_get_detail / pool_export 都能直接用。
 *
 * 关于「为什么不是下载文件」：Boss 的**在线简历不是文件**，是 `/web/frame/c-resume/...` iframe
 * 里渲染出来的页面，没有可下载的原件。业务层（`common/c_resume_capture.ts`）刻意选择对 iframe
 * 整框截图而非读 DOM 文字，原因见 `toolset/action.ts` 的注释：内页可能是 canvas 渲染或跨域，
 * 读不到文字节点。所以「下载简历」在这里的可实现形态就是：截图落盘 + OCR 成文本 + 批量归档。
 * （真正是文件的是**附件简历**，需要对方发送后从聊天里取，本项目尚未实现下载。）
 *
 * ⚠️ 每抓一个人都消耗一次平台「每日在线简历查看次数」，这个配额通常远小于打招呼次数，
 * 所以硬上限设得比打招呼更保守。
 */
import { implPreview } from '../toolset/index.js';
import { candidatesWithoutDetail, type Pool, type PoolCandidate } from './pool.js';
import { runPoolBatch, type PoolBatchOptions } from './pool_batch.js';

/** 单次批量抓简历的硬上限。简历查看配额比打招呼稀缺得多，故设得更保守。 */
export const RESUME_BATCH_HARD_LIMIT = 20;

/** 抓取之间的随机间隔：简历弹层开关较重，间隔比打招呼略长 */
const RESUME_GAP_MS = { min: 4_000, max: 9_000 } as const;

const PRECONDITION =
  '执行前请确保浏览器当前已在「推荐」/「深度搜索」/「常规搜索」页且候选人列表已加载——抓简历不会自动跳转，' +
  '且列表里必须能按姓名找到这些候选人。';

export type BatchResumeOptions = PoolBatchOptions & {
  /** 只抓这些 id；不传则抓所有还没有简历的人 */
  ids?: number[];
  /** 已有简历的人也重新抓（同样消耗配额），默认 false */
  refresh?: boolean;
};

/** 单条简历正文往往几千字，批量结果里只放摘要 */
function summarizeResume(raw: string): string {
  const shotLine = /简历预览截图：(.+)/.exec(raw)?.[1]?.trim();
  const chars = raw.length;
  return shotLine
    ? `已抓取（正文 ${chars} 字符），截图 ${shotLine}`
    : `已抓取（正文 ${chars} 字符）`;
}

export async function batchResume(options: BatchResumeOptions): Promise<string> {
  const wanted = options.ids && options.ids.length > 0 ? new Set(options.ids) : null;
  const refresh = options.refresh === true;

  const pickTargets = (pool: Pool): PoolCandidate[] => {
    const base = refresh ? pool.candidates : candidatesWithoutDetail(pool);
    return wanted ? base.filter((c) => wanted.has(c.id)) : base;
  };

  return runPoolBatch(options, {
    actionName: '抓在线简历',
    quotaNote: '每日在线简历查看次数',
    precondition: PRECONDITION,
    hardLimit: RESUME_BATCH_HARD_LIMIT,
    gapMs: RESUME_GAP_MS,
    pickTargets,
    execute: (candidate) => implPreview({ candidateTarget: candidate.name }),
    onSuccess: (candidate, raw) => {
      candidate.detail = raw;
      candidate.detailAt = new Date().toISOString();
      candidate.lastDetailError = undefined;
    },
    onFailure: (candidate, message) => {
      candidate.lastDetailError = message;
    },
    summarize: summarizeResume,
  });
}
