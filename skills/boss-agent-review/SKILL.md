---
name: boss-agent-review
display_name: Boss Agent 预筛选
description: "基于JD自动筛选Boss直聘推荐候选人，三阶漏斗（标签初筛→简历精筛→HR确认），最终批量打招呼。适用于用户说 /boss_agent_review、预筛选、自动筛选、帮我筛、智能招聘等场景。"
icon: "🎯"
trigger: /boss_agent_review 预筛选 自动筛选 帮我筛 智能招聘
inputs:
  - name: greet_limit
    description: "本次打招呼上限（单次调用硬上限 50）"
    type: number
    default: 50
id: bd6c3a901e34474e9a8d4a4905e47d02
---

## Overview

三阶漏斗：读 JD → 加载推荐列表 → Stage 1 标签初筛（宽松）→ 入库到候选人集合 → Stage 2 批量抓简历 + AI 精筛 → Stage 3 导出报告给 HR 确认 → Stage 4 批量打招呼。

**核心约束：简历查看和打招呼都消耗不可逆的平台配额。** 这不是"能省则省"的优化，而是流程设计的主要约束——见下方配额一节。

## 配额（先读这一节）

| 动作 | 工具 | 配额 | 单次硬上限 |
|------|------|------|-----------|
| 看在线简历 | `boss_preview_resume` / `pool_batch_resume` | **消耗每日在线简历查看次数** | 批量 20 人/次 |
| 打招呼 | `boss_greet` / `pool_greet_all` | **消耗打招呼次数** | 批量 50 人/次 |
| 读列表 / 读 JD / 集合操作 | `boss_recommend`、`boss_list_positions`、`boss_get_jd`、`pool_add/list/remove/mark/export` | 不消耗 | — |

两个批量工具 **`dryRun` 默认为 `true`**，只返回将要处理的名单而不真执行；**必须显式传 `dryRun: false`** 才会动手。每处理一个人立即落盘，中断后重跑会自动跳过已完成的，不会重复扣配额。

⚠️ 不要自己写等待/sleep。MCP 层已在相邻浏览器调用间插入 1.8-5s 随机间隔，批量工具内部另有 3-8s（打招呼）/ 4-9s（简历）间隔。额外叠加只会让流程变慢。

## Prerequisites

需要以下 MCP 工具（工具名前缀随客户端而异，本文按裸名书写）：

```
boss_list_positions, boss_get_jd, boss_recommend
pool_add, pool_list, pool_get_detail, pool_remove, pool_mark
pool_batch_resume, pool_greet_all, pool_export
```

浏览器需已登录 Boss。若工具返回「未登录」或「未出现侧栏 .menu-list」，请用户在服务所在机器的终端执行 `boss login` 扫码。

## ⚠️ 页面前置条件与顺序

`pool_batch_resume` / `pool_greet_all` / `boss_preview_resume` / `boss_greet` **要求浏览器当前已在「推荐」`/web/chat/recommend` 或「深度搜索」`/web/chat/aiform` 页且列表已加载，它们不会自动跳转**。而 `boss_list_positions` / `boss_get_jd` 会离开推荐页。

因此顺序是死的：

```
boss_list_positions → boss_get_jd → boss_recommend → 之后不再离开推荐页
```

`pool_*` 里除了 `pool_batch_resume` / `pool_greet_all` / `pool_get_detail(preview=true)`，其余都是纯本地文件操作，不碰浏览器，任何时候都能调。

## ⚠️ `boss_recommend` 返回数据的局限性

它通过 DOM 抓卡片，**没有 `count` 参数**（只接受可选的 `jobKeyword`），返回的是当前页面已加载的那些人。且卡片信息不完整：

| 维度 | 工具返回 | 影响 |
|------|---------|------|
| 姓名/年龄/应届年/学历/活跃状态 | ✅ | — |
| 期望城市+方向、薪资、优势标签 | ✅ | — |
| **院校名称** | ❌ 缺失 | 无法判断院校层次 |
| **专业** | ❌ 缺失 | 无法判断专业匹配度 |
| **实习/工作经历** | ❌ 缺失 | 无法判断实际经验 |
| 部分技能标签 | ⚠️ 不全 | 标签不完整 |

**策略后果**：Stage 1 初筛必须极度保守——**仅排除方向明确矛盾的**，其余放行。不要基于缺失的院校/专业/经历做任何推断。真正的判断在 Stage 2 用简历做。

## ⚠️ 去重规则（严格多字段匹配）

返回结果中候选人可能重复。**不得仅凭姓名去重**（同名很常见）。以下字段**全部相同**才算重复：

姓名 + 年龄 + 学历 + 应届年份 + 期望方向 + 薪资

任一字段不同即视为不同的人，两条都保留。

## Workflow

### Step 1: 岗位 + JD
- **Mode**: `deterministic`
- **Validate**: 至少 1 个岗位

1. `boss_list_positions()` 取在招岗位
2. 展示给用户确认目标岗位（只有 1 个则直接用）
3. `boss_get_jd(name=岗位名)` 取完整 JD
4. 从 JD 拆出**核心要求**与**加分项**两组（后面 `pool_add` 要用）

### Step 2: 加载推荐列表
- **Mode**: `deterministic`
- **Validate**: 去重后 > 0 人

1. `boss_recommend(jobKeyword=可选岗位关键字)`
2. 按严格多字段规则去重
3. 报告：`已加载 N 条，去重后 M 人`

⚠️ **从此刻起不再调用任何会离开推荐页的工具。**

### Step 3: Stage 1 — 标签初筛（宽松）
- **Mode**: `agentic`
- **Validate**: 通过率应 ≥ 80%

**只做"明确排除"，不做"模糊判断"。**

仅在以下情况排除：
- 期望方向与 JD **明确矛盾**（JD 要 Python/AI/后端，候选人写「产品经理」/「UI 设计」/「市场营销」）
- 已有同事沟通过 **且** 优势标签毫无亮点

**不得排除**：
- 方向写「互联网（行业）」「后端开发」等宽泛表述 → 放行看简历
- 薪资偏高 → 标注 ⚠️ 但不排除
- 标签少 / 无优势标签 → 可能只是卡片没填完
- 方向相关但不完全匹配（Java 对 Python 岗）→ 技术可迁移，放行

### Step 4: 入库到候选人集合
- **Mode**: `deterministic`
- **Output**: 持久化的候选人集合

把初筛通过的人一次性入库：

```
pool_add(
  job="岗位名",
  candidates=[{name:"张三", matchReason:"初筛通过：期望方向与JD一致"}, ...],
  core=["JD 核心要求1", "核心要求2"],
  bonus=["加分项1", "加分项2"]
)
```

集合落在 `~/.boss-cli/.cache/pool/`，**跨调用、跨进程重启都不丢**。这是后续所有批量操作的工作台，也是断点续跑的依据。

`matchReason` 要写清为什么放行，方便 HR 审核时回溯。

### Step 5: Stage 2 — 批量抓简历（消耗配额）
- **Mode**: `agentic`
- **Validate**: 至少 1 份简历抓到

⚠️ **这一步开始消耗每日在线简历查看次数。**

1. 先预演，确认名单和人数：
   ```
   pool_batch_resume(job="岗位名")        // dryRun 默认 true
   ```
2. 把将要抓取的人数告知用户，**等用户确认**
3. 确认后执行：
   ```
   pool_batch_resume(job="岗位名", dryRun=false, limit=不超过20)
   ```
4. 人数超过 20 就分多次调用；每次之间把进度报给用户，让他有机会中止

抓到的截图路径与 OCR 正文自动缓存进集合。之后 `pool_get_detail` / `pool_export` 直接读缓存，**不会再次消耗配额**（除非显式传 `refresh=true`）。

抓完对每人做 AI 评估：院校层次、专业匹配度、真实项目经验（vs 课程作业）、技术栈深度、实习经历质量、论文/竞赛、与 JD 核心要求的匹配度。

用 `pool_mark` 把结论标进集合：

```
pool_mark(job="岗位名", id=3, tag="🌟强烈推荐")
pool_mark(job="岗位名", id=7, tag="⭐建议考虑")
```

明显不符的用 `pool_remove(job=..., ids=[...])` 剔除，并在汇报里给出理由。

### Step 6: Stage 3 — 导出报告
- **Mode**: `deterministic`

```
pool_export(job="岗位名", includeDetail=true)
```

返回绝对路径（落在 `~/.boss-cli/.cache/pool/exports/`），内含名单速览表 + 每人简历正文。把路径给用户，并在对话里贴一份分级摘要：

```
漏斗：加载 N 条 → 去重 X 人 → 初筛 M 人 → 抓简历 K 人 → 推荐 P 人
🌟 强烈推荐 A 人 / ⭐ 建议考虑 B 人 / ❌ 已剔除 C 人
报告：<pool_export 返回的路径>
```

### Step 7: HR 确认
- **Mode**: `agentic`
- **Validate**: 用户明确回复

```
已筛出 P 人推荐，报告已生成。打招呼上限 {{greet_limit}} 人（单次调用硬上限 50）。
打招呼会消耗平台配额且不可撤销，请确认：
- "全部打招呼"
- "只打 1,3,5"        → 我会先 pool_remove 掉其余的
- "去掉 2,4"          → 我会 pool_remove 这两个
- "看某人简历 3"      → pool_get_detail(job, id=3)（读缓存，不消耗配额）
- "调整标准: xxx"     → 重新评估
```

`pool_greet_all` 只对集合里**尚未打过招呼**的人操作，所以用 `pool_remove` 把不要的人剔除掉，比维护一份单独名单更可靠。

### Step 8: Stage 4 — 批量打招呼（消耗配额）
- **Mode**: `agentic`

1. 预演：
   ```
   pool_greet_all(job="岗位名")           // dryRun 默认 true
   ```
2. 把名单和人数复述给用户，**再次确认**
3. 执行：
   ```
   pool_greet_all(job="岗位名", dryRun=false, limit={{greet_limit}})
   ```

工具内部逐个间隔 3-8 秒、每成功一个立即落盘。人数较多时整个调用可能持续数分钟，属正常。中断后再调会自动跳过已打过的人。

`jobKeyword` 只在第一个候选人前切换一次岗位，批量过程中不重复切换（切岗位会重置深搜匹配结果）。

### Step 9: 汇总

```
漏斗：加载 N → 去重 X → 初筛 M → 抓简历 K → HR 确认 P → 打招呼成功 A / 失败 B
集合文件：~/.boss-cli/.cache/pool/<岗位名>.json
报告：<导出路径>
建议后续到「沟通」页看回复（boss_list_candidates --unread）。
```

## Output

- 候选人集合：`~/.boss-cli/.cache/pool/<岗位名>.json`（含简历正文缓存，持久保存）
- 导出报告：`pool_export` 返回的绝对路径
- 对话中的实时进度 + 最终汇总

## Lessons Learned

### Do
- **Step 1 先取岗位+JD**，因为进入推荐页后就不能再离开
- **去重严格多字段匹配**：姓名+年龄+学历+应届年+期望方向+薪资 全部相同才合并
- **初筛极度保守**：卡片缺院校/专业/经历，只排除方向明确矛盾的，其余放行到 Stage 2
- **Stage 2 才是真正的筛选关口**，所有实质判断都在有简历之后做
- **两个批量工具一律先 dryRun 一次**，把名单和人数给用户看过再执行
- **用 `pool_mark` / `pool_remove` 维护结论**，别在对话里手工维护名单——集合是持久的，对话上下文会丢
- 活跃优先：「刚刚活跃」「在线」的候选人回复率显著更高

### Don't
- **不要给 `boss_recommend` 传 `count`** —— 它没有这个参数，`additionalProperties: false` 会直接拒掉
- **不要以为简历可以随便看** —— 每次都扣每日在线简历查看次数
- **不要漏掉 `dryRun: false`** —— 漏了就只是预演，什么都不会发生；反过来，没经用户确认就传 `false` 是在花别人的额度
- **不要自己加 sleep** —— MCP 层和批量工具内部都已有随机间隔
- **不要仅凭姓名去重**
- **不要在初筛中推断缺失信息** —— 看不到院校就不要猜
- **不要在 `boss_recommend` 之后调 `boss_list_positions` / `boss_get_jd`** —— 会离开推荐页，后续批量工具的前置条件不再满足
- 不要单次超过硬上限（简历 20 / 打招呼 50），超了就分批并逐批汇报

### Common Failures
- 「未在列表中找到候选人：X」 —— 该候选人不在当前推荐列表里（滚动后 DOM 回收，或姓名不完全一致）。记录失败继续下一个
- 「未登录」/「未出现侧栏 .menu-list」 —— 登录态过期，需在服务所在机器执行 `boss login` 扫码
- 「集合「X」不存在」 —— 还没 `pool_add` 过，或岗位名拼写不一致
- 简历 OCR 报错且提到 OCR 密钥 —— 服务端 OCR 配置问题，不是候选人问题，停下来告知用户
- 简历内容为空 —— 可能命中付费墙，标注后跳过

### When to Ask the User
- Step 1 多岗位时确认目标岗位
- **Stage 2 抓简历前**（消耗配额）
- **Stage 4 打招呼前**（消耗配额且不可撤销）
- 需要分批时，每批之间给用户中止的机会
- 对某人匹配度判断不确定时，让 HR 看 `pool_get_detail` 的简历原文再定
