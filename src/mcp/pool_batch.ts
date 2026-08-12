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
): string {
  if (targets.length === 0) {
    return `集合「${job}」没有需要${spec.actionName}的候选人（可能都已处理过，或集合为空）。`;
  }
  const lines = [
    `【预演 dryRun】将对以下 ${targets.length} 人${spec.actionName}，预计消耗 ${targets.length} 次${spec.quotaNote}：`,
    '',
    ...targets.map((c) => `- ${c.id}. ${c.name}${c.tag ? ` [${c.tag}]` : ''}`),
  ];
  if (skipped > 0) {
    lines.push('', `（因 limit 本次跳过 ${skipped} 人，下次可继续）`);
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
    return renderDryRun(spec, job, targets, skipped);
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
