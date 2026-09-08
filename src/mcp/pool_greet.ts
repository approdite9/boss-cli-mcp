/**
 * 批量打招呼：对集合中「未打招呼」的候选人逐个执行 `implRecommendGreet`。
 *
 * 循环骨架（dryRun / limit / 随机间隔 / 每人落盘 / 响应取消）在 `pool_batch.ts`，
 * 这里只描述「打招呼」这个动作本身的特殊之处：
 * - jobKeyword 只在**第一个**候选人时传入。`runRecommendGreet` 每次带 jobKeyword 都会重新切换岗位，
 *   而在深度搜索页切岗位会重置匹配结果列表，批量场景下会把后续候选人全部弄丢。
 * - 有 geekId 就带上 geekId（`expectGeekId`），让定位落在平台身份而不是姓名上。
 *   没有 geekId 的候选人（深搜来源、或本功能上线前入库的）仍按精确姓名定位，
 *   匹配不到会直接报错，不会退化成模糊匹配。
 * - greet 的原始输出会把整个推荐/深搜列表 dump 出来，批量时必须压成一行。
 */
import { withBossSessionPage } from '../common/boss_session_page.js';
import { ensureInRecommendPage, readRecommendList } from '../toolset/recommend.js';
import { implRecommendGreet } from '../toolset/index.js';
import { pendingCandidates, type PoolCandidate } from './pool.js';
import { runPoolBatch, type PoolBatchOptions, type TargetVerification } from './pool_batch.js';

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
        // 集合里存了 geekId 就按身份定位。批量打招呼是「筛选」与「执行」之间隔了几十分钟的场景，
        // 推荐列表这期间很可能已经换过一批，只靠姓名回查最容易打到同名/近名的另一个人。
        expectGeekId: candidate.geekId,
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
    verifyTargets: verifyGreetTargets,
  });
}

/**
 * 预演阶段免配额地核对：页面还能用吗？这批人还在当前推荐列表里吗？
 *
 * 针对的是真实用法里最贵的失败：AI 筛几十分钟，等到批量打招呼时才发现推荐列表已经换过一批，
 * 或者页面在这段空闲里僵死了——两种情况今天的日志里都有（「此人已不在列表里」、
 * 「addScriptToEvaluateOnNewDocument timed out」）。这两件事都能在预演时问出来，代价为零。
 *
 * 全程只读：`readRecommendList` 只枚举卡片，不点击、不导航、不消耗任何配额。
 */
async function verifyGreetTargets(targets: PoolCandidate[]): Promise<TargetVerification> {
  return withBossSessionPage(async (page) => {
    const frame = await ensureInRecommendPage(page);
    const list = await readRecommendList(frame);

    const geekIds = new Set(list.map((c) => c.geekId).filter((v): v is string => !!v));
    const names = new Set(list.map((c) => c.name).filter(Boolean));

    const locatableIds: number[] = [];
    const missing: Array<{ id: number; name: string; reason: string }> = [];
    for (const c of targets) {
      if (c.geekId) {
        // 有 geekId 就只认 geekId：执行时也是这么定位的，这里必须用同一判据，
        // 否则预演说「能打」而执行报「找不到」，比不核对更糟。
        if (geekIds.has(c.geekId)) locatableIds.push(c.id);
        else missing.push({ id: c.id, name: c.name, reason: `geekId=${c.geekId} 不在当前列表` });
        continue;
      }
      // 没有 geekId 的（深搜来源或老数据）执行时按精确姓名定位，这里同样按姓名核对
      if (names.has(c.name)) locatableIds.push(c.id);
      else missing.push({ id: c.id, name: c.name, reason: '无 geekId，且当前列表没有同名候选人' });
    }

    return { pageUsable: true, locatableIds, missing, listSize: list.length };
  });
}
