# 模板目标视觉归属 v3

Process v2 输出带目标归属的运行语义 v3；输入合同仍是 v2。旧 Process v1 保留原运行语义 v2，历史模板和已受理请求不会自动迁移。

## 字段与执行

- `targetInstances[].appearance` 保存该目标的身份、形状、五官及自身配色；实际替换该目标时移除，未替换时保留。
- `targetInstances[].pose` 保存动作、朝向和位置，使用不包含旧身份外观的谓语；替换后由新主体执行。
- `visualContract` 保留独立于具体目标的媒介、画风、全局配色、构图和跨对象关系。显式模板服装仍按 `clothingOwnership` 保留，不随主体外观删除。
- 原始观察和取舍不能从输出倒推；每条目标事实都必须有 `visualSelections` 保留引用。全局引用沿用 `{field,index}`，目标引用为 `{targetId,field,index}`。不存在的目标、缺失引用和完全重复冻结的条目会被拒绝。
- 原 `spatialRelations` 的紧凑行第三项继续接受 `relations` 的数字索引，也接受目标事实引用；展开字段 `relationIndex` 保留旧名称以恢复已有计划。引用只定位事实，不改变归属。

编译和独立复核仍正常两次调用，仅首轮结构无法读取时允许一次修正，最多三次。生产默认模型与时限不变。v2 Process 将思考设为 low，移除 SDK 自动补入的 128000 等模型最大输出额度，使用上游默认输出额度和原共享截止时间；旧 v1 保留原请求设置。真实验收发现默认大额度配合 medium 在连接可用时仍可能在网关超时，低延迟配置须同时通过完整独立复核，不能放宽门禁。v3 的独立复核额外提供目标归属证据；已解决差异记入 evidence，issues 只记补丁后仍未解决的问题；无法确认的归属必须拒绝交付，不补填通过。字段校验只能保证合同一致，画面语义仍需真实验收。

## 两端发布顺序

1. 先发布 Pipipi，确认准确注册 `template-from-image/v1,v2` 与 `template-from-source/v1,v2`，模板图片规划及生图仍使用原版本。
2. Memebuy 部署 v3 读取、编译与审核升级功能，并应用新增审核草稿字段的数据库迁移。新提取请求目录切为 Process v2；已经存在的 ExternalRun 按原 runId 取回，不重新提交。
3. 新输出直接按 v3 入库。存量模板只能经归属草稿、运营审核和新模板版本升级；不更改冻结任务或旧版本内容。
4. 回滚调用目录可恢复新请求使用 v1，Pipipi 同时保留两版；已产生的 v3 模板仍要求支持 v3 的 Memebuy 读取端，不能回滚为不识别 v3 的消费者。

本次代码与本地验收不等于生产部署，也不自动迁移存量模板。

## 可复现验证

固定旧 Schema 与 Runtime Skill 的版本和摘要不变。新 Schema 由 `tools/build-template-v3-contract.ts` 基于旧合同及 Memebuy 作者合同中 v3 定义生成，保留既有输入绑定限制，并要求输出显式 `colorAndLight` 数组。构建器固定上游文件 SHA-256；输入变化先审查再更新摘要。

```sh
node --import tsx tools/build-template-v3-contract.ts /path/to/memebuy/docs/gallery/template-import/schema.json --check
npx vitest run test/template-v3.test.ts test/template-from-image.test.ts test/template-visual-selection.test.ts
npm run check
npm run typecheck
npm test
npm run build
```

Memebuy 的 `template-extract/pipipi-v3-contract.test.ts` 用 Pipipi 的完整编译输出验证导入合同、归属校验与真实同款编译。通过 `PIPIPI_CONTRACT_OUTPUT` 可使用本次 HTTP 输出覆盖静态样本。静态样本是模型替身，不能冒充真实视觉提取验收。

真实模型验收单独显式运行，会产生费用。只读本地批准图片，不写模板库，不部署；图片加载替身只替代公网下载，HTTP、模型编译、独立复核、合同投影均走正式实现，结果保存到指定证据目录。

```sh
RUN_TEMPLATE_PAID_ACCEPTANCE=1 node --env-file=.env --import tsx examples/template-v3-acceptance.ts /path/to/approved.png output/template-v3-acceptance
```

不要把含图片、候选、私有链接或凭据的验收文件提交仓库；对外报告只写净化后的结论与人工可见的差异。

## 2026-10-23 验收状态

代码检查、类型检查、1,444 项测试与构建通过，65 项外部集成测试跳过；本地两端 HTTP 合同测试使用模型替身。真实 `gpt-5.4` 编译与独立复核仍出现原始观察和取舍引用不完整对应，最终合同拒绝交付，尚无稳定通过的真实提取验收。完整成图验收由 Memebuy 记录为 9/16，未达到 #944 的 13/16。当前为未部署的待验收实现，不能据静态检查宣布可上线。

模型问题不得通过补造观察、自动清空复核问题或放宽引用校验绕过；下一步必须保留失败证据验证分析与取舍的完整闭环，并在真实服务环境完成新模板入库和试跑。

## 同一观察支持多条事实

v3 的一条观察可以对应全局画风及目标外观/姿势的不同事实。复核将它们分组为多个 retain 记录时，只要引用互不重复且均有效，就视为同一个保留决定；不合并或改写原文、记录顺序与复核摘要。相同观察的 retain/omit 冲突、重复引用、缺失观察、无效事实、未引用目标以及复核失败仍拒绝。v1 没有目标事实的旧合同保持原严格单项对账。该调整只作用于内部候选校验，不修改公开 JSON、调用预算、已保存模板或运行版本。

回归覆盖：同观察分组引用、冲突决定、重复事实、观察缺失、候选不可变以及原始真实失败响应的摘要验证。视觉效果仍须独立验收。

## 后续复核状态（2026-10-23）

同一观察支持多条事实的修复后，已有一次真实编译与独立复核成功，
共两次模型调用，结果通过 Memebuy v3 合同校验；前次连接失败证据保留。
该验收仍以本地批准图片加载替身替代公网下载，不能视作已部署服务的全链路验收。
Memebuy 另完成两轮旧模板人工归属审核、创建新版本及正式任务出图，
均未带回旧白色猫身体；这两轮不包含新提取模板的入库采用。
下一步仍需真实服务的新提取 → 入库采用 → 试跑闭环，不能据此宣布 #944 完成。
