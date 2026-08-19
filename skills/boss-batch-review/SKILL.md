---
name: boss-batch-review
display_name: Boss 分批流式审核
description: "在 Boss 直聘推荐页逐批展示候选人供 HR 实时审核并打招呼。适用于用户说 /boss_batch_review、分批审核、批量看推荐、逐个审核候选人等场景。"
icon: "👥"
trigger: /boss_batch_review 分批审核 批量审核 逐个看推荐
integration: boss_cli_local
inputs:
  - name: count
    description: "加载候选人数量（自动滚动加载到此数量）"
    type: number
    default: 50
  - name: batch_size
    description: "每批展示人数"
    type: number
    default: 10
tools: [load_tools, file_write, open_in_session_tab]
id: 599bc04e7b8d4987b801e67a27520ed1
---

## Overview

在 Boss 直聘推荐页面分批展示候选人，由 HR 实时决定对每个人打招呼、看简历或跳过。全程不离开推荐页，确保 DOM 中加载的候选人始终可操作。适合需要精细把控每个候选人的场景。

## Prerequisites

加载 boss-cli-local MCP 工具：
```
load_tools(["boss_cli_local__boss_list_positions", "boss_cli_local__boss_recommend", "boss_cli_local__boss_greet", "boss_cli_local__boss_preview_resume"])
```

## Workflow

### Step 1: 确认参数并选择岗位
- **Mode**: `agentic`
- **Input**: 无（自动获取）
- **Output**: 用户确认的岗位名 + count + batch_size
- **Validate**: 用户回复或使用默认值
- **On failure**: 使用默认值（第一个开放岗位、count=50、batch_size=10）

调用 `boss_cli_local__boss_list_positions` 展示所有岗位列表。默认使用第一个开放中的岗位。询问是否切换、加载人数、每批展示数。

### Step 2: 滚动加载候选人
- **Mode**: `deterministic`
- **Input**: `count={{count}}, jobKeyword=岗位名`
- **Output**: 去重后的候选人列表
- **Validate**: 返回人数 > 0
- **On failure**: 检查推荐页是否正常加载，提醒用户确认登录状态

调用 `boss_cli_local__boss_recommend(count={{count}}, jobKeyword=岗位名)`。

⚠️ **关键约束：从此刻起到流程结束，不得调用任何会离开推荐页的工具**（如 boss_open_chat、boss_list_positions、boss_list_candidates），否则 DOM 重置。

初始化计数器：`已查看简历: 0, 已打招呼: 0`

### Step 3: 分批展示
- **Mode**: `agentic`
- **Input**: 当前批次的候选人数据（每批 {{batch_size}} 人）
- **Output**: 表格展示 + 等待用户指令
- **Validate**: 用户回复了有效指令

优先展示"刚刚活跃"和"今日活跃"的候选人。展示格式：

```
【第 X 批 / 共 Y 批】
| # | 姓名 | 学历/年龄 | 方向 | 薪资 | 活跃度 | 优势亮点 |
请回复: "打招呼 1,3" / "看简历 5" / "下一批" / "结束"
```

### Step 4: 执行用户指令
- **Mode**: `agentic`
- **Input**: 用户选择的编号/姓名
- **Output**: 操作结果 + 更新后的计数
- **Validate**: 工具返回成功消息
- **On failure**: 记录失败原因（如"未在列表中找到"），继续下一个

对"打招呼"指令调用 `boss_cli_local__boss_greet(name=候选人姓名)`。
对"看简历"指令调用 `boss_cli_local__boss_preview_resume(name=候选人姓名)`。
每次操作后展示：`今日已查看简历 X 个，已打招呼 Y 个。`

### Step 5: 循环
- **Mode**: `deterministic`
- **Input**: 用户上一步指令
- **Output**: 回到 Step 3 展示下一批，或进入 Step 6 汇总

### Step 6: 汇总报告
- **Mode**: `agentic`
- **Input**: 全程操作记录
- **Output**: 汇总统计

```
本次审核完成：总浏览 N 人 / 打招呼 X 人 / 查看简历 Y 人 / 跳过 Z 人
今日累计：已查看简历 Y 个，已打招呼 X 个。
```

## Output

对话中的分批表格 + 实时操作反馈 + 最终汇总报告。

## Lessons Learned

### Do
- 每批只展示当前批次，不重复前几批内容（节省上下文）
- 活跃优先排序，活跃候选人回复率更高
- 操作后立即展示计数器，让用户实时知道配额消耗

### Don't
- 绝对不能在流程中调用会导航离开推荐页的工具
- 不要一次展示超过 15 人（表格太长影响可读性）
- 不要在用户没确认前自动打招呼

### Common Failures
- "未在列表中找到该候选人" — DOM 回收导致，记录失败继续下一个
- 推荐页加载不到人 — 检查岗位是否开放中，是否已登录

### When to Ask the User
- 用户要求离开推荐页时必须警告
- 打招呼累计接近 50 时提醒配额即将耗尽
