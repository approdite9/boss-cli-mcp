/**
 * 批量打招呼：对集合中「未打招呼」的候选人逐个执行 `implRecommendGreet`。
 *
 * 循环骨架（dryRun / limit / 随机间隔 / 每人落盘 / 响应取消）在 `pool_batch.ts`，
 * 这里只描述「打招呼」这个动作本身的特殊之处：
 * - jobKeyword 只在**第一个**候选人时传入。`runRecommendGreet` 每次带 jobKeyword 都会重新切换岗位，
 *   而在深度搜索页切岗位会重置匹配结果列表，批量场景下会把后续候选人全部弄丢。
 * - greet 的原始输出会把整个推荐/深搜列表 dump 出来，批量时必须压成一行。
 */
import { implRecommendGreet } from '../toolset/index.js';
import { pendingCandidates } from './pool.js';
import { runPoolBatch, type PoolBatchOptions } from './pool_batch.js';

/** 单次批量打招呼的硬上限：即便调用方传了更大的 limit，也不允许一次打超过这个数 */
export const GREET_BATCH_HARD_LIMIT = 50;

/** 每个候选人之间的随机间隔（毫秒） */
const GREET_GAP_MS = { min: 3_000, max: 8_000 } as const;

const PRECONDITION =
  '执行前请确保浏览器当前已在「推荐」或「深度搜索」页且候选人列表已加载——批量打招呼不会自动跳转。';

export type GreetAllOptions = PoolBatchOptions & {
  /** 仅对第一个候选人生效的岗位关键字；不传则完全不切岗位（沿用当前页面岗位） */
  jobKeyword?: string;
};

/** greet 的原始输出会把整个列表 dump 出来；批量场景只保留结论行 */
function summarizeGreetOutput(raw: string): string {
  const cut = raw.split(/\n\s*(?:当前推荐列表|当前深度搜索列表)/)[0] ?? raw;
  const line = cut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('当前岗位：'))
    .join(' / ');
  const text = line || cut.trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export async function greetAll(options: GreetAllOptions): Promise<string> {
  return runPoolBatch(options, {
    actionName: '打招呼',
    quotaNote: '打招呼配额',
    precondition: PRECONDITION,
    hardLimit: GREET_BATCH_HARD_LIMIT,
    gapMs: GREET_GAP_MS,
    pickTargets: pendingCandidates,
    execute: (candidate, isFirst) =>
      implRecommendGreet({
        candidateTarget: candidate.name,
        // 只有第一个才切岗位，避免重复切换把匹配结果列表重置掉
        jobKeyword: isFirst ? options.jobKeyword : undefined,
      }),
    onSuccess: (candidate) => {
      candidate.greeted = true;
      candidate.greetedAt = new Date().toISOString();
      candidate.lastError = undefined;
    },
    onFailure: (candidate, message) => {
      candidate.lastError = message;
    },
    summarize: summarizeGreetOutput,
  });
}
