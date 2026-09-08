# 双色油墨图文海报

本页说明 `mono-color-photo-poster/v1` 的行为与接入边界，供 Memebuy 照片模板及复用该契约的产品使用。HTTP 输入输出、错误与调用示例统一见 [API 文档](../../../api.md#照片海报)。

## 执行与依赖

读取固定 `mono-color-photo-poster-prompt@v1`，无 Tool Agent 编译内部英文规则；Registration 校验后调用共享 Photo Poster Rendering Capability。内部 `POST /photo-posters` 使用 FAL GPT Image 2 编辑并保存 PNG，配置 OSS 时返回持久化 URL。每请求处理一张原图，最多一次图片调用，以 runId 作为幂等键；不自动重绘。

公网 HTTPS 原图 URL 原样交给 FAL，服务端不下载原图。输出为 1200×1600 PNG。完整画面采用双色网点、主体和大字穿插，不做上下分屏。

## 可编辑预设

同一 `v1` 兼容增加五个可选预设：伸手穿字、斜切窥视、正面宣言、手势取景框、侧身斜排。默认搭配与结构化覆盖由 [mono-color.ts](../../../../src/processes/photo-poster/mono-color.ts) 拥有；Registration 在编译前传入服务端解析的设计约束，并在最终图片指令中重申，避免 Skill 自选配色与预设冲突。原图 URL、用户文字和补充说明不进入文本 Agent。请求没有新增设计参数时保留旧行为，不修改冻结 Runtime Skill 的字节或版本。

Memebuy 以五个独立 C 类模板绑定稳定的能力键，由代码固定 preset，用户仅上传参考图并可选填写文字。preset 采用描述配色与版式的新标识；旧值在 Pipipi 输入 Schema 统一转换，能力键与模板版本不随业务参数改名。旧 `gallery.mono_color` 保留历史兼容；Pipipi 的可编辑参数继续兼容旧调用。补充说明只作为受限设计数据，不能选择执行配置。预设适应真实参考图的主体和动作，输出依然是完整平面成品；不是可编辑文字或分层文件。

## 来源与适配

来源、固定 revision、哈希、许可和适配差异见 [SOURCE.md](../../../../.pi/skills/mono-color-photo-poster-prompt/SOURCE.md)。本地 Runtime 不运行第三方脚本，也不下载或更新远程 Skill。

正式发布前确认来源使用许可；mono-color 的指令为 MIT，示例图不随服务分发。

## 验证与限制

实现：[Registration](../../../../src/processes/photo-poster/registration.ts)、[图片服务](../../../../src/business-api/photo-poster.ts)。确定性验证：[契约与 HTTP 测试](../../../../test/photo-poster.test.ts)。真实验证通过 `npm run accept:photo-poster-business`，说明见 [实验](../../../experiments.md#照片海报业务验收)。

图片生成与 OSS 有费用和外部写入。调用方需确认原图使用权与资产保留策略。规则编译失败为 AGENT_FAILURE；图片调用已发出且失败或状态不确定时保守返回 DEPENDENCY_FAILURE_AFTER_COMMIT，不能自动重试。尺寸和格式通过不等于视觉风格通过；文字正确性和主体保真需要人工验收。

## 2026-09-07 本地实测

本样图符合双色油墨、巨型标题与主体穿插、网点质感；未取得原帖私有魔改提示词，不能视为原帖复刻。技术链路一次 POST /execute、一次 FAL GPT Image 2 编辑、一次 OSS 存储与结果回读通过。详见 [本次验收记录](../../../experiments.md#2026-09-07-照片海报实测)。
