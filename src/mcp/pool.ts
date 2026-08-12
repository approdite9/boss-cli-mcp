/**
 * 候选人集合（pool）：MCP 层新增的**有状态**工作台。
 *
 * 定位：LLM 负责解析 JD 与阅读搜索结果，pool 负责「存下来、可增删、可标记、可批量执行」。
 * 持久化到 `~/.boss-cli/.cache/pool/<岗位>.json`，跨 tool 调用、跨进程重启都保留。
 *
 * 设计要点：
 * - 文件名从 LLM 传入的 job 派生，必须做严格净化 + 落地路径包含性校验（防目录穿越）。
 * - 写入用「临时文件 + rename」，批量打招呼过程中每人落盘一次，中途崩溃不会写坏文件。
 * - 读取时对 JSON 做规范化：文档鼓励用户手改这个文件，字段缺失/类型不对不能让 server 崩。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { CACHE_DIR } from '../config.js';

export const POOL_DIR = join(CACHE_DIR, 'pool');

export interface PoolCandidate {
  id: number;
  name: string;
  matchReason?: string;
  tag?: string;
  greeted: boolean;
  /** 打招呼成功时间（ISO） */
  greetedAt?: string;
  /** 最近一次打招呼失败原因；成功后清空 */
  lastError?: string;
  /** 缓存的候选人细节（在线简历截图路径 + OCR 正文）——避免重复消耗简历查看配额 */
  detail?: string;
  /** detail 抓取时间（ISO） */
  detailAt?: string;
  /** 最近一次抓简历失败原因；成功后清空 */
  lastDetailError?: string;
}

export interface PoolCriteria {
  core: string[];
  bonus: string[];
}

export interface Pool {
  job: string;
  criteria: PoolCriteria;
  createdAt: string;
  updatedAt?: string;
  candidates: PoolCandidate[];
}

/** Windows 保留设备名，不能作为文件名主体 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 把 job 名净化成安全的文件名主体。job 来自 LLM，必须假定不可信：
 * 去掉路径分隔符与 Windows 非法字符、控制字符、首尾点与空格，限长，避开保留名。
 */
function safeFileBase(job: string): string {
  const cleaned = job
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 80);

  if (!cleaned) {
    throw new Error('❌ 岗位名（job）为空或只含非法字符，无法作为集合名。');
  }
  if (WINDOWS_RESERVED_NAMES.has(cleaned.toLowerCase())) {
    return `_${cleaned}`;
  }
  return cleaned;
}

/** 集合文件绝对路径；额外校验结果仍在 POOL_DIR 内（防穿越兜底） */
export function poolPath(job: string): string {
  const base = safeFileBase(job);
  const full = resolve(join(POOL_DIR, `${base}.json`));
  const root = resolve(POOL_DIR);
  if (!isAbsolute(full) || (full !== root && !full.startsWith(root + sep))) {
    throw new Error(`❌ 非法的岗位名（job）：${job}`);
  }
  return full;
}

async function ensurePoolDir(): Promise<void> {
  if (!existsSync(POOL_DIR)) {
    await mkdir(POOL_DIR, { recursive: true });
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : String(x ?? '')))
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function optText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** 容忍手改/旧版本文件：缺字段补默认，脏数据丢弃，id 冲突或缺失时重新分配 */
function normalizePool(raw: unknown, job: string): Pool {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const criteriaRaw = (obj.criteria && typeof obj.criteria === 'object' ? obj.criteria : {}) as Record<string, unknown>;

  const seenIds = new Set<number>();
  const candidatesRaw = Array.isArray(obj.candidates) ? obj.candidates : [];
  const candidates: PoolCandidate[] = [];
  let maxId = 0;

  for (const item of candidatesRaw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const name = optText(c.name);
    if (!name) continue;

    const rawId = typeof c.id === 'number' ? c.id : Number(c.id);
    let id = Number.isInteger(rawId) && rawId > 0 ? rawId : 0;
    if (id === 0 || seenIds.has(id)) {
      id = 0; // 稍后统一补号
    } else {
      seenIds.add(id);
      maxId = Math.max(maxId, id);
    }

    candidates.push({
      id,
      name,
      matchReason: optText(c.matchReason),
      tag: optText(c.tag) ?? '',
      greeted: c.greeted === true,
      greetedAt: optText(c.greetedAt),
      lastError: optText(c.lastError),
      detail: optText(c.detail),
      detailAt: optText(c.detailAt),
      lastDetailError: optText(c.lastDetailError),
    });
  }

  for (const c of candidates) {
    if (c.id === 0) {
      c.id = ++maxId;
      seenIds.add(c.id);
    }
  }

  return {
    job: optText(obj.job) ?? job,
    criteria: {
      core: asStringArray(criteriaRaw.core),
      bonus: asStringArray(criteriaRaw.bonus),
    },
    createdAt: optText(obj.createdAt) ?? new Date().toISOString(),
    updatedAt: optText(obj.updatedAt),
    candidates,
  };
}

export async function loadPool(job: string): Promise<Pool | null> {
  const path = poolPath(job);
  if (!existsSync(path)) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`❌ 读取集合文件失败：${path}（${msg}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`❌ 集合文件不是合法 JSON，请修复或删除：${path}`);
  }
  return normalizePool(parsed, job);
}

/** 必须存在，否则抛出带指引的错误（供各 pool_* 工具复用） */
export async function requirePool(job: string): Promise<Pool> {
  const pool = await loadPool(job);
  if (!pool) {
    throw new Error(`❌ 集合「${job}」不存在。请先用 pool_add 建立集合（pool_list 可查看已有集合）。`);
  }
  return pool;
}

/** 临时文件 + rename 原子落盘：批量执行中途崩溃不会留下半个 JSON */
export async function savePool(pool: Pool): Promise<void> {
  await ensurePoolDir();
  const path = poolPath(pool.job);
  const tmp = `${path}.tmp`;
  pool.updatedAt = new Date().toISOString();
  await writeFile(tmp, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export type PoolAddResult = {
  pool: Pool;
  added: string[];
  duplicated: string[];
};

/**
 * 加入候选人：按姓名去重，自动分配递增 id。
 * criteria 只在显式传入且非空时更新，避免一次不带条件的 pool_add 把已存条件擦掉。
 */
export async function poolAdd(
  job: string,
  incoming: Array<{ name: string; matchReason?: string }>,
  criteria?: Partial<PoolCriteria>,
): Promise<PoolAddResult> {
  const now = new Date().toISOString();
  const pool: Pool =
    (await loadPool(job)) ??
    { job, criteria: { core: [], bonus: [] }, createdAt: now, candidates: [] };

  if (criteria?.core && criteria.core.length > 0) {
    pool.criteria.core = criteria.core;
  }
  if (criteria?.bonus && criteria.bonus.length > 0) {
    pool.criteria.bonus = criteria.bonus;
  }

  const byName = new Map(pool.candidates.map((c) => [c.name, c]));
  let nextId = pool.candidates.reduce((m, c) => Math.max(m, c.id), 0) + 1;
  const added: string[] = [];
  const duplicated: string[] = [];

  for (const raw of incoming) {
    const name = (raw?.name ?? '').trim();
    if (!name) continue;
    const existing = byName.get(name);
    if (existing) {
      // 已在集合里：只补齐缺失的匹配理由，不覆盖人工编辑过的内容
      const reason = (raw.matchReason ?? '').trim();
      if (reason && !existing.matchReason) {
        existing.matchReason = reason;
      }
      duplicated.push(name);
      continue;
    }
    const c: PoolCandidate = {
      id: nextId++,
      name,
      matchReason: (raw.matchReason ?? '').trim() || undefined,
      tag: '',
      greeted: false,
    };
    pool.candidates.push(c);
    byName.set(name, c);
    added.push(name);
  }

  await savePool(pool);
  return { pool, added, duplicated };
}

export function findCandidate(pool: Pool, id: number): PoolCandidate | undefined {
  return pool.candidates.find((c) => c.id === id);
}

export function pendingCandidates(pool: Pool): PoolCandidate[] {
  return pool.candidates.filter((c) => !c.greeted);
}

/** 尚未抓到简历细节的候选人（批量抓简历的默认目标） */
export function candidatesWithoutDetail(pool: Pool): PoolCandidate[] {
  return pool.candidates.filter((c) => !c.detail);
}

/** 批量执行后还剩多少待处理，选择器由调用方给出 */
export function pendingCountAfter(
  pool: Pool,
  pick: (pool: Pool) => PoolCandidate[],
): number {
  return pick(pool).length;
}

function renderCandidateLine(c: PoolCandidate): string {
  const bits = [`${c.id}. ${c.name}`];
  if (c.tag) bits.push(`[${c.tag}]`);
  if (c.greeted) bits.push('✅已打招呼');
  if (c.detail) bits.push('📄有细节');
  if (!c.greeted && c.lastError) bits.push(`⚠️上次失败`);
  const head = bits.join(' ');
  return c.matchReason ? `${head} — ${c.matchReason}` : head;
}

export function renderPool(pool: Pool): string {
  const total = pool.candidates.length;
  const greeted = pool.candidates.filter((c) => c.greeted).length;
  const lines: string[] = [
    `集合「${pool.job}」共 ${total} 人（已打招呼 ${greeted}，待打招呼 ${total - greeted}）`,
  ];
  if (pool.criteria.core.length > 0) {
    lines.push(`核心要求：${pool.criteria.core.join(' / ')}`);
  }
  if (pool.criteria.bonus.length > 0) {
    lines.push(`加分项：${pool.criteria.bonus.join(' / ')}`);
  }
  lines.push(`文件：${poolPath(pool.job)}`);
  if (total === 0) {
    lines.push('', '（集合为空）');
    return lines.join('\n');
  }
  lines.push('', ...pool.candidates.map(renderCandidateLine));
  const failed = pool.candidates.filter((c) => !c.greeted && c.lastError);
  if (failed.length > 0) {
    lines.push('', '上次打招呼失败的候选人：');
    lines.push(...failed.map((c) => `- ${c.name}: ${c.lastError}`));
  }
  return lines.join('\n');
}

/** 列出所有已存在的集合（用于 pool_list 不传 job 时） */
export async function listAllPools(): Promise<string> {
  if (!existsSync(POOL_DIR)) {
    return '尚无任何候选人集合。用 pool_add 创建第一个。';
  }
  const files = (await readdir(POOL_DIR)).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    return '尚无任何候选人集合。用 pool_add 创建第一个。';
  }
  const rows: string[] = [];
  for (const file of files.sort()) {
    const job = file.slice(0, -'.json'.length);
    try {
      const pool = await loadPool(job);
      if (!pool) continue;
      const total = pool.candidates.length;
      const greeted = pool.candidates.filter((c) => c.greeted).length;
      rows.push(`- ${pool.job}：${total} 人（待打招呼 ${total - greeted}）`);
    } catch (e) {
      rows.push(`- ${job}：读取失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return [`共 ${rows.length} 个集合：`, ...rows, '', '用 pool_list({job}) 查看某个集合明细。'].join('\n');
}

export async function poolRemove(job: string, ids: number[]): Promise<string> {
  const pool = await requirePool(job);
  const wanted = new Set(ids);
  const removed = pool.candidates.filter((c) => wanted.has(c.id));
  const missing = ids.filter((id) => !pool.candidates.some((c) => c.id === id));
  pool.candidates = pool.candidates.filter((c) => !wanted.has(c.id));
  await savePool(pool);

  const lines = [
    `已从「${job}」删除 ${removed.length} 人，剩 ${pool.candidates.length} 人。`,
  ];
  if (removed.length > 0) {
    lines.push(`删除：${removed.map((c) => `${c.id}.${c.name}`).join('、')}`);
  }
  if (missing.length > 0) {
    lines.push(`⚠️ 未找到 id：${missing.join('、')}`);
  }
  return lines.join('\n');
}

export async function poolMark(job: string, id: number, tag: string): Promise<string> {
  const pool = await requirePool(job);
  const c = findCandidate(pool, id);
  if (!c) {
    throw new Error(`❌ 集合「${job}」中未找到 id=${id}。用 pool_list 查看当前序号。`);
  }
  const next = tag.trim();
  c.tag = next;
  await savePool(pool);
  return next ? `已标记 ${c.name} 为「${next}」。` : `已清除 ${c.name} 的标记。`;
}

export async function poolClear(job: string): Promise<string> {
  const pool = await requirePool(job);
  const before = pool.candidates.length;
  pool.candidates = [];
  await savePool(pool);
  return `已清空集合「${job}」，移除 ${before} 人（岗位条件与文件保留）。`;
}

export const POOL_EXPORT_DIR = join(POOL_DIR, 'exports');

/**
 * 把集合导出成一个 Markdown 文件（含已抓到的简历正文），落到 `~/.boss-cli/.cache/pool/exports/`。
 * 这才是「批量下载」最终能交到手里的东西：一份可直接阅读/归档的文件，而不是散落的 PNG。
 */
export async function poolExportMarkdown(
  job: string,
  options: { includeDetail?: boolean; onlyWithDetail?: boolean } = {},
): Promise<{ path: string; total: number; withDetail: number }> {
  const pool = await requirePool(job);
  const includeDetail = options.includeDetail !== false;
  const rows = options.onlyWithDetail
    ? pool.candidates.filter((c) => c.detail)
    : pool.candidates;

  const withDetail = rows.filter((c) => c.detail).length;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = safeFileBase(job);

  const lines: string[] = [
    `# 候选人集合：${pool.job}`,
    '',
    `- 导出时间：${new Date().toISOString()}`,
    `- 候选人数：${rows.length}（含简历正文 ${withDetail}）`,
  ];
  if (pool.criteria.core.length > 0) {
    lines.push(`- 核心要求：${pool.criteria.core.join(' / ')}`);
  }
  if (pool.criteria.bonus.length > 0) {
    lines.push(`- 加分项：${pool.criteria.bonus.join(' / ')}`);
  }
  lines.push('');

  lines.push('## 名单速览', '', '| id | 姓名 | 标记 | 已打招呼 | 有简历 | 匹配理由 |', '| --- | --- | --- | --- | --- | --- |');
  for (const c of rows) {
    const reason = (c.matchReason ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| ${c.id} | ${c.name} | ${c.tag || ''} | ${c.greeted ? '是' : ''} | ${c.detail ? '是' : ''} | ${reason} |`,
    );
  }
  lines.push('');

  if (includeDetail) {
    lines.push('## 简历明细', '');
    for (const c of rows) {
      lines.push(`### ${c.id}. ${c.name}${c.tag ? `（${c.tag}）` : ''}`, '');
      if (c.matchReason) lines.push(`- 匹配理由：${c.matchReason}`);
      if (c.greeted) lines.push(`- 已打招呼${c.greetedAt ? `：${c.greetedAt}` : ''}`);
      if (c.lastError) lines.push(`- 上次打招呼失败：${c.lastError}`);
      if (c.lastDetailError) lines.push(`- 上次抓简历失败：${c.lastDetailError}`);
      lines.push('');
      if (c.detail) {
        lines.push(`简历内容${c.detailAt ? `（抓取于 ${c.detailAt}）` : ''}：`, '', '```text', c.detail, '```', '');
      } else {
        lines.push('_尚未抓取简历（可用 pool_batch_resume 批量抓取）_', '');
      }
    }
  }

  if (!existsSync(POOL_EXPORT_DIR)) {
    await mkdir(POOL_EXPORT_DIR, { recursive: true });
  }
  const path = join(POOL_EXPORT_DIR, `${base}-${stamp}.md`);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return { path, total: rows.length, withDetail };
}

export function renderCandidateDetail(pool: Pool, c: PoolCandidate): string {
  const lines = [
    `集合「${pool.job}」候选人 ${c.id}. ${c.name}`,
    `标记：${c.tag || '（无）'}`,
    `打招呼：${c.greeted ? `已打招呼${c.greetedAt ? `（${c.greetedAt}）` : ''}` : '未打招呼'}`,
  ];
  if (c.matchReason) {
    lines.push(`匹配理由：${c.matchReason}`);
  }
  if (c.lastError) {
    lines.push(`最近失败原因：${c.lastError}`);
  }
  if (c.detail) {
    lines.push('', `已缓存细节${c.detailAt ? `（抓取于 ${c.detailAt}）` : ''}：`, '', c.detail);
  } else {
    lines.push(
      '',
      '尚无细节。需要在线简历时传 preview=true（⚠️ 会消耗每日简历查看配额，且要求浏览器当前已在推荐/深搜/常规搜索页且列表已加载）。',
    );
  }
  return lines.join('\n');
}
