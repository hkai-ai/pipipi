# product-remix/v1

面向 Memebuy「商品做同款」（`kind = "product.remix"`）的异步持久 Business Process。调用方通过 `/process-runs` 提交商品印花原图、可选用户参考照片、用户编辑意图与预算上限，Pipipi 内部自动完成复杂度分档、平面印花改图指令编译、图片生成、VLM 视觉质检闭环与受控产物上传。完整 HTTP 契约与调度规则见 [API 文档](../../../api.md#商品做同款product-remixv1)。

## 核心领域原则

- **单层视觉基准（Single-Layer Base）**：`sourceImageUrl` 是用户在当前商品印制面上看到的印花原图，作为唯一的视觉风格与版式基准；调用方不传入历史生图 Prompt。可选的 `referenceImageUrl` 或 `referenceImageUrls`（最多 9 张，按上传顺序）仅提供人物、宠物、物体或 Logo 等可见主体/特征，严禁把参考照的杂乱摄影背景带入成图。
- **内部自动分档（`resolvedTier`）**：复杂度判断收敛在 `product-remix/v1` 内部，Agent 根据原图、参考图与 `userText` 自动路由至 `light`（局部改字/换色/微调，最大化保留原图构图）、`medium`（主体替换或同款风格融合）或 `heavy`（大幅动作、主题或多元素重构），并在成功结果中回传 `resolvedTier` 与采用的 `modelName`。
- **显式失败、绝不回显原图**：任一阶段失败、预算用尽或尝试次数耗尽均落受控 `failed` 终态及稳定 `error.code`，绝不把 `sourceImageUrl` 或任何参考图地址当作兜底成图返回。

## 契约与 URL 红线

- **入口与超时**：推荐通过 `POST /process-runs`（携带 `Idempotency-Key` 与 `Authorization: Bearer <ppk_...>`）提交、`GET /process-runs/{runId}` 轮询，并在 `GET /processes` 列表中暴露 `product-remix`（`v1`）。Process 硬超时固定为 `660_000` ms（11 分钟，低于 Memebuy 侧 900 秒总超时），确保由 Pipipi 先收敛 `PROCESS_TIMEOUT`。
- **严格输入（`productRemixInputSchema`）**：
  - `sourceImageUrl`：公网 HTTPS 原图 URL（见下方 URL 红线）。
  - `referenceImageUrl` / `referenceImageUrls`（可选，两者互斥）：单张短期签名/公网参考图 URL，或 0–9 张有序参考图 URL 数组。
  - `userText`：已过出站文本审核的编辑意图（去首尾空白后 1–2000 字符）。
  - `imageSize`（可选）：`WxH` 格式目标尺寸（64–8192 像素），将映射为最接近的正典尺寸（`1024x1024`、`896x1152`、`1152x896`、`768x1344`、`1344x768`）；省略时按原图宽高比自动匹配。
  - `budget`：`{ maxAttempts: 1..10, maxUsd: > 0 且 <= 20 }`。
- **成功产物（`productRemixOutputSchema`）与 URL 三条红线**：成功返回 `{ image: { url, width, height }, modelName, resolvedTier }`，并在异步顶层 `cost` 汇总本次运行实际已知 USD 费用。成图 URL 必须同时满足：
  1. `GET` 直取返回 HTTP `200` 与 PNG 字节流，**禁止任何 301/302/307/308 重定向**；
  2. 为合法公网原图 `https:` URL（长度 <= 2048，无显式端口、无用户名密码、无 `#hash`、非 `localhost`/纯 IP，不含 `x-oss-process` 参数）；
  3. 对 `output.image.url`、 `sourceImageUrl` 与全部参考图 URL 做 SHA-256 比对，**绝不回显任何输入 URL**。

## 内部编排与创作/质检守则

Process Registration 固定声明五个运行活动：`remix_source_loading` → `remix_planning` → `remix_generation` → `remix_verification` → `remix_upload`：

1. **取图与解码（`remix_source_loading`）**：通过 `downloadSourcePhoto` 安全拉取原图与参考图（静态 PNG/JPEG/WebP，宽高 >= 64 像素，像素 <= 4000 万），生成编辑用 PNG（最长边 2048 像素）与 VLM 观察用 WebP（<= 112 KiB）。读取或解码失败在零模型调用前返回 `INVALID_INPUT`。
2. **分档与方案规划（`remix_planning`）**：无 Tool 的 `PiProductRemixAgent` 加载固定版本 Runtime Skill `product-remix-method@v1`（`thinkingLevel: "low"`，`jsonMode: true`，单次调用上限 90 秒，至多一次结构重试），产出严格 `remixPlanSchema`（含 `tier`、`rationale`、`editPrompt`、`expectedTexts`、`forbiddenTexts`、`keepOriginalStyle`）。
3. **印花硬性创作守则**：`editPrompt` 编译与 VLM 质检共同强制以下四条守则：
   - **No Mockup（只产平面印花）**：严禁出现 T 恤、领口、袖口、衣物褶皱、马克杯、手机壳、帆布袋、衣架、人体模特或商品摆拍背景；
   - **画风延续**：延续图 1 的造型语言、线条粗细、笔触质感、上色方式、配色体系与字体气质（除非用户明确要求换画风）；
   - **文字处理**：绝不把 `userText` 指令原文当成画面文字印出，按语义保留、替换或移除文字，拼写与字形须清晰可读；
   - **安全留白不裁切**：核心主体、文字与装饰居中分布，四周保留连续空白边距，不贴边、不被截断。
4. **预算门禁、生图与 VLM 质检闭环**：
   - 在 `remix_planning`、每轮 `remix_generation`（`1..maxAttempts`）以及 `remix_verification` 前，均检查 `spent() < budget.maxUsd`；预算耗尽立即失败并返回 `AGENT_FAILURE`。
   - 生图调用内部 Business API `POST /product-remix/edit`（请求体上限 `205_000_000` 字节以容纳 1 张原图与最多 9 张参考图），使用 `${runId}-remix-${attempt}` 作为下游幂等键。若模型明确拒绝（`rejected`），会把拒因注入下一轮重写提示后再试；若最终尝试仍被拒绝且未产出任何候选图，返回 `DEPENDENCY_FAILURE`。
   - 对有效 PNG（64–4096 像素、<= 20 MB）调用 VLM 质检（核验 `intentFollowed`、`textAccurate`、`noMockup`、`notCropped` 与最多 8 条中文 `issues`）。未通过且仍有预算与尝试次数时，将 `issues` 注入下一轮 `buildRemixEditPrompt` 修正提示继续迭代；全部尝试耗尽仍未通过则返回 `AGENT_FAILURE`。
5. **受控上传（`remix_upload`）**：质检通过后调用 `POST /product-remix/upload` 上传至 `product-remix/<sha256>.png` 并核验返回 URL 红线与防回显校验；上传异常返回 `DEPENDENCY_FAILURE`，字节或 URL 违规则返回 `INVALID_OUTPUT`。

## 错误码映射

| `error.code` | 触发条件 |
| --- | --- |
| `INVALID_INPUT` | 入参未通过 `productRemixInputSchema`（在入队/调用前拦截，不占用 `Idempotency-Key`），或输入图读取/解码失败 |
| `PROCESS_NOT_FOUND` | 未注册的 `process` 或 `version` |
| `PROCESS_TIMEOUT` | 单次执行超过 `660_000` ms 硬超时 |
| `AGENT_FAILURE` | 规划/质检输出无法解析、已知费用达到 `budget.maxUsd` 或耗尽 `budget.maxAttempts` 仍未通过质检 |
| `DEPENDENCY_FAILURE` | 上游多模态模型连接/限流/鉴权/不可用异常、内部图片生成服务异常/最终拒绝，或对象存储上传失败 |
| `INVALID_OUTPUT` | 生成结果非合法 PNG 字节，或上传 URL 违反公网原图红线 / 回显了输入 URL |
| `INTERNAL_ERROR` | 未预期内部异常或外部取消 |

## 代码、测试与配置

- **Process Definition 与 Registration**：
  - 契约与 URL/尺寸校验：[`src/processes/product-remix/contract.ts`](../../../../src/processes/product-remix/contract.ts)
  - 方法守则与 Prompt 编译（Skill 唯一来源）：[`src/processes/product-remix/method.ts`](../../../../src/processes/product-remix/method.ts)
  - 图像解码、VLM 视图编码与 PNG 校验：[`src/processes/product-remix/image.ts`](../../../../src/processes/product-remix/image.ts)
  - Agent Interface 与 Pi 实现：[`src/processes/product-remix/agent.ts`](../../../../src/processes/product-remix/agent.ts)、[`src/processes/product-remix/agent.pi.ts`](../../../../src/processes/product-remix/agent.pi.ts)
  - Business Capability 与 HTTP Adapter：[`src/processes/product-remix/capability.ts`](../../../../src/processes/product-remix/capability.ts)、[`src/processes/product-remix/capability.http.ts`](../../../../src/processes/product-remix/capability.http.ts)
  - Registration、生产绑定与目录入口：[`src/processes/product-remix/registration.ts`](../../../../src/processes/product-remix/registration.ts)、[`src/processes/product-remix/production.ts`](../../../../src/processes/product-remix/production.ts)、[`src/processes/catalog.ts`](../../../../src/processes/catalog.ts)
- **内部 Business API 与多参考图编辑支持**：
  - 改图与受控上传服务：[`src/business-api/product-remix.ts`](../../../../src/business-api/product-remix.ts)、[`src/business-api/crt-server.ts`](../../../../src/business-api/crt-server.ts)
  - 多图表单扩展：[`src/business-api/template-image-editor.ts`](../../../../src/business-api/template-image-editor.ts)、[`src/business-api/openai-image-generation.ts`](../../../../src/business-api/openai-image-generation.ts)、[`src/business-api/fal-image-generation.ts`](../../../../src/business-api/fal-image-generation.ts)
- **Runtime Skill**：[`product-remix-method@v1`](../../../../.pi/skills/product-remix-method/SKILL.md) 由 [`tools/build-product-remix-skill.ts`](../../../../tools/build-product-remix-skill.ts) 生成并校验摘要；修改 `method.ts` 后须重新生成并用 `--check` 验证，同时在 `.gitattributes`、`Dockerfile` 与 `.dockerignore` 保持锁定同步。
- **环境变量与迁移**：复用现有 `CRT_BUSINESS_API_BASE_URL` 与 `TEMPLATE_MODEL`，不新增环境变量；数据库复用已有异步运行迁移（`018` 已覆盖全部受控错误码）。
- **确定性测试**：
  - 契约、分档、质检重试、预算熔断、防回显与 Pi 会话重试：[`test/product-remix.test.ts`](../../../../test/product-remix.test.ts)
  - HTTP `/processes` 发现、`/process-runs` 幂等与背压、`cost` 与超时终态：[`test/product-remix-http.test.ts`](../../../../test/product-remix-http.test.ts)
  - 内部 Business API 服务、`image[]` 多图上传与 `x-pipipi-cost-ledger` 账本回传：[`test/product-remix-service.test.ts`](../../../../test/product-remix-service.test.ts)
  - 真实多模态模型、图像模型与对象存储端到端 smoke 需要真实凭证与外网访问并会产生费用，须按 [`docs/experiments.md`](../../../experiments.md) 单独显式执行，不包含在默认 `npm test` 内。
