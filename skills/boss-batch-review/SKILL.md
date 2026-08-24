---
name: boss-batch-review
display_name: Boss 分批流式审核
description: "在 Boss 直聘推荐页逐批展示候选人供 HR 实时审核并打招呼。适用于用户说 /boss_batch_review、分批审核、批量看推荐、逐个审核候选人等场景。"
icon: "👥"
trigger: /boss_batch_review 分批审核 批量审核 逐个看推荐
inputs:
  - name: batch_size
    description: "每批展示人数"
    type: number
    default: 10
id: 599bc04e7b8d4987b801e67a27520ed1
---

## Overview

在推荐页分批展示候选人，由 HR 实时决定对每个人打招呼或跳过。适合 HR 想亲自过一遍、而不是让 Agent 代为筛选的场景。

**与 `boss-agent-review` 的分工**：本流程把判断权交给 HR，Agent 只负责组织信息和执行操作；`boss-agent-review` 则由 Agent 先做两轮筛选、HR 只确认最终名单。人多且信任 Agent 判断时用后者，人少或标准难以言明时用本流程。

**核心约束：看简历和打招呼都消耗不可逆的平台配额。** 所以本流程**默认不预抓简历**——先用卡片信息展示，HR 想深入了解某人时再单独抓。这一点和早期版本相反，原因见下。

## 配额（先读这一节）

| 动作 | 工具 | 配额 | 单次硬上限 |
|------|------|------|-----------|
| 看在线简历 | `boss_preview_resume` / `pool_batch_resume` | **消耗每日在线简历查看次数** | 批量 20 人/次 |
| 打招呼 | `boss_greet` / `pool_greet_all` | **消耗打招呼次数** | 批量 50 人/次 |
| 读列表 / 读 JD / 集合操作 | `boss_recommend`、`boss_list_positions`、`boss_get_jd`、`pool_add/list/remove/mark/export` | 不消耗 | — |

⚠️ **早期版本写着「简历查看无限次不消耗配额」，这是错的。** 按那个说法每批都全员预抓简历，一天的额度很快就没了。现在的做法是按需抓：HR 说「看 3」才抓第 3 位。

批量工具 **`dryRun` 默认 `true`**，必须显式传 `dryRun: false` 才真执行。

⚠️ 不要自己写 sleep。MCP 层已在相邻浏览器调用间插入 1.8-5s 随机间隔，批量工具内部另有 3-8s / 4-9s 间隔。

## Prerequisites

需要以下 MCP 工具（前缀随客户端而异，本文按裸名书写）：

```
boss_list_positions, boss_get_jd, boss_recommend
boss_preview_resume, boss_greet
pool_add, pool_list, pool_get_detail, pool_mark, pool_remove, pool_export
```

浏览器需已登录 Boss。若返回「未登录」或「未出现侧栏 .menu-list」，请用户在服务所在机器执行 `boss login` 扫码。

## ⚠️ 页面前置条件与顺序

`boss_preview_resume` / `boss_greet` **要求当前已在「推荐」`/web/chat/recommend`（或「深度搜索」`/web/chat/aiform`、「常规搜索」`/web/chat/search`）且列表已加载，它们不会自动跳转**。而 `boss_list_positions` / `boss_get_jd` 会离开推荐页。

顺序是死的：

```
boss_list_positions → boss_get_jd → boss_recommend → 之后不再离开推荐页
```

## ⚠️ `boss_recommend` 返回数据的局限性

**没有 `count` 参数**（只接受可选 `jobKeyword`），返回的是当前页面已加载的那些人。卡片信息不完整：

| 维度 | 工具返回 |
|------|---------|
| 姓名/年龄/应届年/学历/活跃状态 | ✅ |
| 期望城市+方向、薪资、优势标签 | ✅ |
| **院校名称** | ❌ 缺失 |
| **专业** | ❌ 缺失 |
| **实习/工作经历** | ❌ 缺失 |
| 部分技能标签 | ⚠️ 不全 |

**所以展示时要如实标注哪些信息缺失**，不要让 HR 误以为看到的是全部。HR 想补齐某人的信息，就针对那个人抓一次简历。

## ⚠️ 去重规则（严格多字段匹配）

**不得仅凭姓名去重**（同名很常见）。以下字段**全部相同**才算重复：

姓名 + 年龄 + 学历 + 应届年份 + 期望方向 + 薪资

任一字段不同即视为不同的人，两条都保留。

## Workflow

### Step 1: 岗位 + JD + 参数
- **Mode**: `agentic`
- **Validate**: 至少 1 个岗位

1. `boss_list_positions()` 取在招岗位
2. 展示并让用户确认目标岗位（只有 1 个则直接用）
3. `boss_get_jd(name=岗位名)` 取完整 JD
4. 拆出核心要求 / 加分项摘要，后续展示时作参考、也用于 `pool_add`
5. 确认 `batch_size`（默认 {{batch_size}}）

### Step 2: 加载推荐列表
- **Mode**: `deterministic`
- **Validate**: 去重后 > 0 人

1. `boss_recommend(jobKeyword=可选)`
2. 严格多字段去重
3. 按活跃度排序（「刚刚活跃」「在线」优先，回复率显著更高）
4. 建集合，便于跨批次保留状态：
   ```
   pool_add(job="岗位名", candidates=[{name:"..."}...], core=[...], bonus=[...])
   ```
5. 报告：`已加载 N 条，去重后 M 人，分 X 批展示（每批 {{batch_size}} 人）`

⚠️ **从此刻起不再调用会离开推荐页的工具。**

### Step 3: 展示一批
- **Mode**: `agentic`
- **Validate**: 用户回复了有效指令

用卡片信息展示，**不预抓简历**：

```
【第 X 批 / 共 Y 批】本次已打招呼 B 人，已看简历 A 份
JD 核心要求：[摘要]

| # | 姓名 | 年龄 | 学历 | 应届 | 期望方向 | 薪资 | 活跃 | 优势标签 | 初判 |
|---|------|------|------|------|---------|------|------|---------|------|
| 1 | 向锐 | 24 | 硕士 | 2026 | Python | 15-30K | 在线 | QS前500 | ⭐ |
| 2 | 龚昱帆 | 22 | 本科 | 2027 | 互联网 | 面议 | 在线 | 专业前15% | ➖ |

⚠️ 卡片不含院校/专业/实习经历，上表「初判」仅基于方向与标签，需要补齐请说「看简历 N」（消耗每日简历配额）。

请回复：
- "打招呼 1,3"    → 对指定编号打招呼（消耗打招呼配额）
- "看简历 2"      → 抓第 2 位的在线简历（消耗简历配额）
- "标记 1 重点"   → 记进集合，不消耗任何配额
- "下一批"
- "结束"
```

初判档位：
- 🌟 方向匹配且标签有实质亮点
- ⭐ 部分匹配或有潜力
- ➖ 从卡片看匹配度较低（仍展示，由 HR 决定）

一次不超过 15 人，表格太长影响可读性。

### Step 4: 执行指令
- **Mode**: `agentic`
- **On failure**: 记录原因，继续下一个

| 指令 | 动作 |
|------|------|
| `打招呼 1,3` | 逐个 `boss_greet(name=…)`。**执行前复述姓名并确认**，这是不可逆的 |
| `全部打招呼` | 对当前批次所有人。人数较多时改用 `pool_greet_all`（内建间隔与断点续跑） |
| `看简历 2` | `boss_preview_resume(name=…)`，然后 `pool_mark` 或把要点记进集合 |
| `标记 N xxx` | `pool_mark(job, id, tag)` — 纯本地，不消耗配额 |
| `剔除 N` | `pool_remove(job, ids=[…])` |
| `下一批` | 回 Step 3 |
| `结束` | 进 Step 5 |

每次操作后展示计数：`✅ 完成。本次已打招呼 X 人，已看简历 Y 份。`

如果用户一次要打招呼的人较多（比如超过 10 人），改用集合批量更稳妥：

```
pool_greet_all(job="岗位名")                      // 先预演
pool_greet_all(job="岗位名", dryRun=false, limit=N)  // 确认后执行
```

它内建 3-8 秒随机间隔、每成功一个立即落盘、中断后自动跳过已打过的人。

### Step 5: 汇总

```
本次审核完成：
浏览 N 人（M 批）／打招呼 X 人（成功 A / 失败 B）／看简历 Y 份
集合文件：~/.boss-cli/.cache/pool/<岗位名>.json
```

需要留档就 `pool_export(job="岗位名")`，返回的报告含名单表与已抓到的简历正文。

## Output

- 对话中的分批表格 + 实时操作反馈 + 汇总
- 候选人集合（含标记、已打招呼状态、已抓到的简历）：`~/.boss-cli/.cache/pool/<岗位名>.json`
- 可选导出报告：`pool_export` 返回的绝对路径

## Lessons Learned

### Do
- **Step 1 先取岗位+JD**，进入推荐页后就不能再离开
- **按需抓简历，不要全员预抓** —— 每次都扣每日配额
- **如实标注卡片缺失的维度**，别让 HR 以为信息是全的
- **用集合记状态**（`pool_mark` / `pool_remove`），跨批次和跨对话都不丢；对话上下文会丢
- 活跃优先排序
- 每批只展示当前批次，不重复前几批（省上下文）
- 操作后立即展示计数，让 HR 实时知道配额消耗
- 人数多时用 `pool_greet_all` 而不是循环 `boss_greet`

### Don't
- **不要给 `boss_recommend` 传 `count`** —— 没有这个参数，`additionalProperties: false` 会直接拒掉
- **不要相信「简历无限次」** —— 那是早期版本的错误说法
- **不要每批全员 `preview_resume`** —— 一天额度很快见底
- **不要自己加 sleep**
- **不要仅凭姓名去重**
- **不要在 `boss_recommend` 之后调 `boss_list_positions` / `boss_get_jd`**
- 不要一次展示超过 15 人
- **不要在 HR 确认前打招呼**

### Common Failures
- 「未在列表中找到候选人：X」 —— 不在当前推荐列表（滚动后 DOM 回收，或姓名不完全一致）。记录失败继续
- 「未登录」/「未出现侧栏 .menu-list」 —— 登录态过期，需在服务所在机器 `boss login` 扫码
- 简历 OCR 报错且提到 OCR 密钥 —— 服务端配置问题，不是候选人问题，停下来告知用户
- 简历内容为空 —— 可能命中付费墙，在表格里标「简历不可用」
- 推荐页 0 人 —— 检查岗位是否开放中

### When to Ask the User
- Step 1 多岗位时确认目标岗位
- **每次打招呼前**（不可逆、消耗配额）
- **每次抓简历前**，若一次要抓多人
- 用户要求离开推荐页时警告：会导致后续 `boss_greet` / `boss_preview_resume` 前置条件不满足
- 打招呼累计较多时提醒配额
