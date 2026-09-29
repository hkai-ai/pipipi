# `photo-fashion-manga/v1` Business Process

面向把真实单人照片重绘为日式时装漫画的调用方。准确输入输出、默认文案和错误见 [API 文档](../../../api.md#日式时装漫画文案)。输出单张 1200×1600 PNG，保留人物辨认锚点、动作、服装类别和可见身体范围，采用墨黑轻线、红蓝平涂、米白纸底和手刻标题。

## 执行与依赖

服务端绑定 `photo-fashion-manga-prompt@v1`，无 Tool Agent 编译固定画风；图片 URL 与最终文案不进入文本 Agent。无衬线手刻粗字、服装轮廓与紧凑字图关系由服务端在编译前传入，并在生图前重申；引题与小注围绕头肩留白排列，保留可读笔画及克制纸纹。Registration 在编译后追加逐项解析的文字，再通过共享 Photo Poster Rendering Capability 单次生成与存储，使用同一 `runId` 作为下游幂等键。复用现有照片海报超时、取消、背景、错误净化与异步执行，不新增启动变量或独立图片 Adapter。

接口只接收一张人物照片，画风由固定 Skill 提供；不接受第二张风格图、Prompt、模型或 Skill 路径。文本约束由图片模型执行，Schema 与尺寸验证不证明人物、文案及画风已通过视觉验收。

## 来源与维护

来源为用户提供的提示词及本地 Skill，已适配为随应用发布的单文件 Runtime Skill；来源摘要、许可与适配差异见 [SOURCE.md](../../../../.pi/skills/photo-fashion-manga-prompt/SOURCE.md)。注册与文案规则在 [`src/processes/photo-poster/`](../../../../src/processes/photo-poster/)，显式生产目录在 [`src/processes/catalog.ts`](../../../../src/processes/catalog.ts)。Dockerfile、忽略规则与 LF 约束确保镜像包含固定字节；回滚恢复上一个完整应用制品。

## 验证与发布

确定性验证见 [`test/photo-poster.test.ts`](../../../../test/photo-poster.test.ts) 与 [`test/photo-poster-agent.test.ts`](../../../../test/photo-poster-agent.test.ts)：正式 HTTP、精确版本、默认/覆盖/删除文案、敏感输入隔离、单次图片调用和固定 Skill 加载。发布仍需完成全仓检查及镜像内无网络、非 root 的完整 catalog 校验。

真实测试按[照片海报业务验收](../../../experiments.md#照片海报业务验收)，选择 `PHOTO_POSTER_ACCEPTANCE_STYLES=photo-fashion-manga`，会产生一次文本模型调用、一次图片调用与配置存储写入。失败不自动重绘；成图需人工核对原照片。代码接入与本地实测均不等于线上已部署或 Memebuy 已上架。
