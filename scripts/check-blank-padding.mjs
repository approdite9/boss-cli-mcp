#!/usr/bin/env node
/**
 * 空行填充体检 —— 阻止「一行代码之间夹几十行空行」的文件再次进入仓库。
 *
 * 为什么需要：`src/common/behavior_enhance.ts` 曾经是 18332 行、其中 17994 行是空行
 * （每两行真实代码之间被塞进 51 个空行）。这种文件 review 时翻不动、grep 出来的行号
 * 全是误导、AI 读取时按行截断只能拿到空白，问题极难被发现——它本身不报错，只是让
 * 所有后续排查变慢。历史上 `3aee0f0` 修过 `cdp_browser.ts` 的同类问题，但漏了这个文件，
 * 说明靠人眼盯不住，必须有一道机械检查。
 *
 * 判定规则（只抓「极端」情况，不做代码风格警察）：
 *   1. 连续空行 >= MAX_CONSECUTIVE_BLANK 行
 *   2. 文件行数 >= MIN_LINES_FOR_RATIO 且空行占比 >= MAX_BLANK_RATIO
 * 正常代码里连续 2 个空行、Markdown 里 25% 左右的空行都不会触发。
 *
 * 用法：`node scripts/check-blank-padding.mjs`（已挂在 npm run build 之前）。
 * 退出码 1 = 发现问题，输出文件、行号区间与实际数值，便于直接定位。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 只扫我们自己写的源码与文档；构建产物、依赖、抓取的线上 JS 快照不算。 */
const SCAN_DIRS = ['src', 'scripts', 'skills', '.github'];
const SCAN_FILES_IN_ROOT = ['AGENTS.md', 'DEPLOY.md'];
const SCAN_EXTENSIONS = ['.ts', '.mjs', '.js', '.json', '.md', '.cmd', '.ps1', '.vbs', '.yml', '.yaml'];
/** 线上 JS 研究快照是原样保存的第三方代码，不能按我们的规矩改。 */
const EXCLUDE_PATH_PARTS = [`docs${sep}research`, 'node_modules', `${sep}dist${sep}`];

const MAX_CONSECUTIVE_BLANK = 5;
const MIN_LINES_FOR_RATIO = 200;
const MAX_BLANK_RATIO = 0.5;

function shouldSkip(absPath) {
  return EXCLUDE_PATH_PARTS.some((part) => absPath.includes(part));
}

function collect(absDir, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name);
    if (shouldSkip(abs)) continue;
    if (entry.isDirectory()) {
      collect(abs, out);
    } else if (SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(abs);
    }
  }
}

/** 返回该文件的违规说明数组（空数组 = 合规）。 */
function inspect(absPath) {
  const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
  const problems = [];

  let run = 0;
  let runStart = 0;
  let worstRun = 0;
  let worstRunStart = 0;
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      blank++;
      if (run === 0) runStart = i;
      run++;
      if (run > worstRun) {
        worstRun = run;
        worstRunStart = runStart;
      }
    } else {
      run = 0;
    }
  }

  if (worstRun >= MAX_CONSECUTIVE_BLANK) {
    problems.push(
      `连续 ${worstRun} 行空行（第 ${worstRunStart + 1}-${worstRunStart + worstRun} 行），上限 ${MAX_CONSECUTIVE_BLANK}`,
    );
  }
  if (lines.length >= MIN_LINES_FOR_RATIO && blank / lines.length >= MAX_BLANK_RATIO) {
    problems.push(
      `空行占比 ${(100 * blank / lines.length).toFixed(1)}%（${blank}/${lines.length}），上限 ${100 * MAX_BLANK_RATIO}%`,
    );
  }
  return problems;
}

const files = [];
for (const dir of SCAN_DIRS) {
  const abs = join(REPO_ROOT, dir);
  try {
    if (statSync(abs).isDirectory()) collect(abs, files);
  } catch {
    /* 目录不存在则跳过 */
  }
}
for (const name of SCAN_FILES_IN_ROOT) {
  const abs = join(REPO_ROOT, name);
  try {
    if (statSync(abs).isFile()) files.push(abs);
  } catch {
    /* 文件不存在则跳过 */
  }
}

let failed = 0;
for (const abs of files) {
  const problems = inspect(abs);
  if (problems.length === 0) continue;
  failed++;
  console.error(`✗ ${relative(REPO_ROOT, abs)}`);
  for (const p of problems) {
    console.error(`    ${p}`);
  }
}

if (failed > 0) {
  console.error(
    `\n发现 ${failed} 个文件存在空行填充。请删掉填充空行后重试`
      + `（这类文件会让 review、grep 行号与按行读取全部失真）。`,
  );
  process.exit(1);
}

console.log(`空行填充体检通过：已扫描 ${files.length} 个文件。`);
