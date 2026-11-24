# template-master/v1

由原图与第 2 块解析结果自动出母版（印花版）。母版即模板封面、生成参考图与产出该有的样子。接口字段见 [API 文档](../../../api.md#母版生成template-masterv1)。

## 输入模式与上游产物解析

支持两种互斥输入模式（`z.union`）：

- **`sourceRunId` 模式（推荐）**：仅提交 `{ imageUrl, sourceRunId, budget }`。受理阶段在入队前按当前 `callerId` 校验上游运行归属、流程类型（`template-from-image`）、终态（`succeeded`）、未过期及输出含合法 v4 `template` 与 `source.condition`，解析完成后将模板、原图状况和可用的 `source.texts` 写入不可变 `acceptedInput` 快照并保留 `sourceRunId` 供控制台一键回溯；校验失败返回 HTTP 400（`SOURCE_RUN_*`），零计费且不占用 `Idempotency-Key`。
- **兼容直传模式**：提交 `{ imageUrl, template, condition, sourceTexts?, budget }`。`template` 与 `template.metadata` 允许并忽略未知扩展字段，`title`（1–80 字）、`description`（`string | null` / 可选，0–300 字）与 `metadata.tags`（可选、不限条数与单标签长度）对齐上游 `template-from-image/v3` 输出；`sourceTexts`（可选，格式同上游 `source.texts`）用于直传权威逐字原文；仍强制校验 `imageUrl`、`condition`、`budget`、`template.key`、`template.inputSchema`（`version: 2`）与 `template.runtimeSemantics`（`version: 4`）。

## 分档

先按 `condition` 选择起始档。

| 档 | 判据 | 做法 |
| --- | --- | --- |
| 轻 | `marks` 为空、`sharpness=clear`、无压缩痕迹、`carrier=flat_artwork` | 直接使用原图，按印花形态尝试色键或转 PNG，文字与版面沿用原图，零模型调用 |
| 重 | `carrier` 为实拍类，或 `sharpness=severely_blurry` | 按 designSpec 默认值重绘，原图完整附上 |
| 中 | 其余 | 以原图为参考修复，只去 `marks` 与修复画质 |

轻档或中档候选仅在存在权威逐字原文（上游 `source.texts` 或直传 `sourceTexts`）且按元素 ID 归一化后与 `defaults.texts` 不一致时，直接从重档开始，首条实际尝试的 `reason` 记录「默认文字与原图记录不一致，跳过原图处理和 AI 修复」。不回落到文字元素的 `instance`（其语义为视觉外观证据，非逐字原文），也不再基于 `originalObject` 与 `defaults.subject` 的自然语言文本猜测主体冲突。缺少权威逐字原文时沿用状况分档。跳过的档位不计尝试次数。

轻档只加工一次。中档和重档各可带原因重试两次，中档用尽升重档，重档用尽失败。

中、重档的出图提示要求保留弧线、圆环和波浪文字的路径、阅读起点和方向。轻档只做像素加工，保留原图排布。

## 色键与透明

`standalone` 的轻档做四边连通色键（容差、边缘均匀度、抗锯齿带容差见 `thresholds.ts`）：从四边扩散去掉接近边缘主色的像素，被框线围住的同色区保留；边缘不均匀（如渐变底）时色键保留背景。尝试色键后，可印性、配色或相似度未通过时，从原图重新按 EXIF 摆正并转 PNG。原图通过不透明 PNG 的格式、尺寸、色板与相似度检查后即交付，报告标记背景未去除。原图本身仍不符合这些要求时，轻档直接失败。原图已有透明则保留；`rect_patch` / `bleed_crop` 原样转 PNG。

中、重档不要求模型直出透明：让模型在纯色底上出图（中档保持原衬底色，重档用与色板差异大的纯色），再用同一色键去底。理由是模型直出的 alpha 常带半透明光晕，色键结果确定、可复验。代价是图案内部与边缘相连的同色元素会被一并去掉，由版面与相似度校验兜底。有文字的图不使用主体分割抠图。

## 对照校验

每次产出后先检查 `printable` 和 `palette`，轻档和中档还检查像素 `similarity`。轻档像素来自原图，`palette` 不符只说明解析的默认颜色有误，不判失败。轻档按原图像素判定文字与版面通过，文字报告的预期值和读取值都取模板默认文字，尝试原因注明未调用模型读字。保留背景交付时，尝试通过，独立图形的可印性仍记为未通过。中、重档的确定性检查全部通过后，调用多模态模型校验文字、版面和残留标记。阈值与来源见 `src/processes/template-master/thresholds.ts`，相似度阈值尚未用真实样本标定。

重档在同一次多模态校验中追加原图参考，比较主体身份、构图和主要元素、设计文字内容及主要配色，同时核对主体身份是否符合模板默认主体。允许移除载体、褶皱、透视、场景背景和应去掉的标记。无法确认保真时按失败处理，记录 `check: "similarity"`，详情为「重档母版未通过原图设计保真校验」。重档成功的 `checks.similarity` 仍为 null，表示未计算像素分数。历史默认文字或主体与原图有实质冲突时，重绘仍可能失败。

校验模型沿原设计的起点和方向读取弯曲文字，把整段归入对应元素。程序以 `designSpec.defaults.texts` 为准，统一 NFKC、大小写、空白、等价引号和横线后逐字比较。归一化后相同即通过。

每个仍有差异的元素在 `attempts[].failures[].detail` 中记录元素 ID 和类别。分类按下表顺序匹配。

| 类别 | 判定 |
| --- | --- |
| 读取为空 | 元素未返回，或归一化后的读取值为空 |
| 仅标点或空白差异 | 仍有未归一化掉的标点差异，移除标点后逐字一致 |
| 缺字 / 多字 | 较短的一侧可由较长的一侧仅删除字符得到 |
| 文字顺序不同 | 字符及各自的出现次数相同，顺序不同 |
| 文字内容不同 | 其余内容差异，包括换字及换字与增删混合 |
| 出现清单外文字 N 处 | 统计模型单独返回的非空清单外文字 |
| 原图水印、署名或标识仍可见 | 校验模型判定仍能看见要求移除的标记 |

OpenAI 校验请求使用与本地校验同源的严格 JSON Schema。校验活动记录脱敏的请求、响应、JSON 或字段错误分类。候选母版通过校验后才上传；校验中断的运行没有可恢复的母版文件。

`palette` 只比较 `defaults.colors` 中能解析出 `#rrggbb` / `rgb()` 的颜色；全是颜色名时不判定。

## 预算与失败

`maxAttempts` 计每次出图或加工（含轻档）；已知费用累计达到 `maxUsd` 前停止（`maxUsd=0` 即不执行）。次数或金额用尽返回 `MASTER_BUDGET_EXHAUSTED`，档位用尽返回 `MASTER_NOT_ACCEPTED`，均不返回未通过的图。费用未知的改图调用不计入金额，会在失败说明中标注。通过后上传失败：已有付费改图为 `DEPENDENCY_FAILURE_AFTER_COMMIT`，否则 `DEPENDENCY_FAILURE`。

预算耗尽时，若最后一次尝试有文字失败，错误消息会在「最后失败项」后附上文字差异说明，超长时按条目省略。尝试的文字失败详情和公开消息中的文字差异说明仅含元素 ID、差异类别或清单外文字数量。格式与兼容性见 [母版生成 API](../../../api.md#母版生成template-masterv1)。

## 执行时限

Registration 预算 2400 秒：轻档仅本地加工，最长路径为中、重档各 3 次（改图 200 秒、校验 90 秒、加工）以及读图与上传。生成档最多尝试 6 次，实际次数受 `maxAttempts` 限制。同步 `/execute` 经网关通常只有 540 秒，**只能用于次数很小的预算，调用方应使用 `/process-runs`**；Worker 租约自动取目录内最长预算加 30 秒。

## 部署

先发布新增 `018`（process_runs 错误码约束）与 `021`（process_run_records `source_run_id` / `failure_detail` 观测列）迁移，再发布 API、Worker 与 Business API；Business API 新增 `/template-master/edit`、`/template-master/upload`，复用已配置的图片编辑与模板公读存储。Skill `template-master-method@v1` 由团队 Skills 仓库生成并按[准确版本](../../../runtime-skill-versioning.md)同步。
