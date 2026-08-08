---
name: maintain-test-plan
description: "根据完整 release plan，按仓库版本周期幂等维护累计发布测试计划，并在正式发布后冻结。Use when $release provides pending release metadata, or the user asks to update release tests, candidate deltas, build history, or a released cycle in any language or ecosystem."
---

# Maintain Test Plan

通常由 `$release` 在片段被消费前调用。使用一份 Markdown 记录同一版本周期的累计范围、
候选增量和测试状态；不要求开发者填写模板。

## 定位文档

读取仓库发布规则和现有文档，确定周期、路径与语言：

- 使用仓库版本解析器处理 SemVer、PEP 440、Swift、CalVer 或自定义 release train，
  不自行套固定正则。
- 路径优先级：调用方指定 → 同周期现有文档/仓库约定 →
  `docs/releases/<cycle-id>-testing.md`。同周期只维护一份。
- 语言优先级：用户指定 → 仓库指令 → 现有测试文档 → release metadata → 对话语言。

缺少可验证的候选版本、周期或 release plan 时停止，不从版本后缀猜测。

## 更新状态

先完整读取旧文档，再合并本轮 plan：

- 累计范围保留该周期所有已记录意图；本次增量只含相对上一候选新增或改变的内容。
- 上一候选来自构建历史或调用方证据，不由 `beta.2` 推测 `beta.1`。
- 用 Changeset/issue ID 标识意图，用语义稳定的 ID 去重测试与问题；保留人工 checkbox、
  备注、负责人、链接和证据。
- 没有证据时不标记测试通过、问题修复或风险解除。
- 构建历史以仓库能唯一识别候选构建的 release/candidate/build 组合 upsert。

文档至少包含当前候选、累计范围、本次增量、测试/遗留问题和构建历史。风险与回滚、
已修问题和发布后验证只在适用时维护。

使用不依赖自然语言标题的稳定标识：

```md
<!-- release-test-plan:cycle=1.4.1 -->
- 支持批量导出。 <!-- intent:order-export -->
- [ ] 验证导出权限。 <!-- test:order-export-permission -->
```

只更新拥有的条目，不覆盖人工段落；相同输入重复运行不得产生重复 ID 或构建记录。
`$release` 可在 version 前保存范围，并在 version 后用同一 plan 和最终 build 再次调用。

## 冻结与验证

只有正式版存在真实发布证据且 `phase=released` 时冻结或按仓库约定归档。候选版不冻结；
冻结后仅允许带日期、原因和证据的明确勘误。

运行仓库文档校验，并汇报路径、周期、当前/上一候选、范围与测试变化、构建记录及
冻结状态。
