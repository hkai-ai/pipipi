# 图片替换方案

`template-image-plan/v1` 使用真实图片附件与固定 Runtime Skill 输出未批准的替换策略，不生图、不上传。调用方必须展示完整策略，等待第一次人工确认。

模型返回后独立记录 `plan_validation`，收集固定字段的结构问题与具名业务规则。对象候选可修正时，只在原 240 秒预算内执行一次 `plan_correction`：请求级严格 Schema 限定可替换的顶层字段，Agent 重新读取原图及固定 Skill，返回字段值的 JSON 编码补丁；程序保留其余字段，合并后重跑全部结构和业务校验。未知顶层字段、非对象、超预算候选及模型执行错误直接失败，不重新生成完整方案。修正不改变审批门禁。

`template_strategy_diagnostic` 日志只记录 runId、阶段、最多 16 个规则码与固定字段名，不记录原始异常、URL、候选正文或模型回答；诊断 Sink 失败不改变业务结果。`plan_persistence` 仅在完整校验通过后开始。历史运行未保存候选及规则诊断时，不能从通用 `AGENT_FAILURE` 推断具体字段。

编排、来源和恢复边界见 [审核后编译模板](../template-from-source/README.md)；输入输出见 [API 文档](../../../api.md#模板图片生产与两次审核)。
