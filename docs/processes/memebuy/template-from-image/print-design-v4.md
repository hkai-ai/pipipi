# 批准图片转印花拆解候选

适用于 `template-from-image/v3` 与 `template-from-source/v3`。公开字段和错误以 [业务 API](../../../api.md#印花拆解模板process-v3) 为准；旧 v1/v2 的视觉合同、运行恢复与规则快照保持不变。

## 执行与权威

v3 Process 交付运行语义 V4，二者分别版本化。编译器独立位于 `src/processes/template-from-image/design-spec/`；不把 V4 送入旧 visualContract 分析、复核或编译器。目标与输入仍由 binding 决定，视觉事实只由 `designSpec` 拥有。模型不编写展示提示词，服务端从 defaults 单向生成。

先加载本次批准图，模型输出紧凑 `{observation:{texts,sourceCondition},draft}`；服务端在同一轮立即执行完整 JSON Schema、Memebuy 拆解词表检查与输入绑定一致性校验。**首轮零错直接交付（正常仅 1 次模型调用）**；仅当 JSON 语法、结构或拆解合同校验未通过时，沿精确字段路径触发最多 1 次按需修正（`template_correction`，最多 2 次模型调用），不再无条件追加独立看图复核会话。模型执行错误或修正后仍未通过校验时直接失败，不增加调用；未知程序异常交给 Runner 处理。

## 默认模型与提示缓存

OpenAI 协议下未显式设置 `TEMPLATE_MODEL` 时，`template-from-image/v3` 默认使用高性价比的 `gpt-6.1-terra`（若服务器环境曾配置旧 `TEMPLATE_MODEL`，更新该变量或留空即可生效）。系统提示由约 76KB 的固定 Skill 正文在前、精简候选 Schema 与任务指令在后（`skillFirst`），并按绑定版本固定 `prompt_cache_key`（`print-design-template-compiler:v3`），使 `compile`、按需 `correction` 及跨运行请求共享同一前缀缓存（系统提示已移除冗余的旧版 `$defs` Schema，输出省略会被丢弃的 `overview` 与 `printRisks`）。非 OpenAI 协议或显式禁用 cache key 的模型不附加该字段。`cacheWarming` 保持 `off`。命中情况看运行日志活动 `sessions[].rounds[].usage.cacheRead`；费用以网关 `x-litellm-response-cost` 或模型费率账本为准。模型观察副本采用 WebP（最长边 1024px、每张最多 96 KiB）：不透明图发送 1 张总览，透明图发送白底与深黑底 2 张总览；批准图本身与摘要不变。没有提供的像素统计不编造；版面 bbox 是待人审候选。

作者校验包括完整 designSpec Schema、元素/配色引用、默认迁移、主体数量、模板编译器词表检查与输入接管关系。当前生成引擎只支持一张私有主体照片；其余内容、准确文字和配色仅开放文本，不交付内容图片或 reference_only 输入。每处准确文字保留原始观察和 defaults；主体相关的文字标 followsSubject。`observation.texts` 逐字记录原图文字并原样作为 `source.texts` 回传，`defaults.texts` 是默认迁移文字，二者允许不同（#1092）；`defaults.texts` 与对应槽的 `defaultValue` 仍须一致。输入绑定中只有唯一合法取值的字段（策略、渲染模式、分发方式）写错时服务端按合同改回，`valueKind` 按目标类型推断，推断不出仍按合同报错。rect_patch 必须包含新设计的 `edge` 边框元素且不得声称原图已有边框。

`template-from-source/v3` 继续调用原审核后 finalize，审批身份、成图和内容寻址上传不变；只把编译成员精确固定为 `template-from-image/v3`，不重新规划或生图。成员失败沿原 `DEPENDENCY_FAILURE_AFTER_COMMIT` 边界报告。内部观察、模型与规则不会进入公开草稿或运行日志。

Pipipi 控制台运行表和详情并列展示流程版本与实际交付的模板运行语义。成功时从输出的 `template.runtimeSemantics.version` 单独归档版本号；旧记录若保留输出正文则从正文读取，否则显示“未记录”。可按同次 runId 与 Memebuy 候选核对。

## 固定来源与运行边界

`print-design-template-compiler@v3` 从固定 Memebuy 方法正本及作者合同确定性裁剪出六层拆解、数据格式与 v4 运行语义/输入绑定章节（剔除实验复盘、下游印厂验收、CLI 导入及旧 v1～v3 `visualContract` 背景）。来源修订、许可与逐文件摘要在 Skill 的 `source-manifest.json` 和 `SOURCE.md`。纯检查器从同一审查来源生成；不执行开发 Skill 的 Shell、网络、凭证、导入或生图脚本。Docker 成品包含固定快照，启动期验证准确摘要。

同一 Process ID 的多个版本可以声明不同 Skill。安装集合保留各版规则，构造每个 Registration 时只解析它声明的准确规则；缺失即拒绝启动，不能让新版本覆盖旧版规则或把两套规则混给 Agent。

```sh
node --import tsx tools/build-template-v4-contract.ts /path/to/memebuy-merchant-management --check
npx vitest run test/template-v4.test.ts test/template-agent.test.ts test/production-catalog.test.ts
PIPIPI_V4_CONTRACT_OUTPUT=/tmp/pipipi-v4-output.json npx vitest run test/template-v4.test.ts
```

最后一条把正式 HTTP 路径的受控模型回包写到显式本地路径，供 Memebuy 的 `pipipi-v4-contract.test.ts` 用同名环境变量校验。它验证正式路由和校验实现，不证明真实模型的看图质量。

真实模型验收单独运行，会产生文字模型费用，只读取本地批准图，不生图、不上传、不写模板库：

```sh
RUN_TEMPLATE_PAID_ACCEPTANCE=1 node --env-file=.env --import tsx examples/template-v4-acceptance.ts /path/to/approved.png /path/to/new-evidence-directory
```

此命令只用本地图片加载替身替换下载，HTTP、模型拆解与合同校验走正式实现。候选及失败证据只保存在新建受限目录，不覆盖旧轮次。结果里的示例图片地址不能用作正式导入；正式工作台仍须复用已审核图片及其 OSS 对象。

## 部署、回退与实环境验收

先部署含三项准确编译版本的 Pipipi API 与执行 Worker，再部署 Memebuy Web 和模板提取消费者。方案与成图服务继续用原版本，无需新数据库迁移。Memebuy 新编译轮次冻结 Process v3；历史候选重试沿原版本、原运行恢复不重新派发。旧模板和已冻结生成任务不自动升级。

V4 候选沿原审核、采用、同一草稿身份、模板版本事务和试跑链路。生成是否开放仍由 Memebuy 拆解引擎开关决定，Pipipi 不操作开关或发布状态。回退新调用可恢复 Process v2；已入库 V4 仍需保留支持 V4 的读取与生成端。

确定性覆盖包含 HTTP 成图编译、批准透传、不触发生图、严格作者结构、按需修正预算、精确版本/Skill 隔离，以及 Memebuy 的真实作者校验、READY 收口、采用事务、版本内容和生成编译。数据库及模型使用受控替身，尚待实环境登录工作台验证：批准图 → V4 候选 → 人工采用 → 当前模板版本 → 默认/长文字/主体照片试跑，并核对视觉、输入隐私、费用、历史 V3 恢复和旧任务快照。未完成这些步骤前不宣称已上线或印刷质量已通过。
