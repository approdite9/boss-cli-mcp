---
name: boss-agent-review
display_name: Boss Agent 预筛选
description: "基于JD自动筛选Boss直聘推荐候选人，三阶漏斗（标签初筛→简历精筛→HR确认），最终批量打招呼。适用于用户说 /boss_agent_review、预筛选、自动筛选、帮我筛、智能招聘等场景。"
icon: "🎯"
trigger: /boss_agent_review 预筛选 自动筛选 帮我筛 智能招聘
inputs:
  - name: greet_limit
    description: "本次打招呼上限（每日约 50-70，单次调用硬上限 50）"
    type: number
    default: 50
id: bd6c3a901e34474e9a8d4a4905e47d02
---

## Overview

三阶漏斗：读 JD → 加载推荐列表 → Stage 1 标签初筛（宽松）→ 入库集合 → Stage 2 全量抓简历 + AI 精筛 → Stage 3 导出报告给 HR 确认 → Stage 4 批量打招呼。

**简历查看无限次，打招呼是唯一瓶颈**（每日约 50-70）。所以策略是：简历尽管全量看，把判断做透；打招呼严格按 HR 确认的名单执行。

本流程**使用 `pool_*` 集合工具**，原因是它要看上百份简历、跨很长时间、经过多轮评估——对话上下文一定装不下。集合落盘在 `~/.boss-cli/.cache/pool/`，跨调用、跨进程重启都不丢，中断后重跑会自动跳过已完成的人。

## 配额

| 动作 | 配额情况 | 单次调用上限 |
|------|---------|-------------|
| **打招呼**（`boss_greet` / `pool_greet_all`） | **每日约 50-70 次，唯一真实瓶颈** | 50 人/次（硬上限） |
| 看在线简历（`boss_preview_resume` / `pool_batch_resume`） | 当前账号**无限次** | 20 人/次 |
| 读列表 / 读 JD / 集合本地操作 | 不消耗 | — |

⚠️ 工具描述里 `boss_preview_resume` / `pool_batch_resume` 仍标着「消耗每日在线简历查看次数」，那是按最保守的账号套餐写的。**本部署实测无限**，所以本流程全量抓简历。

⚠️ `pool_batch_resume` 的 20 人上限**不是配额限制**，是单次调用的规模上限——20 人 × 4-9 秒间隔已接近三分钟，再长会增加列表失效风险。人多就分多次调用。

⚠️ 两个批量工具 **`dryRun` 默认 `true`**，只返回将要处理的名单；**必须显式传 `dryRun: false`** 才真执行。

⚠️ 不要自己写 sleep。MCP 层已在相邻浏览器调用间插入 1.8-5s，批量工具内部另有 3-8s（打招呼）/ 4-9s（简历）间隔。

## Prerequisites

需要以下 MCP 工具（工具名前缀随客户端而异，本文按裸名书写）：

```
boss_list_positions, boss_get_jd, boss_recommend
pool_add, pool_list, pool_get_detail, pool_remove, pool_mark
pool_batch_resume, pool_greet_all, pool_export
```

浏览器需已登录 Boss。若返回「未登录」或「未出现侧栏 .menu-list」，请用户在服务所在机器执行 `boss login` 扫码。

## ⚠️ 最重要的约束：进入推荐页后不得离开、不得切岗位

`pool_batch_resume` / `pool_greet_all` **不会跳转页面**（内部就是逐个调单人版的 preview / greet），但它们要求**当前已在「推荐」页、列表已加载、且能按姓名找到这些候选人**。

一旦列表被重置，之前 `boss_recommend` 拿到的人就再也找不到了。会导致重置的动作：

- `boss_list_positions` / `boss_get_jd` —— **会离开推荐页**
- **切换岗位** —— 会重置列表。`pool_greet.ts` 的注释写明：「每次带 jobKeyword 都会重新切换岗位，批量场景下会把后续候选人全部弄丢」
- 大幅滚动 —— DOM 回收，靠后的卡片可能失效

顺序是死的，且中途不可回头：

```
boss_list_positions → boss_get_jd → boss_recommend → 之后只做 pool_* 操作
```

**`pool_greet_all` 不要传 `jobKeyword`**：岗位在 `boss_recommend` 时已经定了，再传等于自毁列表。

`pool_add` / `pool_list` / `pool_mark` / `pool_remove` / `pool_export` 是纯本地文件操作，不碰浏览器，任何时候都能安全调用。

> 备注：`boss_search` / `boss_deep_search` 系列已在服务端注释停用（风控检测风险过高），不要尝试调用。

## ⚠️ `boss_recommend` 返回数据的局限性

**没有 `count` 参数**（只接受可选 `jobKeyword`），返回的是当前页面已加载的那些人。卡片信息不完整：

| 维度 | 工具返回 | 影响 |
|------|---------|------|
| 姓名/年龄/应届年/学历/活跃状态 | ✅ | — |
| 期望城市+方向、薪资、优势标签 | ✅ | — |
| **院校名称** | ❌ 缺失 | 无法判断院校层次 |
| **专业** | ❌ 缺失 | 无法判断专业匹配度 |
| **实习/工作经历** | ❌ 缺失 | 无法判断实际经验 |
| 部分技能标签 | ⚠️ 不全 | 标签不完整 |

**策略后果**：Stage 1 初筛必须极度保守——**仅排除方向明确矛盾的**，其余放行。不要基于缺失的院校/专业/经历做任何推断。既然简历无限次可看，真正的判断全部留到 Stage 2。

## ⚠️ 去重规则（严格多字段匹配）

**不得仅凭姓名去重**（同名很常见）。以下字段**全部相同**才算重复：

姓名 + 年龄 + 学历 + 应届年份 + 期望方向 + 薪资

任一字段不同即视为不同的人，两条都保留。

## Workflow

### Step 1: 岗位 + JD
- **Mode**: `deterministic`
- **Validate**: 至少 1 个岗位

1. `boss_list_positions()` 取在招岗位
2. 展示给用户确认目标岗位（只有 1 个则直接用）
3. `boss_get_jd(name=岗位名)` 取完整 JD
4. 从 JD 拆出**核心要求**与**加分项**两组（`pool_add` 要用）

### Step 2: 加载推荐列表
- **Mode**: `deterministic`
- **Validate**: 去重后 > 0 人

1. `boss_recommend(jobKeyword=可选岗位关键字)`
2. 严格多字段去重
3. 报告：`已加载 N 条，去重后 M 人`

⚠️ **从此刻起：不离开推荐页、不切岗位。** 这是本流程唯一不可恢复的错误。

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

简历无限次可看，**放行的成本几乎为零，误排除的成本是永久错过**。宁松勿严。

### Step 4: 入库集合
- **Mode**: `deterministic`

把初筛通过的人一次性入库：

```
pool_add(
  job="岗位名",
  candidates=[{name:"张三", matchReason:"初筛通过：期望方向与JD一致"}, ...],
  core=["JD 核心要求1", "核心要求2"],
  bonus=["加分项1", "加分项2"]
)
```

`matchReason` 写清为什么放行，方便 HR 审核时回溯。集合是后续所有批量操作的工作台，也是断点续跑的依据。

### Step 5: Stage 2 — 全量抓简历 + AI 精筛
- **Mode**: `agentic`
- **Validate**: 至少 1 份简历抓到

简历无限次，**这一步要抓全**——它是唯一能拿到院校、专业、项目、实习经历的地方。

1. 先预演看清人数：
   ```
   pool_batch_resume(job="岗位名")        // dryRun 默认 true
   ```
2. 执行，每次不超过 20 人：
   ```
   pool_batch_resume(job="岗位名", dryRun=false, limit=20)
   ```
3. 人数超过 20 就反复调用，直到预演返回「无待处理」。每轮之间把进度报给用户

已抓到的人会被自动跳过，所以反复调用是安全的、不会重复抓。

抓完对每人做 AI 评估：院校层次（985/211/双一流/QS）、专业匹配度、真实项目经验（vs 课程作业）、技术栈深度、实习经历质量、论文/竞赛、与 JD 核心要求的匹配度。

结论写回集合，**不要只留在对话里**：

```
pool_mark(job="岗位名", id=3, tag="🌟强烈推荐")
pool_mark(job="岗位名", id=7, tag="⭐建议考虑")
pool_remove(job="岗位名", ids=[12, 15])     // 明显不符的剔除
```

剔除时在汇报里给出具体理由。

### Step 6: Stage 3 — 导出报告
- **Mode**: `deterministic`

```
pool_export(job="岗位名", includeDetail=true)
```

返回绝对路径（落在 `~/.boss-cli/.cache/pool/exports/`），内含名单速览表 + 每人简历正文。把路径给用户，并在对话里贴分级摘要：

```
漏斗：加载 N 条 → 去重 X 人 → 初筛 M 人 → 抓简历 K 人 → 推荐 P 人
🌟 强烈推荐 A 人 ／ ⭐ 建议考虑 B 人 ／ ❌ 已剔除 C 人
报告：<pool_export 返回的路径>
```

### Step 7: HR 确认
- **Mode**: `agentic`
- **Validate**: 用户明确回复

```
已筛出 P 人推荐，报告已生成。
打招呼是唯一瓶颈：每日约 50-70 次，本次上限 {{greet_limit}}（单次调用硬上限 50）。
打招呼不可撤销，请确认：
- "全部打招呼"
- "只打 1,3,5"      → 我会 pool_remove 掉其余的
- "去掉 2,4"        → 我会 pool_remove 这两个
- "看某人简历 3"    → pool_get_detail(job, id=3)（读缓存，不再抓取）
- "调整标准: xxx"   → 基于已抓到的简历重新评估（不需要重抓）
```

`pool_greet_all` 只对集合里**尚未打过招呼**的人操作，所以用 `pool_remove` 剔除不要的人，比另外维护一份名单可靠。

「调整标准」不需要重新抓简历——正文已缓存在集合里，直接重新评估即可。

### Step 8: Stage 4 — 批量打招呼（消耗瓶颈配额）
- **Mode**: `agentic`

1. 预演：
   ```
   pool_greet_all(job="岗位名")            // dryRun 默认 true
   ```
2. 把名单和人数复述给用户，**再次确认**
3. 执行（**不要传 jobKeyword**）：
   ```
   pool_greet_all(job="岗位名", dryRun=false, limit={{greet_limit}})
   ```

工具内部逐个间隔 3-8 秒、每成功一个立即落盘。人数多时整个调用可能持续数分钟，属正常。中断后再调会自动跳过已打过的人。

超过 50 人要分多次调用，注意每日总量约 50-70，别超。

### Step 9: 汇总

```
漏斗：加载 N → 去重 X → 初筛 M → 抓简历 K → HR 确认 P → 打招呼成功 A / 失败 B
今日累计已打招呼 A 人（每日约 50-70）
集合：~/.boss-cli/.cache/pool/<岗位名>.json
报告：<导出路径>
建议后续用 boss_list_candidates(unread=true) 看回复。
```

## Output

- 候选人集合：`~/.boss-cli/.cache/pool/<岗位名>.json`（含简历正文缓存、标记、已打招呼状态，持久保存）
- 导出报告：`pool_export` 返回的绝对路径
- 对话中的实时进度 + 最终汇总

## Lessons Learned

### Do
- **Step 1 先取岗位+JD**，进入推荐页后就不能再离开
- **去重严格多字段匹配**
- **初筛极度保守** —— 简历无限次，放行成本几乎为零，误排除是永久错过
- **Stage 2 抓全** —— 这是唯一能拿到院校/专业/经历的地方
- **结论写回集合**（`pool_mark` / `pool_remove`），别只留在对话里——集合持久，上下文会丢
- **批量工具先 dryRun 一次**，把名单和人数给用户看过再执行
- **反复调用 `pool_batch_resume` 是安全的** —— 已抓到的自动跳过
- 活跃优先：「刚刚活跃」「在线」的候选人回复率显著更高

### Don't
- **不要给 `boss_recommend` 传 `count`** —— 没有这个参数，`additionalProperties: false` 会直接拒掉
- **不要给 `pool_greet_all` 传 `jobKeyword`** —— 会切岗位、重置列表，后续候选人全丢
- **不要在流程中途调 `boss_list_positions` / `boss_get_jd`** —— 会离开推荐页
- **不要尝试 `boss_search` / `boss_deep_search`** —— 服务端已停用（风控风险过高）
- **不要漏掉 `dryRun: false`** —— 漏了只是预演；反过来，没经用户确认就传 `false` 是在花掉当天的打招呼额度
- **不要为省简历配额而少抓** —— 无限次，省它没有意义，反而让筛选质量下降
- **不要仅凭姓名去重**
- **不要在初筛中推断缺失信息** —— 看不到院校就不要猜
- 不要自己加 sleep
- 单次打招呼不要超过 50，每日总量注意 50-70 的上限

### Common Failures
- 「未在列表中找到候选人：X」 —— 不在当前推荐列表（滚动后 DOM 回收，或姓名不完全一致）。**不要试图重新加载列表**；该人的 `lastError` 已记进集合，继续下一个
- 「未登录」/「未出现侧栏 .menu-list」 —— 登录态过期，需在服务所在机器 `boss login` 扫码
- 「集合「X」不存在」 —— 还没 `pool_add` 过，或岗位名拼写不一致
- 简历 OCR 报错且提到 OCR 密钥/签名 —— 服务端 OCR 配置问题，不是候选人问题，停下来告知用户
- 简历内容为空 —— 可能命中付费墙，标注后跳过
- 批量调用中途大量失败 —— 很可能列表已被重置（有人切了岗位或离开过推荐页），停下来告知用户需要从 Step 2 重新加载

### When to Ask the User
- Step 1 多岗位时确认目标岗位
- **Stage 4 打招呼前**（不可逆、消耗当天瓶颈配额）
- 打招呼需要分多次调用时，每次之间给用户中止的机会
- 对某人匹配度判断不确定时，让 HR 看 `pool_get_detail` 的简历原文再定
