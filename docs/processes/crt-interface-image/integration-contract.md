# `crt-interface-image/v1` 接入契约

本文面向接入 `crt-interface-image/v1` 的外部调用方，以及维护该契约的开发者。它记录调用方可以依赖的当前行为、已经对齐但尚未实现的计划，以及这次对齐固定下来的设计决定。

精确运行行为仍以 `src/` 与 `test/` 为准；Process 的实现说明、后处理算法和验收步骤见 [`README.md`](README.md)。本文不复制配置清单、发布步骤或证据目录结构。

## 当前结论

- 产品只有一个业务入口 `POST /execute`。新增能力表现为新的 `process` 值，不新增路径。
- `/execute` 同步返回终态，不返回中间态。异步入口是独立路径，不改变 `/execute` 的语义。
- 失败一律用 HTTP 状态码表达，不存在 `200` 携带 `status: "failed"` 的响应。
- 应用层当前不做鉴权，依赖 TLS 网关。
- `/execute` 当前没有幂等键。调用方在传输层失败后不应自动重投。

## 当前行为

以下行为已经实现，调用方可以依赖。

### 请求与响应

请求体、输出结构、`sourceImageUrl` 约束、调色板与画幅取值以 [`README.md` 的「当前产品契约」](README.md#当前产品契约) 为准。本文只补充调用方需要额外知道的传输与语义细节：

- `POST /execute` 只接受 `application/json`，请求体上限 `HTTP_MAX_REQUEST_BODY_BYTES`（默认 262144 字节）。
- `input` 是 strict object，多余字段判为 `INVALID_INPUT`。
- `expiresAt` 是 **URL 的有效期，不是对象的生命周期**。链接过期后重新获取即可，对象本身不受影响。调用方按该字段判断何时重新取链接，不要硬编码有效期。
- 四种画幅的长边分别是 1600（`3:4`、`4:3`）与 2048（`9:16`、`16:9`），这是印刷链路的实际上限。

### 后处理的分辨率语义

模型按所选画幅的固定尺寸原生出图，输出前不放大。随后 finalizer 把模型输出降采样到 `width / blockSize × height / blockSize`（当前 `blockSize` 为 4，最近邻），再逐像素量化到 2–5 色调色板，并叠加扫描线、棋盘格、边缘扰动与固定签名。

因此产物的实际信息量是一张色块网格加少量 1 像素级结构，而不是连续色调图像。调用方放大产物时必须使用整数倍最近邻：

- 每个像素都是调色板中的精确颜色，整数倍最近邻放大是无损的。
- 双线性、双三次或 ML 超分会插值出调色板之外的颜色，破坏「输出只使用选定调色板」这条约束，并糊掉扫描线与点阵签名。对象存储的服务端缩放同样属于这一类。

`如图` 调色板从**模型输出**提取，不从调用方的源图提取。

### 确定性

`finalizeCrtImage` 对同一份模型输出是字节级确定性的：相同输入在独立进程中产出相同的 PNG 摘要，固定调色板与 `如图` 都成立。实测单次耗时约 224 ms（`4:3`）与 272 ms（`16:9`），不含模型调用。

复现方式（不联网、不产生费用，需要先 `npm run build`）：对同一份 PNG 重复调用 `finalizeCrtImage`，比较输出字节。

### 错误契约

各错误码的触发条件见 [`README.md` 的「错误契约」](README.md#错误契约)。本文补充调用方分支所需的 HTTP 状态码与计费归属：

| 错误码 | HTTP | 是否已产生模型费用 |
| --- | ---: | --- |
| `INVALID_INPUT` | 400 | 否，校验早于 Agent 与图片服务 |
| `PROCESS_NOT_FOUND` | 404 | 否 |
| `AGENT_FAILURE` | 502 | 仅 Agent 费用；Prompt 最多编译 2 次 |
| `DEPENDENCY_FAILURE` | 502 | 取决于失败点，当前无法从错误码区分 |
| `INVALID_OUTPUT` | 500 | 是 |
| `PROCESS_TIMEOUT` | 504 | **未知**，取消不保证供应商未计费 |
| `INTERNAL_ERROR` | 500 | 取决于失败点 |

传输层拒绝使用相同的响应体形状，但**不携带 `runId`、`process` 或 `version`**：

| 错误码 | HTTP | 条件 |
| --- | ---: | --- |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` 不是 `application/json` |
| `REQUEST_TOO_LARGE` | 413 | 请求体超过上限 |
| `SERVICE_BUSY` | 503 | 并发闸门已满，附 `Retry-After: 1` |
| `ROUTE_NOT_FOUND` | 404 | 路径或方法不匹配 |
| `INTERNAL_ERROR` | 500 | 请求处理抛出未捕获异常 |

`runId` 在请求校验之前生成，因此所有进入执行器的失败都带 `runId`；只有上表的传输层拒绝没有。

参考图读取失败归入 `DEPENDENCY_FAILURE`，不归入 `INVALID_INPUT`。`INVALID_INPUT` 只来自字段与 URL 形状校验。

### 重试语义

调用方当前可以安全自动重投的只有 `503 SERVICE_BUSY`：它发生在执行之前，不产生任何模型调用。其余失败一律不自动重投。

`/execute` 没有幂等键，服务端为每个请求生成新的 `runId` 并把它作为下游 Business Capability 的幂等键。因此调用方重投一定产生新的 `runId` 和新的一次计费，传输层失败无法区分「请求未送达」与「已执行但响应丢失」。

### 容量与超时

- 并发闸门 `MAX_CONCURRENT_EXECUTIONS` 默认 4，作用域是**单个 Node 进程**，不排队，超出立即返回 `503 SERVICE_BUSY`。
- 没有 QPS 或日配额。
- `PROCESS_TIMEOUT_MS` 默认 30000，`CRT_API_TIMEOUT_MS` 默认 180000。调用方断开连接会取消下游渲染，但供应商侧可能已经产生费用。

> 已知配置问题：[`README.md`](README.md) 的发布门禁要求 `PROCESS_TIMEOUT_MS` 长于 `CRT_API_TIMEOUT_MS`，而代码默认值相反。生产实际取值以部署 Secret 为准，不以代码默认值为准。

### 鉴权

`/execute` 不读取任何认证头。生产依赖发布门禁「容器不暴露公网、只经 TLS 网关」，这是运维配置约束，不是代码保证。[`src/api/identity.ts`](../../../src/api/identity.ts) 的网关身份校验当前只挂在异步入口上。

### 异步入口（已实现，默认关闭）

`POST /process-runs` 与 `GET /process-runs/{runId}` 已经实现，生产 Compose 固定 `ASYNC_PROCESS_RUNS_ENABLED=false`。启用后的语义：

- 强制要求 `Idempotency-Key`（最长 512 字节），幂等作用域是 `(callerId, idempotencyKey)`。
- 同 key 且请求指纹相同 → **`202` 返回原 `runId`**，不重新入队、不重新执行、不重复计费。指纹算的是 Registration 归一化后的输入，不是原始字节。
- 同 key 但指纹不同 → `409 IDEMPOTENCY_CONFLICT`。
- 重放返回的 `202` 响应体 `status` 当前恒为 `queued`，即使该 Run 已终结。调用方应只取 `runId`，状态一律通过 `GET` 获取。
- 准入上限 `ASYNC_CALLER_BACKLOG_LIMIT` 按 caller 计，`ASYNC_GLOBAL_BACKLOG_LIMIT` 按全局计，两者统计的都是 `queued` 与 `running` 之和。
- 超限返回 `429 CALLER_BACKLOG_LIMIT_REACHED` 或 `503 ASYNC_SERVICE_CAPACITY_REACHED`，附 `Retry-After`。
- **`429`、`503 ASYNC_SERVICE_CAPACITY_REACHED` 与 `503 ASYNC_SERVICE_UNAVAILABLE` 都不消耗幂等键。** 接收在单个数据库事务内执行，顺序是幂等重放查询 → backlog 计数 → 写入；超限抛错导致事务整体回滚，不留下任何行。调用方应当用同一个 key 重投，不要生成新 key。
- 提交路径与 `/execute` 的并发闸门无关；执行在独立的 Process Worker 角色中，并发由 `PROCESS_WORKER_CONCURRENCY` 控制。
- 幂等键寿命等于 Run 行的寿命，由 `PROCESS_RUN_METADATA_RETENTION_MS` 控制；输入与结果按 `PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS` 和 `PROCESS_RUN_RESULT_RETENTION_MS` 独立过期。三者都必填、无默认值。

启用需要 PostgreSQL、Redis 与五个独立角色进程，并按 [`async-process-runs-runbook.md`](../../async-process-runs-runbook.md) 的阶段门禁推进。

## 计划

以下内容已与接入方对齐，但**尚未实现**。它们不是当前可依赖的行为。

| 计划项 | 内容 | 主要成本 |
| --- | --- | --- |
| 产物写入调用方 bucket | 对象存储配置指向调用方的 bucket 与凭证，服务端不持有产物 | 纯配置改动 |
| 模型原图上传 | 把 finalizer 之前的模型输出以 `<prefix>/<runId>-raw.png` 写入同一 bucket | 小改，复用现有上传路径 |
| 提交时多档产出 | 一次调用返回多个档位的产物，只重复执行 finalizer，不重复调用模型 | 产品输出契约、内部 API 响应、对象键、证据 manifest |
| 按原图再出档 | 新增纯后处理 Process：接收调用方回传的原图 URL 与档位，不调用模型、不需要 Agent | **首次需要服务端下载调用方 URL**，须过出站控制评审 |
| 档位打包 | `fine` / `normal` / `coarse` 三档，每档绑定 `blockSize` 与扫描线周期；缺省等于当前行为 | 每档一轮视觉验收 |
| `DEPENDENCY_FAILURE` 拆码 | 按模型调用前 / 后拆分，并为内容安全拒绝单列错误码 | 内部 API 发码、Adapter 保留错误码、Registration 分流 |
| `X-Request-Id` 透传 | 读取调用方的 trace id 并写入运行日志 | 小改 |
| `/execute` 鉴权 | 挂上与异步入口相同的网关身份头 | 小改；异步入口按期开放则可跳过 |
| `metadata` 证据模式 | 生产启用 `metadata` 档，并补充失败时写 manifest、Skill 版本、状态与耗时 | 数据授权评审；manifest 需要落库与清理 |

### 档位与扫描线必须绑定

棋盘格周期跟随 `blockSize`（当前为 `blockSize * 2`），但**扫描线周期是独立的固定值 6**，与 `blockSize` 无关。因此只开放 `blockSize` 会让两者的相对关系随取值漂移，产生未经验收的观感组合。档位必须把 `blockSize` 与扫描线周期作为一组发布，这也是采用命名档位而非连续参数的原因。

档位会进入幂等指纹：同一个幂等键换档位重投会得到 `409`，不会得到新结果。

### 再出档的回源约束

再出档需要读取调用方回传的原图 URL。由于该对象由本服务写入调用方的 bucket，回源目标是配置中已知的 endpoint，出站控制可以收敛为一条固定主机白名单。

实现必须校验回传 URL 确实指向已配置的 bucket 与 prefix，不能因为 URL 形状合法就信任它。现有的 `isPublicSourceImageUrl` 只做形状校验，挡不住指向其他主机的地址。

> 与现有规则的冲突：[`AGENTS.md`](../../../AGENTS.md) 的「CRT 图片输入」写明「服务端不下载参考图」。再出档 Process 会打破这条规则。实现该计划时必须同步修订 `AGENTS.md`，不能静默偏离。

## 决策记录

| 决定 | 理由 | 影响 |
| --- | --- | --- |
| 产物直接写入调用方 bucket | 服务端不持有产物，保留期与删除责任归调用方 | 取消服务端侧的产物数据保留评审；转存窗口概念消失 |
| 按原图再出档，而非服务端保留原图 | 载体在生成之后才确定，服务端无法预测需要哪些档位 | 用一次出站控制评审替换一次数据保留评审 |
| 提交时多档产出仅作为过渡 | 绝大多数产物不会被使用，预先生成全档位是浪费 | 终态是按需再出档 |
| 档位使用命名预设而非连续参数 | 扫描线周期与 `blockSize` 解耦，连续取值会产生未验收组合 | 验收成本固定为档位数，不随调用方数量增长 |
| `PROCESS_TIMEOUT` 视为费用未知 | 取消请求不能保证供应商未计费 | 该错误码不得自动重试，需人工确认 |
| 保留 `/execute` 的同步契约 | 已有调用方依赖一次性等待 | 长任务走异步入口，不改变现有语义 |

## 调用方实现口径

接入方已确认按以下口径实现：

1. 除 `503 SERVICE_BUSY` 外不自动重投，只允许人工重试。异步入口启用后，`429`、`503 ASYNC_SERVICE_CAPACITY_REACHED` 与 `503 ASYNC_SERVICE_UNAVAILABLE` 加入同一档，并使用同一个幂等键。
2. 每次调用携带 `X-Request-Id`。服务端读取该头之前，它不产生任何可追溯效果。
3. 调用方自行限制并发与提交速率，不依赖服务端闸门做流控。
4. `INVALID_INPUT` 永不重试；`DEPENDENCY_FAILURE` 按拆分后的子码分流；`PROCESS_TIMEOUT` 按费用未知处理。
5. 按响应中的 `expiresAt` 处理链接，不硬编码有效期。
6. 产物只做整数倍最近邻放大，不经过任何服务端重采样或 ML 超分管线。
7. 用 `normal` 档重跑原图应字节级复现首次产物，接入方将其作为自动检查，用于验证原图未被自身管线改动。

## 相关文档

- Process 实现、后处理算法、证据策略与验收：[`README.md`](README.md)
- 证据目录结构与保留配置：[`evidence-retention.md`](evidence-retention.md)
- 异步入口的设计与发布门禁：[`async-process-runs-design.md`](../../async-process-runs-design.md)、[`async-process-runs-runbook.md`](../../async-process-runs-runbook.md)
- 同步入口的部署与环境验收：[`mvp-release-runbook.md`](../../mvp-release-runbook.md)
