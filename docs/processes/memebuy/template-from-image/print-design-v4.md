# 批准图片转印花拆解候选

适用于 `template-from-image/v3` 与 `template-from-source/v3`。公开字段和错误以 [业务 API](../../../api.md#印花拆解模板process-v3) 为准；旧 v1/v2 的视觉合同、运行恢复与规则快照保持不变。

## 执行与权威

v3 Process 交付运行语义 V4，二者分别版本化。编译器独立位于 `src/processes/template-from-image/design-spec/`；不把 V4 送入旧 visualContract 分析、复核或编译器。目标与输入仍由 binding 决定，视觉事实只由 `designSpec` 拥有。模型不编写展示提示词，服务端从 defaults 单向生成。

先加载本次批准图，模型记录总览、准确文字和印花风险后编写候选；第二个隔离、无 Tool 会话重新看同一图，用有界字段补丁与六项具名检查完成复核。首轮 JSON 或候选结构不可读时最多增加一次编译，正常两次、最多三次模型调用；模型执行错误、独立复核阻断或最终合同错误不增加调用。未知程序异常交给 Runner 处理。

补丁绑定输入候选 SHA-256，只允许当前已有字段；证据路径按补丁后的完整候选复验，不能引用已删除字段。检查包含图像保真、版面与文字、印花形态、输入绑定、默认迁移和来源隔离，不能替代人工视觉判断。透明图附白底与深底观察图，批准图本身与摘要不变。没有提供的像素统计不编造；版面 bbox 是待人审候选。

作者校验包括完整 designSpec Schema、元素/配色引用、默认迁移、主体数量、模板编译器词表检查与输入接管关系。当前生成引擎只支持一张私有主体照片；其余内容、准确文字和配色仅开放文本，不交付内容图片或 reference_only 输入。每处准确文字保留原始观察和 defaults；主体相关的文字标 followsSubject。

`template-from-source/v3` 继续调用原审核后 finalize，审批身份、成图和内容寻址上传不变；只把编译成员精确固定为 `template-from-image/v3`，不重新规划或生图。成员失败沿原 `DEPENDENCY_FAILURE_AFTER_COMMIT` 边界报告。内部观察、复核、模型与规则不会进入公开草稿或运行日志。

## 固定来源与运行边界

`print-design-template-compiler@v1` 完整打包 Memebuy 方法正本及作者合同。来源修订、许可与逐文件摘要在 Skill 的 `source-manifest.json` 和 `SOURCE.md`。纯检查器从同一审查来源生成；不执行开发 Skill 的 Shell、网络、凭证、导入或生图脚本。Docker 成品包含固定快照，启动期验证准确摘要。

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

此命令只用本地图片加载替身替换下载，HTTP、模型拆解与独立复核走正式实现。候选、复核及失败证据只保存在新建受限目录，不覆盖旧轮次。结果里的示例图片地址不能用作正式导入；正式工作台仍须复用已审核图片及其 OSS 对象。

## 部署、回退与实环境验收

先部署含三项准确编译版本的 Pipipi API 与执行 Worker，再部署 Memebuy Web 和模板提取消费者。方案与成图服务继续用原版本，无需新数据库迁移。Memebuy 新编译轮次冻结 Process v3；历史候选重试沿原版本、原运行恢复不重新派发。旧模板和已冻结生成任务不自动升级。

V4 候选沿原审核、采用、同一草稿身份、模板版本事务和试跑链路。生成是否开放仍由 Memebuy 拆解引擎开关决定，Pipipi 不操作开关或发布状态。回退新调用可恢复 Process v2；已入库 V4 仍需保留支持 V4 的读取与生成端。

确定性覆盖包含 HTTP 成图编译、批准透传、不触发生图、严格作者结构、独立复核、修正预算、精确版本/Skill 隔离，以及 Memebuy 的真实作者校验、READY 收口、采用事务、版本内容和生成编译。数据库及模型使用受控替身，尚待实环境登录工作台验证：批准图 → V4 候选 → 人工采用 → 当前模板版本 → 默认/长文字/主体照片试跑，并核对视觉、输入隐私、费用、历史 V3 恢复和旧任务快照。未完成这些步骤前不宣称已上线或印刷质量已通过。
