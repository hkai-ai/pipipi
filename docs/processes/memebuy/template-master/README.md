# template-master/v1

由原图与第 2 块解析结果自动出母版（印花版）。母版即模板封面、生成参考图与产出该有的样子。接口字段见 [API 文档](../../../api.md#母版生成template-masterv1)。

## 输入模式与上游产物解析

支持两种互斥输入模式（`z.union`）：

- **`sourceRunId` 模式（推荐）**：仅提交 `{ imageUrl, sourceRunId, budget }`。受理阶段在入队前按当前 `callerId` 校验上游运行归属、流程类型（`template-from-image`）、终态（`succeeded`）、未过期及输出含合法 v4 `template` 与 `source.condition`，解析完成后写入不可变 `acceptedInput` 快照并保留 `sourceRunId` 供控制台一键回溯；校验失败返回 HTTP 400（`SOURCE_RUN_*`），零计费且不占用 `Idempotency-Key`。
- **兼容直传模式**：提交 `{ imageUrl, template, condition, budget }`。`template` 与 `template.metadata` 允许并忽略未知扩展字段，`title`（1–80 字）、`description`（`string | null` / 可选，0–300 字）与 `metadata.tags`（可选、不限条数与单标签长度）对齐上游 `template-from-image/v3` 输出；仍强制校验 `imageUrl`、`condition`、`budget`、`template.key`、`template.inputSchema`（`version: 2`）与 `template.runtimeSemantics`（`version: 4`）。

## 分档

起始档由 `condition` 推出，像素清晰度不参与：

| 档 | 判据 | 做法 |
| --- | --- | --- |
| 轻 | `marks` 为空、`sharpness=clear`、无压缩痕迹、`carrier=flat_artwork` | 纯确定性（sharp），不调模型 |
| 重 | `carrier` 为实拍类，或 `sharpness=severely_blurry` | 按 designSpec 默认值重绘，原图完整附上 |
| 中 | 其余 | 以原图为参考修复，只去 `marks` 与修复画质 |

轻档不过升中，中档用尽升重，重档用尽失败。生成档首次加最多 2 次带原因重试；轻档失败直接升档。

## 色键与透明

`standalone` 的轻档做四边连通色键（容差、边缘均匀度、抗锯齿带容差见 `thresholds.ts`）：从四边扩散去掉接近边缘主色的像素，被框线围住的同色区保留；边缘不均匀（照片、渐变）时不处理，由可印校验拦下后升档。原图已有透明则保留；`rect_patch` / `bleed_crop` 原样转 PNG。

中、重档不要求模型直出透明：让模型在纯色底上出图（中档保持原衬底色，重档用与色板差异大的纯色），再用同一色键去底。理由是模型直出的 alpha 常带半透明光晕，色键结果确定、可复验。代价是图案内部与边缘相连的同色元素会被一并去掉，由版面与相似度校验兜底。有文字的图不使用主体分割抠图。

## 对照校验

每次产出后：确定性 `printable`、`palette`、`similarity`（重档为 null）；全部通过才调用一次多模态模型校验 `text`（逐字比较，归一化只做空白与大小写，清单外文字与残留水印也计入 text）与 `layout`。确定性项不过时不付模型校验费。阈值与来源见 `src/processes/template-master/thresholds.ts`；相似度阈值尚未用真实样本标定。

OpenAI 校验请求使用与本地校验同源的严格 JSON Schema。校验活动记录脱敏的请求、响应、JSON 或字段错误分类。候选母版通过校验后才上传；校验中断的运行没有可恢复的母版文件。

`palette` 只比较 `defaults.colors` 中能解析出 `#rrggbb` / `rgb()` 的颜色；全是颜色名时不判定。

## 预算与失败

`maxAttempts` 计每次出图或加工（含轻档）；已知费用累计达到 `maxUsd` 前停止（`maxUsd=0` 即不执行）。次数或金额用尽返回 `MASTER_BUDGET_EXHAUSTED`，档位用尽返回 `MASTER_NOT_ACCEPTED`，均不返回未通过的图。费用未知的改图调用不计入金额，会在失败说明中标注。通过后上传失败：已有付费改图为 `DEPENDENCY_FAILURE_AFTER_COMMIT`，否则 `DEPENDENCY_FAILURE`。

## 执行时限

Registration 预算 2400 秒：轻档 1 次校验加中、重档各 3 次（改图 200 秒、校验 90 秒、加工）以及读图与上传，最坏约 2020 秒。尝试数最多 7 次，与 `maxAttempts` 无关。同步 `/execute` 经网关通常只有 540 秒，**只能用于次数很小的预算，调用方应使用 `/process-runs`**；Worker 租约自动取目录内最长预算加 30 秒。

## 部署

先发布新增 `018`（process_runs 错误码约束）与 `021`（process_run_records `source_run_id` / `failure_detail` 观测列）迁移，再发布 API、Worker 与 Business API；Business API 新增 `/template-master/edit`、`/template-master/upload`，复用已配置的图片编辑与模板公读存储。Skill `template-master-method@v1` 由团队 Skills 仓库生成并按[准确版本](../../../runtime-skill-versioning.md)同步。
