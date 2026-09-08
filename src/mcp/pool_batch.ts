/**
 * 集合批量执行器：`pool_greet_all` 与 `pool_batch_resume` 共用的循环骨架。
 *
 * 抽出来的原因：这类「遍历集合 → 逐个执行会消耗真实配额的动作」的流程，风险点完全一样，
 * 必须每次都带上同一套保护，不能靠每个工具各写一遍：
 * 1. dryRun 预演（工具层默认 true，必须显式 false 才执行）；
 * 2. limit 单次上限，且有代码层硬上限兜底；
 * 3. 逐个之间随机间隔，降低风控命中率；
 * 4. 每完成一个立即落盘，中断/超时后再次调用能接着跑，不重复消耗配额；
 * 5. 响应取消信号，客户端放弃后立刻停手。
 */
import { sleepRandom } from '../browser/index.js';
import { pendingCountAfter, requirePool, savePool, type Pool, type PoolCandidate } from './pool.js';
import { reportPartialFailures } from './tool_metrics.js';

export type PoolBatchOptions = {
  job: string;
  dryRun: boolean;
  limit?: number;
  /** 客户端取消时中断批量 */
  signal?: AbortSignal;
  /** 每完成一个候选人回调一次，用于向客户端推进度 */
  onProgress?: (done: number, total: number, label: string) => void;
};

export type PoolBatchSpec = {
  /** 动作名，用于文案，如「打招呼」 */
  actionName: string;
  /** 会消耗什么配额，用于预演文案 */
  quotaNote: string;
  /** 前置条件说明，用于预演文案 */
  precondition: string;
  /** 代码层硬上限：即便调用方传了更大的 limit 也不允许超过 */
  hardLimit: number;
  /** 逐个之间的随机间隔（毫秒） */
  gapMs: { min: number; max: number };
  /** 从集合里挑出「待处理」的候选人 */
  pickTargets: (pool: Pool) => PoolCandidate[];
  /** 执行单个候选人；`isFirst` 供需要「只在第一个做一次」的场景使用 */
  execute: (candidate: PoolCandidate, isFirst: boolean) => Promise<string>;
  /** 成功后写回候选人状态（调用方负责，不在这里假设字段） */
  onSuccess: (candidate: PoolCandidate, rawOutput: string) => void;
  /** 失败后写回候选人状态 */
  onFailure: (candidate: PoolCandidate, message: string) => void;
  /** 把单次原始输出压成一行摘要（原始输出往往很长，直接拼会撑爆上下文） */
  summarize: (rawOutput: string) => string;
  /**
   * 可选：预演阶段去**当前页面**核对这批候选人还能不能定位到。
   *
   * 为什么必须在预演里做，而不是等执行时逐个报错：真实用法是「AI 筛几十分钟 → 再批量执行」，
   * 而推荐列表是易失的，这段间隔里很可能已经换过一批。等到执行时才发现人不在了，
   * 筛选的工夫已经白花，而且页面若在此期间僵死，第一个候选人就会白等一次超时。
   * 预演是免配额的，把「还能不能打」提前到这里问，代价为零。
   *
   * 不实现这个钩子的动作（如抓简历）预演行为保持原样。
   */
  verifyTargets?: (targets: PoolCandidate[]) => Promise<TargetVerification>;
};

/** 预演阶段对页面的核对结果。 */
export type TargetVerification = {
  /** 页面本身是否可用；false 时 detail 要说清原因（僵死 / 不在推荐页 / 未登录…） */
  pageUsable: boolean;
  /** 页面不可用时的说明 */
  detail?: string;
  /** 当前页面上能定位到的候选人 id（对应 PoolCandidate.id） */
  locatableIds?: number[];
  /** 定位不到的候选人及原因 */
  missing?: Array<{ id: number; name: string; reason: string }>;
  /** 当前列表规模，用于判断是否已经整体轮换 */
  listSize?: number;
};

function isAbortError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === 'Aborted' || (e instanceof Error && e.name === 'AbortError');
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderDryRun(
  spec: PoolBatchSpec,
  job: string,
  targets: PoolCandidate[],
  skipped: number,
  verification: TargetVerification | null,
): string {
  if (targets.length === 0) {
    return `集合「${job}」没有需要${spec.actionName}的候选人（可能都已处理过，或集合为空）。`;
  }

  // 「✅ 可定位」只能在**页面真的被读过**时才允许打。原先的判据是「不在 missing 里」，
  // 而页面不可用（僵死 / 不在推荐页 / 核对本身抛错）时 missing 恒为空，于是一个都没核对过的
  // 名单会被整排标成「✅ 当前列表可定位」，再在下面跟一句「页面无法用于打招呼」——
  // 自相矛盾，而且假的那半句在上面、先被读到。这正是本轮要消灭的「什么都没验证却报成功」。
  const verified = verification !== null && verification.pageUsable;
  const missingById = new Map((verification?.missing ?? []).map((m) => [m.id, m]));
  const lines = [
    `【预演 dryRun】将对以下 ${targets.length} 人${spec.actionName}，预计消耗 ${targets.length} 次${spec.quotaNote}：`,
    '',
    ...targets.map((c) => {
      const miss = missingById.get(c.id);
      const mark = miss ? `  ❌ 现在定位不到：${miss.reason}` : verified ? '  ✅ 当前列表可定位' : '';
      return `- ${c.id}. ${c.name}${c.tag ? ` [${c.tag}]` : ''}${mark}`;
    }),
  ];
  if (skipped > 0) {
    lines.push('', `（因 limit 本次跳过 ${skipped} 人，下次可继续）`);
  }

  if (verification && !verification.pageUsable) {
    // 页面本身不可用时不要让人去传 dryRun=false——那只会白等一次超时
    lines.push(
      '',
      `⚠️ 当前页面无法用于${spec.actionName}：${verification.detail ?? '原因未知'}`,
      `现在传 dryRun=false 只会失败。请先修好页面，再重新预演。`,
    );
    return lines.join('\n');
  }

  if (verification) {
    const missing = verification.missing ?? [];
    lines.push(
      '',
      `页面核对：当前列表 ${verification.listSize ?? '?'} 人，可定位 ${targets.length - missing.length}/${targets.length}。`,
    );
    if (missing.length === targets.length) {
      lines.push(
        `⚠️ 这批人在当前列表里**一个都定位不到**，说明推荐列表已经整体换过一批。`,
        `执行只会全部失败且不消耗配额。需要重新调 boss_recommend 读取列表，再对新列表重新筛选。`,
      );
    } else if (missing.length > 0) {
      lines.push(
        `⚠️ 有 ${missing.length} 人已不在当前列表（上面标了 ❌）。执行时这些人会失败且不消耗配额，`,
        `其余 ${targets.length - missing.length} 人可以正常打。`,
      );
    }
  }

  lines.push('', '确认无误后传 dryRun=false 才会真正执行。', spec.precondition);
  return lines.join('\n');
}

export async function runPoolBatch(
  options: PoolBatchOptions,
  spec: PoolBatchSpec,
): Promise<string> {
  const { job, dryRun, signal, onProgress } = options;
  const pool = await requirePool(job);
  const pending = spec.pickTargets(pool);

  const requested = options.limit;
  const effectiveLimit = Math.min(
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : spec.hardLimit,
    spec.hardLimit,
  );
  const targets = pending.slice(0, effectiveLimit);
  const skipped = pending.length - targets.length;

  if (dryRun) {
    // 核对失败不能让预演也失败：预演的价值就是「不花代价地告诉你现状」，
    // 所以核对本身出错时如实带上原因，而不是把整个预演变成一个报错。
    let verification: TargetVerification | null = null;
    if (spec.verifyTargets && targets.length > 0) {
      try {
        verification = await spec.verifyTargets(targets);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        verification = { pageUsable: false, detail: `页面核对未能完成：${msg}` };
      }
    }
    return renderDryRun(spec, job, targets, skipped, verification);
  }
  if (targets.length === 0) {
    return `集合「${job}」没有需要${spec.actionName}的候选人，未执行任何操作。`;
  }

  const results: string[] = [];
  let okCount = 0;
  let failCount = 0;
  let aborted = false;

  for (let i = 0; i < targets.length; i++) {
    const candidate = targets[i]!;
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    try {
      const raw = await spec.execute(candidate, i === 0);
      spec.onSuccess(candidate, raw);
      okCount++;
      results.push(`✅ ${candidate.id}. ${candidate.name}: ${spec.summarize(raw)}`);
    } catch (e) {
      if (isAbortError(e)) {
        aborted = true;
        break;
      }
      const msg = e instanceof Error ? e.message : String(e);
      spec.onFailure(candidate, msg);
      failCount++;
      results.push(`❌ ${candidate.id}. ${candidate.name}: ${truncate(msg)}`);
    }

    // 每人一落盘：中途超时/崩溃也不会重复消耗配额
    await savePool(pool);
    onProgress?.(i + 1, targets.length, candidate.name);

    if (i < targets.length - 1) {
      try {
        await sleepRandom(spec.gapMs.min, spec.gapMs.max, signal);
      } catch {
        aborted = true;
        break;
      }
    }
  }

  await savePool(pool);

  // 让审计日志能看见单人失败。不上报的话这次调用会以 outcome=ok 落盘，
  // 「今天打招呼失败了几次」这个问题就永远查不出来（实测 101 次带失败的批量调用，
  // outcome=error 是 0 次）。
  reportPartialFailures(failCount);

  const remaining = pendingCountAfter(pool, spec.pickTargets);
  const header = aborted
    ? `${spec.actionName}批量被中断（已处理 ${okCount + failCount}/${targets.length}）：成功 ${okCount}，失败 ${failCount}`
    : `${spec.actionName}批量完成（${targets.length} 人）：成功 ${okCount}，失败 ${failCount}`;

  const lines = [header, '', ...results];
  if (skipped > 0) {
    lines.push('', `因 limit 本次未处理 ${skipped} 人。`);
  }
  lines.push(`集合「${job}」仍有 ${remaining} 人待${spec.actionName}。`);
  if (failCount > 0) {
    lines.push('失败者状态未被标记为已完成，修好前置条件后可再次调用继续；失败原因已记录在集合里。');
  }
  return lines.join('\n');
}
