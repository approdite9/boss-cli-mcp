/**
 * MCP 入口的环境变量加载。
 *
 * 为什么不能照抄 CLI：CLI 的工作目录就是用户的项目目录，`loadEnv()` 读 CWD 下的 `.env` 天然可用。
 * 但 MCP server 是被客户端当子进程拉起的，**CWD 由客户端决定**（Claude Desktop 常是应用目录或系统目录），
 * 项目里的 `.env` 基本读不到。用户配了却不生效、还查不出原因，是首次使用最容易踩的坑之一。
 *
 * 对策：
 * 1. 多候选路径：显式指定 > 用户级 > 安装目录（git checkout 的项目根）> CWD。
 * 2. 把「实际读了哪些、跳过了哪些、当前 CWD 是什么」打到 stderr，让问题一眼可见。
 *
 * 优先级说明：dotenv 默认 **不覆盖** 已存在的 `process.env`，因此**先加载的胜出**，
 * 候选顺序即优先级顺序。客户端配置里 `env` 传入的值优先级最高（进程启动时就在 env 里）。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

export type EnvCandidate = {
  /** 绝对路径 */
  path: string;
  /** 来源说明，用于日志 */
  source: string;
};

export type ResolveEnvOptions = {
  /** `~/.boss-cli` */
  appHome: string;
  /** 安装目录 / 代码仓库根目录 */
  packageRoot: string;
  /** 进程当前工作目录 */
  cwd: string;
  /** `BOSS_MCP_ENV_FILE` 的值（可为空） */
  explicit?: string;
};

/**
 * 按优先级产出候选 `.env` 路径列表（已去重，同一绝对路径只保留优先级最高的那条）。
 * 纯函数，不接触文件系统，便于单测。
 */
export function resolveEnvCandidates(options: ResolveEnvOptions): EnvCandidate[] {
  const raw: EnvCandidate[] = [];

  const explicit = options.explicit?.trim();
  if (explicit) {
    raw.push({ path: resolve(explicit), source: 'BOSS_MCP_ENV_FILE' });
  }
  raw.push({ path: resolve(join(options.appHome, '.env')), source: '用户级 ~/.boss-cli/.env' });
  raw.push({ path: resolve(join(options.packageRoot, '.env')), source: '安装目录 .env' });
  raw.push({ path: resolve(join(options.cwd, '.env')), source: '当前工作目录 .env' });

  const seen = new Set<string>();
  const out: EnvCandidate[] = [];
  for (const candidate of raw) {
    const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** 本模块所在包的根目录（`dist/mcp/env.js` → 上两级） */
export function packageRootDir(): string {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

export type EnvLoadReport = {
  loaded: EnvCandidate[];
  missing: EnvCandidate[];
  cwd: string;
};

/** 依次加载存在的候选文件（先加载者优先），返回加载报告用于日志 */
export function loadMcpEnv(appHome: string): EnvLoadReport {
  const cwd = process.cwd();
  const candidates = resolveEnvCandidates({
    appHome,
    packageRoot: packageRootDir(),
    cwd,
    explicit: process.env.BOSS_MCP_ENV_FILE,
  });

  const loaded: EnvCandidate[] = [];
  const missing: EnvCandidate[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      missing.push(candidate);
      continue;
    }
    loadEnv({ path: candidate.path, quiet: true });
    loaded.push(candidate);
  }
  return { loaded, missing, cwd };
}

/** 把加载报告渲染成 stderr 日志（多行） */
export function formatEnvLoadReport(report: EnvLoadReport): string {
  const lines: string[] = [`[boss-mcp] 工作目录（由 MCP 客户端决定）：${report.cwd}`];
  if (report.loaded.length === 0) {
    lines.push(
      '[boss-mcp] 未加载任何 .env 文件。若你配置过 BOSS_BAIDU_* / CHROME_PATH 等变量却不生效，',
      '[boss-mcp]   请写到 ~/.boss-cli/.env，或用 BOSS_MCP_ENV_FILE 指向绝对路径，或直接写进 MCP 客户端配置的 env 里。',
    );
  } else {
    for (const c of report.loaded) {
      lines.push(`[boss-mcp] 已加载 .env：${c.path}（${c.source}）`);
    }
  }
  return lines.join('\n');
}
