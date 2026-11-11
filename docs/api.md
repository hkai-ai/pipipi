# 业务接口文档

本文面向业务调用方和调用 Agent，记录二十一个 Business Process（默认启用二十个）、Agent Conversations、重试与通知契约，以及临时开放的内部评测接口。场景列帮助产品找到契约；请求仍只提交准确 Process 或 Agent 版本和业务输入。其中 `composed-task/v1` 随应用发布但默认关闭；production Agent catalog 当前为空（原 `design-assistant/v1` 已下线，待重新开发），因此四个 Agent Conversations 路由不能开启。

## Agent 能力接入结论

服务提供两种不互相覆盖的 Agent 使用方式。版本化 Business Process 可以在内部使用请求级 Agent；调用方仍通过 `POST /execute` 或异步 Process Run Interface 提交准确 Process/version 和业务输入。独立的 Agent Conversations Interface 面向用户交互，使用准确 Agent id/version 创建持久 Conversation。

两种 Interface 都由服务端选择 Agent、Runtime Skill、模型、Tool、Business Capability 和运行策略。服务没有通用 `/agent` 或兼容 Chat Completions 的接口，也不接受 `messages`、role、Prompt、模型名、Tool、Skill 或执行步骤。Agent Conversations 的“通用”是多个服务端 Agent 共用受控基础设施，不是调用方可配置的任意 Agent。

现有 Process 是否一定调用 Agent 由服务端 Registration 决定，调用方不应依赖内部实现。`minimal-zine-poster/v1`、`crt-interface-image/v1` 和三个新闻图片 Process 当前使用受限 Agent；`composed-task/v1` 使用 Planner Agent，但默认关闭。

Agent Conversations 当前支持可靠多轮文本、owner-scoped 图片资源、Registration 固定的受控 Business Process Tool，以及 owner 删除和 30 天闲置保留。production Composition Root 已装配 PostgreSQL、BullMQ、资源服务、请求级 Pi Session、Dispatcher、Worker、Reconciler 与 Cleaner；`AGENT_CONVERSATIONS_ENABLED=false` 是默认值，因此未启用的部署访问这些路由仍返回 404。当前阶段不提供图片上传、任意 URL 抓取、跨 Conversation 长期 Memory、SSE 或 Canvas Document。

能力可调用不等于可以匿名公开。同步 `/execute` 的应用本身不校验调用方身份；Agent Conversations 必须由入口网关完成用户鉴权、剥离外部 identity header，再向应用注入可信 caller identity，且每次创建和追加都要求 caller-scoped `Idempotency-Key`。部署方必须先完成容量与费用评审并按 [Agent Conversations Runbook](agent-conversations-runbook.md) 开启；调用方不能在请求中放宽任何门禁。

### 最短接入路径

1. 开发阶段先选一个准确的 Process 和版本。只验证 HTTP 接入时，可向 `minimal-zine-poster/v1` 提交空 `input`，服务在调用 Agent 或图片服务前返回 `400 INVALID_INPUT`，不产生费用；有效输入会调用模型并生成图片。
2. 向 `POST /execute` 发送 JSON，并把客户端读取超时设为至少 260 秒。同步入口不提供幂等保证。
3. 同时判断 HTTP 状态和响应体 `status`。只有 `2xx` 且 `status` 为 `succeeded` 才表示成功。
4. 保存 `runId` 和调用方生成的 `X-Request-Id`，用于排查失败。`X-Request-Id` 不提供幂等性。
5. 图片 Process 会产生模型费用和外部写入。网络超时、`PROCESS_TIMEOUT`、`DEPENDENCY_FAILURE` 或 `DEPENDENCY_FAILURE_AFTER_COMMIT` 后不得自动重试。

开发环境可以先使用以下最小请求；实际 Base URL 和网关凭证由部署方提供。该请求会产生模型与图片费用：

```bash
curl --request POST 'https://pi.ganjiuwanshi.com/execute' \
  --header 'content-type: application/json' \
  --header 'x-request-id: replace-with-your-trace-id' \
  --data '{
    "process": "minimal-zine-poster",
    "version": "v1",
    "input": {
      "brief": "为雨天旧书店做一张安静的海报"
    }
  }'
```

成功响应的最小判断字段如下；`output` 的准确结构由所选 Process 决定：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "minimal-zine-poster",
  "version": "v1",
  "status": "succeeded",
  "output": {
    "image": { "url": "https://..." }
  }
}
```

需要可靠接受、轮询和安全重放时，改用[异步执行](#异步执行)。异步入口默认关闭，并要求可信网关身份和稳定的 `Idempotency-Key`；调用方不能只根据仓库代码假定部署已经开放。

## Agent Conversations（多轮文本与图片资源）

production Agent catalog 当前为空：原 `design-assistant/v1` 已下线，待重新开发后再登记；没有默认 Agent、版本回退或请求时发现。在登记生产 Agent 之前，部署开启 `AGENT_CONVERSATIONS_ENABLED=true` 会在启动时失败。本节保留 Conversation 的公开契约，供本地 `npm run dev:agent` 契约桩和未来的 Agent 复用；示例中的 `design-assistant/v1` 仅为该契约桩使用的标识。

每个 Agent Registration 固定 Runtime Skill、同一 Conversation 的成功公共历史、Conversation-scoped 派生摘要、请求级 Pi Session、准确 Process Tool allow-list 与 Tool 预算。模型、provider、endpoint、Prompt、Skill 位置、Secret、预算、输出策略和保留策略均由服务端配置，产品请求不能读取或覆盖。行为配置的确定性 SHA-256 作为 `configRevision` 写入 Conversation；发布若未保留活动 Conversation 依赖的旧 revision，`/readyz` 会失败，避免静默漂移。

路由仅在部署设置 `AGENT_CONVERSATIONS_ENABLED=true` 时挂载；默认返回 404。持久路径使用 PostgreSQL 权威 Store/Tool Ledger 与 BullMQ 最小 Job，并由 Dispatcher、Worker、Reconciler 和 Cleaner 处理至少一次调度。调用前应由部署方确认当前环境已开放。

下列 HTTP 示例中的 `Authorization` 代表部署方发放的外部凭证。公网调用方不得自行发送 `X-Pipipi-Caller-Id` 或 `X-Pipipi-Gateway-Token`；入口网关必须剥离并重新注入这两个内部 header。

创建 Conversation 必须包含第一轮 Turn：

```http
POST /agent-conversations HTTP/1.1
Content-Type: application/json
Authorization: Bearer <deployment-issued-token>
Idempotency-Key: design-request-001
```

```json
{
  "agent": {
    "id": "design-assistant",
    "version": "v1"
  },
  "input": {
    "content": [
      {
        "type": "text",
        "text": "分析这个版式的视觉层级"
      }
    ]
  }
}
```

可直接把部署方的地址和外部 token 放入环境变量后联调：

```bash
curl --request POST "${PIPIPI_BASE_URL}/agent-conversations" \
  --header "authorization: Bearer ${PIPIPI_ACCESS_TOKEN}" \
  --header 'content-type: application/json' \
  --header 'idempotency-key: design-request-001' \
  --data '{
    "agent":{"id":"design-assistant","version":"v1"},
    "input":{"content":[{"type":"text","text":"分析这个版式的视觉层级"}]}
  }'
```

`content` 接受 1–16 个按原顺序处理的文本或图片引用块。文本块每段 trim 后为 1–12000 个字符；图片块只能提交部署方 owned resource service 已存在、属于当前 caller 的稳定 identity。图片上传是独立的未来 Interface，不属于这四个路由：

```json
{
  "content": [
    { "type": "text", "text": "参考这张图调整版式" },
    { "type": "image", "resourceId": "asset_01J..." }
  ]
}
```

请求是 strict object，不能增加 role、system、Prompt、Skill、Tool、模型、provider、Memory、预算、重试、`url`、`data`、base64、`path` 或 `file://`。Agent id/version 必须准确匹配 Registration，不提供默认版本或回退。默认全局图片上限是每 Turn 4 张、单图 10 MiB、合计 20 MiB、宽高各 8192 px，媒体类型只允许 JPEG、PNG、WebP；每个 Registration 可以继续收紧，不能扩大。

Agent 的 Tool 由服务端 Registration 固定。每项 Tool 指向 production Process catalog 中一个准确 Process/version；调用方不能列出、增加或覆盖 Tool。默认每 Turn 最多调用 6 次 Tool，其中最多 1 次付费 Tool；每 Conversation 最多尝试 10 次付费 Tool。每次调用仍经过成员 Process 的输入 Schema、Attempt、超时、取消和错误净化。Agent 只能返回本 Turn 成功 Tool 的结果或经过 Resource Resolver 验证的图片资源。

服务完成 owner 与幂等检查并接受首轮 Turn 后返回 `202`：

```json
{
  "conversationId": "conversation-0001",
  "turnId": "turn-0001",
  "sequence": 1,
  "status": "queued",
  "createdAt": "2026-08-30T08:00:00.000Z"
}
```

响应包含 `Location: /agent-conversations/{conversationId}`、`Retry-After` 和 `Cache-Control: no-store`。响应丢失时，调用方用同一 caller、同一 `Idempotency-Key` 和逐字段相同的规范化请求重试；服务返回原 identity 和实际状态。相同 key 提交不同请求返回 HTTP 409 `IDEMPOTENCY_CONFLICT`。

首轮到达终态后，用响应或查询中的最后一个 `turnId` 作为 `afterTurnId` 追加增量 Turn：

```http
POST /agent-conversations/conversation-0001/turns HTTP/1.1
Content-Type: application/json
Authorization: Bearer <deployment-issued-token>
Idempotency-Key: design-request-002
```

```json
{
  "afterTurnId": "turn-0001",
  "input": {
    "content": [
      {
        "type": "text",
        "text": "把刚才的建议改成适合移动端的方案"
      }
    ]
  }
}
```

接受后仍返回 `202`，其中新 Turn 的 `sequence` 为 2。一个 Conversation 同时最多有一个 queued/running Turn；busy 时返回 HTTP 409 `CONVERSATION_BUSY` 和 `Retry-After`。`afterTurnId` 不是最后接受的 Turn 时返回 `CONVERSATION_SEQUENCE_CONFLICT`。同 key、同规范化追加请求的重放优先于 busy、顺序和容量判断，因此会返回原 Turn 的当前状态，不会产生第二个 sequence 或 Queue Job。

查询只向 owner 返回 Conversation，并使用 `after` opaque cursor 与 `limit` 分页：

```http
GET /agent-conversations/conversation-0001?limit=20 HTTP/1.1
Authorization: Bearer <deployment-issued-token>
```

```json
{
  "conversationId": "conversation-0001",
  "agent": {
    "id": "design-assistant",
    "version": "v1"
  },
  "configRevision": "eabec15058155b7962848c1bbf0b38c38fda1eb4d47b9d840e2063dbb54b4c11",
  "status": "ready",
  "turnCount": 1,
  "lastTurnId": "turn-0001",
  "createdAt": "2026-08-30T08:00:00.000Z",
  "updatedAt": "2026-08-30T08:00:02.000Z",
  "expiresAt": "2026-09-29T08:00:00.000Z",
  "turns": [
    {
      "turnId": "turn-0001",
      "sequence": 1,
      "status": "succeeded",
      "input": {
        "content": [
          {
            "type": "text",
            "text": "分析这个版式的视觉层级"
          }
        ]
      },
      "output": {
        "content": [
          {
            "type": "text",
            "text": "标题与正文需要拉开字号和留白差异。"
          }
        ]
      },
      "createdAt": "2026-08-30T08:00:00.000Z",
      "startedAt": "2026-08-30T08:00:01.000Z",
      "finishedAt": "2026-08-30T08:00:02.000Z"
    }
  ]
}
```

当本页之后还有历史时，响应包含 `nextCursor`；下一页把它原样传给 `after`。`limit` 必须为 1–100，并可能被 Agent Registration 进一步收紧。Conversation 的公共状态为 `busy` 或 `ready`；Turn 状态为 `queued`、`running`、`succeeded` 或 `failed`。busy 查询携带 `Retry-After`。未知、其他 caller 所有或不可访问的 Conversation 都返回同一 HTTP 404 `CONVERSATION_NOT_FOUND`。

`expiresAt` 是 Conversation 的权威闲置期限。每次接受新 Turn 后都将它滑动到该 Turn 创建时间之后 30 天；只读查询不续期。到期后查询、新 Turn、恢复扫描和迟到 Worker 提交都按 Conversation 不存在处理。

owner 可以请求删除整个 Conversation：

```http
DELETE /agent-conversations/conversation-0001 HTTP/1.1
Authorization: Bearer <deployment-issued-token>
```

接受后返回 `202` 和 `Cache-Control: no-store`：

```json
{
  "conversationId": "conversation-0001",
  "status": "deletion_accepted",
  "deleteBy": "2026-08-31T08:00:00.000Z"
}
```

删除不接受 query 或请求体，也不需要 `Idempotency-Key`。同一 owner 重复删除在物理清理前返回首次接受的同一个 `deleteBy`；其他 owner、未知、已过期或已物理清理的 identity 返回统一 404。请求被接受的事务会立即提升 fencing revision、废弃活动 Attempt、停止未发布 Outbox 并封住未完成 Tool，因此迟到 Worker 不能重新发布结果。此后查询和追加立即不可见，物理清理最迟在 `deleteBy` 前完成。

Cleaner 以短事务和 opaque cursor 分批清理；删除 Conversation 会级联删除 Turn History、Working Summary、caller 幂等记录、Outbox、Attempt、Tool Ledger 和 Agent 输出的稳定资源引用。调用方提供的输入图片是 caller source，只删除 Conversation 内引用，不删除源资源；Process Tool 产生的业务 artifact 仍遵循对应 Process 或资源服务的保留策略。清理日志只包含批次 identity、deadline、cursor 和计数，不记录对话内容、Tool 内容或资源 URL。

后续 Turn 的 Context 只由服务端固定 Agent 配置、可重建 Working Summary、受预算限制的 succeeded 公共历史和当前输入组成。queued/running Turn、failed Turn 的不存在输出、隐藏推理、原始 provider 消息和内部异常不会进入 Context。完整 Session History 仍是权威记录；Working Summary 不能替代或改写历史。

Resource Resolver 在接受图片输入时按 caller 校验归属、存在性、媒体类型、字节数和尺寸；不存在与其他 owner 所有得到相同 `INVALID_INPUT`。Worker 执行前再从 owned service 获取模型可访问内容，只在请求级 Pi Session 生命周期内持有，并在成功、失败或取消时释放。priced Process Tool 成功返回业务图片后，Worker 让 owned service 将该图片登记为当前 owner/Turn 的稳定资源，再把 `resourceId` 暴露给 Agent；登记失败按 `DEPENDENCY_FAILURE_AFTER_COMMIT` 收敛，不重新执行可能收费的 Tool。Agent 输出图片只提交 `resourceId`，且 Resolver 必须证明它由获准 Adapter 或本 Turn Tool 产生；模型虚构 URL 或 identity 会让 Turn 以 `INVALID_OUTPUT` 失败。

权威历史中的图片块只保存稳定资源元数据：

```json
{
  "type": "image",
  "resource": {
    "resourceId": "asset_01J...",
    "mediaType": "image/png",
    "byteSize": 245760,
    "width": 1600,
    "height": 1200
  },
  "url": "https://temporary-owned-resource.example/...",
  "expiresAt": "2026-08-30T09:00:00.000Z"
}
```

图片块里的 `url` 和图片 URL 的 `expiresAt` 只在 owner 查询时临时投影，不写入 Turn History、Queue Job 或日志；这与 Conversation 顶层的权威闲置 `expiresAt` 是两个不同字段。模型 base64 和图片字节也不进入历史或响应。

| 情形 | HTTP | code |
| --- | --- | --- |
| 未通过可信 caller identity | 401 | `CALLER_UNAUTHORIZED` |
| 缺少或超长幂等键 | 400 | `IDEMPOTENCY_KEY_REQUIRED` / `INVALID_IDEMPOTENCY_KEY` |
| 严格请求、文本或图片资源输入无效 | 400 | `INVALID_INPUT` |
| Agent id/version 未登记 | 404 | `AGENT_NOT_FOUND` |
| caller 活动 backlog 已满 | 429 + `Retry-After` | `CALLER_AGENT_BACKLOG_LIMIT_REACHED` |
| 全局活动 backlog 已满 | 429 + `Retry-After` | `AGENT_BACKLOG_LIMIT_REACHED` |
| 幂等键被不同请求复用 | 409 | `IDEMPOTENCY_CONFLICT` |
| Conversation 不存在或不属于 caller | 404 | `CONVERSATION_NOT_FOUND` |
| Conversation 已有活动 Turn | 409 | `CONVERSATION_BUSY` |
| `afterTurnId` 不是最后接受的 Turn | 409 | `CONVERSATION_SEQUENCE_CONFLICT` |
| 达到 Registration Turn 上限 | 409 | `CONVERSATION_TURN_LIMIT_REACHED` |
| cursor、limit 或额外 query 无效 | 400 | `INVALID_QUERY` |
| Store、Queue 或 identity 依赖异常 | 503 | `AGENT_CONVERSATIONS_UNAVAILABLE` |

Agent 异常收敛为 Turn 终态 `AGENT_FAILURE`，执行时资源不可访问收敛为 `RESOURCE_UNAVAILABLE`，不合法、超限或未获准图片输出收敛为 `INVALID_OUTPUT`。priced Process Tool 成功或进入结果不确定窗口后，如果 Turn 无法交付有效结果，则终态为 `DEPENDENCY_FAILURE_AFTER_COMMIT`；这表示费用可能已经发生，调用方不得自动重试。响应不透传 provider 错误、模型名或 endpoint、Prompt、隐藏推理、Tool 输入输出正文、资源服务细节、Secret、原始响应或内部异常。PostgreSQL Adapter 能在 API/Worker 重启后保留 Conversation、幂等 identity 与 Tool invocation；BullMQ 提供可恢复的至少一次调度。caller/global admission 都按 queued/running Turn 计数并返回 HTTP 429；同 caller、同 key、同请求的重放先于容量判断，不会被门禁变成新请求。

## Agent 读取入口

Agent 先读取 [`https://pi.ganjiuwanshi.com/llms.txt`](https://pi.ganjiuwanshi.com/llms.txt)，再按其中的链接读取本页的纯 Markdown 版本：[`https://pi.ganjiuwanshi.com/docs/api.md`](https://pi.ganjiuwanshi.com/docs/api.md)。兼容路径 `/llm.txt` 返回与 `/llms.txt` 相同的内容。

这两个入口只提供随当前应用版本发布的公开文档，不执行 Process，也不包含凭证、Prompt 或内部运行配置。

## 接入信息

| 项目 | 值 |
| --- | --- |
| Base URL | `https://pi.ganjiuwanshi.com` |
| Agent 入口 | `GET /llms.txt`；兼容 `GET /llm.txt` |
| 完整 Markdown | `GET /docs/api.md` |
| 业务入口 | `POST /execute`；部署启用后提供 `POST /agent-conversations`、`POST /agent-conversations/{id}/turns`、`GET/DELETE /agent-conversations/{id}` |
| 内部评测入口 | `POST /internal/eval/execute`；当前生产已开启 |
| Content-Type | `application/json` |
| 鉴权 | `/execute` 由部署网关决定；Agent Conversations 必须由网关鉴权并向应用注入可信 caller identity |
| 字符编码 | UTF-8 |
| 请求体上限 | 当前应用上限为 262144 UTF-8 bytes；入口网关可以设置更小的限制 |
| 执行时限 | 图片转模板上限 480 秒，建议客户端读取超时至少 500 秒；其他 Process 上限 240 秒，建议至少 260 秒。网关超时也需相应配置 |
| `X-Request-Id` | 可选。调用方自己的 trace id，会写入本次请求的每一条运行日志，包括没有 `runId` 的传输层拒绝。限 1–200 个字符，字符集 `A-Za-z0-9_.:-`；不合规的取值被忽略，不影响执行，也不回显 |

请求使用严格 Schema。多余字段、错误类型、未知 Process 和未知版本都会被拒绝。

## 选择执行方式

| 方式 | 适用条件 | 重试边界 |
| --- | --- | --- |
| `POST /execute` | 调用方需要在同一个 HTTP 请求中等待结果 | 不提供调用方幂等键。网络超时不代表 Process 未执行；付费图片调用不得自动重试 |
| `POST /process-runs` | 异步入口已开放，或调用方需要可靠接受、轮询和安全重放 | 必须使用稳定的 `Idempotency-Key`；提交响应丢失时用同一 key 和同一请求重试 |
| `POST /agent-conversations` / `POST /agent-conversations/{id}/turns` / `GET/DELETE /agent-conversations/{id}` | 部署已开启 Agent Conversations 并登记生产 Agent（当前没有），且调用方需要 owner-scoped 多轮文本/图片、分页轮询或删除 | 创建和追加各使用稳定且独立的 `Idempotency-Key`；图片先上传到部署方另行提供的 owned resource service，本接口只接收 `resourceId` |

`X-Request-Id` 只用于排查请求，不提供幂等性。调用方需要安全重放时选择异步入口。

## 执行业务流程

```http
POST /execute HTTP/1.1
Host: pi.ganjiuwanshi.com
Content-Type: application/json
```

### 请求结构

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检发现需要进一步检查的安全隐患。"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `process` | string | 是 | Business Process 标识，必须使用下表中的准确值 |
| `version` | string | 是 | Process 版本，当前均为 `v1` |
| `input` | object | 是 | Process 对应的业务输入 |

### Process 清单

| 场景 | process | 用途 |
| --- | --- | --- |
| `memebuy` | `template-from-image` | 从参考图编译可编辑模板草稿；对接 Memebuy 素材箱提取 Worker，保留 Pipipi 本地测试，尚未部署 |
| `common` | `minimal-zine-poster` | 生成极简 Zine 海报 |
| `common` | `photo-doodle-collage` | 生成摄影剪贴与互动黑线小人海报 |
| `common` | `photo-fashion-manga` | 真人照片转日式手绘时装漫画 |
| `common` | `manga-panels` | 无文字的漫画分镜 |
| `common` | `character-emoji` | 固定 AI 角色的单图表情或多格漫画 |
| `common` | `crt-interface-image` | 根据公网参考图生成 CRT 风格图片 |
| `memene` | `news-image-narrative-monument` | 生成人物叙事碑式新闻图片 |
| `memene` | `news-image-pale-watercolor` | 生成淡彩绘本新闻图片 |
| `memene` | `news-image-raw-humanism` | 生成原质人文主义新闻图片 |
| `common` | `composed-task` | 由服务端 Planner 在预算内组合上述 Process 完成一个目标；部署默认关闭，未开启时返回 `PROCESS_NOT_FOUND` |

Memebuy 场景的图片转模板返回 Gallery v2 草稿，不直接写入 Memebuy。完整场景归属见 [Business Process 场景目录](processes/README.md)。

调用方不能提交 Skill、Prompt、模型、Tool、图片供应商或存储配置。新闻图片风格由 `process` 固定，接口不接收 `style` 字段。

## 角色表情包

`character-emoji/v3` 支持同角色双版本登场：cast 按角色 + appearance 去重，最多 5 位；方案 actors 必填 appearance，漫画对白 speaker 使用 `character:appearance`，其余输入输出结构沿用 v2。参考图按 cast 顺序逐位绑定新版场景素材。v2 合同和旧参考图保留，详情见[双版本登场](processes/common/character-emoji/README.md#双版本登场-v3)。

`character-emoji/v2` 基于 Memebuy 角色表情包接入单图与多格漫画，当前提示词已独立精简。`cast` 中的角色数量为 1–5，同一角色不能重复；`appearance` 为 `Chibi` 或 `Girl`。参考图、文本模型、图片模型和供应商均由服务端固定配置。构思使用 DeepSeek 4.1 Flash Pi Agent，搜索 Tool 内使用 DeepSeek，默认提供按角色和题材挑选的本地短卡，由 Agent 首轮选材改编或原创；服务端仅对明确搜索、核实或近期新闻/热梗等要求开放搜索工具，普通剧情无搜索工具；禁止搜索优先，允许时最多调用一次并取舍两个候选；缺引用的资料可作未核验灵感，搜索失败或素材不适用时直接按输入原创。来源与改编证据不返回给产品。单图按角色 ID 绑定参考图，允许方案中的角色排列不同。JSON格式、可定位结构或配字错误可在原预算内修正一次；构思模型失败、修正后方案仍无法读取或必要业务校验失败时返回 `AGENT_FAILURE`，不会调用生图；用户取消和整体截止仍停止执行。

Memebuy 提交豆包 Q 版单图时使用以下 v3 请求。单图省略 `input.mode`，漫画传 `"comic"`。v2 和 v3 均接受 `Doubao:Chibi`，`Doubao:Girl` 会返回 `INVALID_INPUT`。

```json
{
  "process": "character-emoji",
  "version": "v3",
  "input": {
    "cast": [{ "character": "Doubao", "appearance": "Chibi" }],
    "idea": "豆包捂住正在外放的手机"
  }
}
```

`captionSetting` 可省略，或使用 `{ "mode": "auto" }`、`{ "mode": "none" }`、`{ "mode": "custom", "text": "原样显示的台词" }`。`none` 仅关闭主台词，仍允许必要场景文字；idea 明确要求禁止任何文字时优先于配字设置，全部文字均关闭。其他情况下 custom 原样使用自定义台词，none 关闭主台词；auto 或缺省时结合 idea，明确不要对白则不配台词，仍允许必要场景文字。构思、校验和生图共用同一有效文字策略。自动台词不设置通用禁词。单图默认白底动漫贴纸，可按创意调整背景与风格。

漫画请求把 `mode` 固定为 `comic`，每次生成 2–6 格，格数、画幅和自由布局由 Agent 按剧情决定，支持大小格、跨行跨列及明确嵌格：

```json
{
  "process": "character-emoji",
  "version": "v2",
  "input": {
    "mode": "comic",
    "cast": [
      { "character": "DeepSeek", "appearance": "Chibi" },
      { "character": "Claude", "appearance": "Girl" }
    ],
    "idea": "角色刚修好一个 bug，电脑后面又爬出一群新 bug；用连续动作表现越修越多。"
  }
}
```

成功输出包含 `image`、`mode`、`plan`；单图另包含 `caption`。v2 的单图 `plan` 为 `{ scene, actors, caption, propMarks }`；漫画为 `{ page, panels }`，每格为 `{ index, frame, scene, actors, texts }`。`actors` 只包含 `{ character, identityMark }`；动作、位置、道具状态及可见笑点统一写入该格 `scene`。准确台词与标识保留原有文字对象。v1 的 `joke`、`composition`、`punchlineDetail`、角色表演字段及漫画 `continuity` 已移除。这是公开输出的不兼容变更：调用方应切换精确版本并读取 `scene`；当前 production catalog 同时注册 v2 和 v3，不自动回退版本。文本阶段由专用 DeepSeek 4.1 Flash Pi Agent 加载固定 Skill，通过受控搜梗 Tool 调用带原生 `web_search` 的 Responses 网关；不继承全局 `PI_MODEL`。图片阶段主用渠道将角色参考图读入内存后按原顺序上传文件，备用渠道保持公网 URL 直传；主用 Memene `gpt-image-2.5-flare`，主用报错时自动切换一次 Magikaru `gpt-image-2.5`，主动取消或整体截止除外；具体服务端配置与切换条件见[角色表情包专题](processes/common/character-emoji/README.md)。调用方不能选择模型或触发备用。取消或超时不代表 Gateway 已停止生成；已知任务应查原 `jobId`；主用提交未知仍按上述策略切换一次备用，产品调用方不要据此重投整个请求。当前正式入口尚未接通跨请求 Job 恢复，重复遇到 pending 会返回失败；方案持久化与正式恢复另行补充。

漫画输出的 `page.layout`、`page.readingOrder` 和各格 `frame` 由 Agent 按剧情设计，支持不等大的画格、跨行跨列及明确嵌格；`panels` 按阅读顺序排列，程序只生成 `index`，不会改写布局。角色创作背景由服务端按角色注入，调用方不能上传或覆盖背景配置；用户剧情仍优先。

既有 AI-Fanworks 角色参考图采用 CC BY-NC-SA 4.0，仅供非商业验证；豆包参考图单独记录来源，不沿用该许可。商用发布前确认各素材授权、署名和相同方式共享要求，详见 [Process 说明](processes/common/character-emoji/README.md#素材与授权)。

## 图片转模板

`template-from-image/v1` 当前对接 Memebuy 素材箱提取 Worker，候选需人工确认后导入；尚未部署，真实页面验收另行完成。主 API 启动后通过统一的 `/execute` 调用。

```json
{
  "process": "template-from-image",
  "version": "v1",
  "input": {
    "imageUrl": "https://your-public-assets.example/reference.png",
    "note": "保留构图，让用户替换主角和文字"
  }
}
```

`imageUrl` 必填，公网 HTTPS、最多 2048 字符，无用户名密码。服务端下载一次，禁止私网和重定向，下载最多 20 MB / 30 秒；图片必须是静态 PNG/JPEG/WebP、宽高至少 64、最多 4000 万像素。`note` 可选，去首尾空格后 1–500 字符；它是编辑意图，不是运行配置。

地址保护或 DNS 解析失败仍返回 `DEPENDENCY_FAILURE`，错误说明会区分受限地址、DNS 问题和图片读取问题；不会回显原图 URL。这些失败均发生在模型调用前。

成功沿用统一响应壳：`{ runId, process, version, status: "succeeded", output: { template } }`。`template` 是完整 Gallery v2 对象：

| 字段 | 返回值与含义 |
| --- | --- |
| `key`、`title`、`description` | 建议玩法名、中文标题和说明；key 尚未做业务注册表去重 |
| `kind`、`status` | 固定 `PROMPT`、`DRAFT` |
| `cover`、`referenceImage` | 原样引用本次输入地址；不会转存，短期 URL 会到期 |
| `imageSize`、`imageN`、`preprocessSteps` | 根据原图比例选择固定尺寸；数量固定 1，预处理固定空数组 |
| `promptTemplate` | 带默认值占位符的模板内容；属于草稿业务输出，不包含内部编译 Prompt |
| `inputSchema` | version 2，1–4 个可选编辑槽位，每槽支持文字和三个推荐值；身份替换还支持私有图片输入 |
| `runtimeSemantics` | version 2，明确目标、输入绑定、身份替换策略、服装归属和视觉约束 |
| `metadata.tags` | 5–8 个发现标签，包含至少一个正式大类 |

Process 最长 480 秒，成功前进行 Schema 与语义校验，先生成分析和草稿，再独立看图复核并返回必要字段补丁，程序合并后统一校验。正常两次视觉模型调用；仅首轮 JSON 或候选结构无法读取时允许一次重新编译，最多三次，之后仍须独立复核。复核或补丁未通过校验则失败，不自动追加模型请求。不向调用方返回内部 analysis、review、图片字节、模型或 Skill 配置。不生成成品、不入库、不发布。JSON 结构正确不代表视觉理解已经人工确认。

已完成响应中的 JSON 语法错误与合同错误共用这一次修正预算。模型输入合同与服务端校验均将标题和描述限制为 20 字；单个多余末尾闭括号或 Markdown 包裹可被去除，但不补造草稿字段，且仍需完整校验。

错误沿用统一错误壳：非法输入为 `INVALID_INPUT`；图片获取或解码失败为 `DEPENDENCY_FAILURE`；模型不支持视觉、执行失败或两次候选校验失败为 `AGENT_FAILURE`；本地校验的未知程序异常为 `INTERNAL_ERROR`；超时返回 `PROCESS_TIMEOUT`；取消沿用共享 Runner 的 `INTERNAL_ERROR`，已断开的客户端可能收不到响应。同步调用无调用方幂等保证，网络失败不自动重试；图像下载失败不会调用模型。鉴权沿用部署平台策略。

执行异常的提示区分编译、修正与复核阶段，并按可识别原因显示连接中断、限流、鉴权、超时或空响应；无法识别时只报告执行异常，不推定模型配置错误。调用方按错误码处理，不解析提示文案；原始异常、供应商地址和凭据不会返回。

## 内部新闻图片评测

`POST /internal/eval/execute` 临时向受控测试调用方开放。该接口只接受三个新闻图片 Process，并复用正式 `/execute` 的 Executor、Registration、Agent 和图片 Capability。一次请求只执行一次 Process。

部署方必须设置 `INTERNAL_EVAL_ENABLED=true` 才会挂载该路由。入口关闭时返回 HTTP `404` 和 `ROUTE_NOT_FOUND`。生产 Compose 目前开启该入口，供受控评测调用方直接访问。

该调用会访问文本模型、图片供应商和对象存储，产生费用和外部写入。该入口不做独立鉴权实现，与 `/execute` 保持同一鉴权姿态，鉴权后续与 `/execute` 一并统一处理。响应会投影本次执行实际使用的 Prompt 与文本模型。

请求结构与正式 `/execute` 相同：

```http
POST /internal/eval/execute HTTP/1.1
Host: pi.ganjiuwanshi.com
Content-Type: application/json
```

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检发现需要进一步检查的安全隐患。"
  }
}
```

成功时返回 HTTP `200` 和 `Cache-Control: no-store`。`output.generation` 投影本次执行实际使用的 Prompt、文本模型和非敏感图片参数：

```json
{
  "runId": "35833107-f4c5-4baa-aca2-c6d5e15452a5",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "succeeded",
  "output": {
    "style": "pale-watercolor",
    "image": {
      "url": "https://assets.example.com/news-images/35833107.png",
      "contentType": "image/png",
      "width": 1600,
      "height": 1200
    },
    "generation": {
      "prompt": "本次实际传入图片模型的完整 compiled.prompt",
      "promptModel": "gpt-5.4-mini",
      "imageProvider": "fal",
      "imageModel": "gpt-image-2",
      "aspectRatio": "4:3",
      "width": 1600,
      "height": 1200,
      "quality": "low",
      "outputFormat": "png",
      "numImages": 1,
      "seed": null,
      "otherParams": {
        "sync_mode": true
      }
    }
  }
}
```

`generation.prompt` 是校验后直接交给图片 Capability 的 `compiled.prompt`。其他字段来自本次 Capability 调用解析出的参数。诊断内容只进入该响应，不进入正式 `/execute` 输出、日志或 Run Record。

非新闻图片 Process 返回 HTTP `400` 和 `INVALID_INPUT`。Process 执行失败时沿用正式 `/execute` 的错误码和公开消息，不返回 `output.generation`。

## 异步执行

异步入口只在部署方完成发布门禁并通过可信网关开放后可用。调用方仍提交上节定义的同一个业务请求；不能提交 Queue、Worker、Skill、模型或运行配置。

```http
POST /process-runs HTTP/1.1
Authorization: Bearer <gateway credential>
Idempotency-Key: <caller-scoped key>
Content-Type: application/json
```

可信网关先认证调用方，删除请求中的 `x-pipipi-caller-id` 与 `x-pipipi-gateway-token`，再注入稳定 caller subject 和服务端共享凭证。调用方不得直接构造这两个内部头。`Idempotency-Key` 必填、最长 512 UTF-8 bytes，并按已认证 caller 隔离；网络中断或响应丢失时，重试同一业务操作必须复用原 key。

durable acceptance 成功返回 HTTP `202`、`Location: /process-runs/{runId}`、`Retry-After` 与不含业务结果的 Run：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "minimal-zine-poster",
  "version": "v1",
  "status": "queued",
  "createdAt": "2026-08-14T10:00:00.000Z"
}
```

同一 caller、key 和规范化请求只创建一个 Run，并返回相同 `runId`。重放发生在 Run 已经开始或完成之后时，HTTP 仍为 `202`，但 `status` 会反映当时真实的 `running`、`succeeded` 或 `failed` 状态；调用方始终根据 `Location` 查询完整结果。同一个 key 配合不同请求返回 `409 IDEMPOTENCY_CONFLICT`。

调用方随后使用同一网关身份查询：

```http
GET /process-runs/c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c HTTP/1.1
Authorization: Bearer <same caller credential>
```

查询成功始终返回 HTTP `200` 和 `Cache-Control: no-store`。`queued` 与 `running` 响应还包含 `Retry-After`；调用方按该秒数等待后继续查询，不自行高频轮询：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "minimal-zine-poster",
  "version": "v1",
  "status": "running",
  "createdAt": "2026-08-14T10:00:00.000Z",
  "startedAt": "2026-08-14T10:00:01.000Z"
}
```

终态成功增加 `finishedAt` 和对应 Process 的 `output`；终态失败也返回 HTTP `200`，并增加 `finishedAt` 和稳定 `error`。因此调用方必须判断 body 的 `status`，不能只判断 HTTP 状态：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "minimal-zine-poster",
  "version": "v1",
  "status": "failed",
  "createdAt": "2026-08-14T10:00:00.000Z",
  "startedAt": "2026-08-14T10:00:01.000Z",
  "finishedAt": "2026-08-14T10:00:02.000Z",
  "error": {
    "code": "DEPENDENCY_FAILURE",
    "message": "A required business service is unavailable"
  }
}
```

结果内容到期后仍保留真实终态和时间，但用以下字段替代 `output` 或 `error`：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "minimal-zine-poster",
  "version": "v1",
  "status": "succeeded",
  "createdAt": "2026-08-14T10:00:00.000Z",
  "startedAt": "2026-08-14T10:00:01.000Z",
  "finishedAt": "2026-08-14T10:00:02.000Z",
  "resultAvailability": "expired",
  "resultExpiredAt": "2026-08-21T10:00:02.000Z"
}
```

非 owner 与未知 `runId` 都返回相同的 `404 PROCESS_RUN_NOT_FOUND`，不能据此枚举资源。初始版本不支持取消或 Run 列表查询。

| HTTP 状态 | error.code | 说明 |
| ---: | --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`、`INVALID_IDEMPOTENCY_KEY` | 幂等键缺失或无效 |
| 401 | `CALLER_UNAUTHORIZED` | 可信网关身份缺失或无效 |
| 404 | `PROCESS_RUN_NOT_FOUND` | 未知或不属于当前 caller 的 Run |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一 caller/key 已绑定不同请求 |
| 429 | `CALLER_BACKLOG_LIMIT_REACHED` | caller backlog 已满；等待 `Retry-After`，继续查询已接受 Run |
| 503 | `ASYNC_SERVICE_CAPACITY_REACHED` | 全局 backlog 已满 |
| 503 | `ASYNC_SERVICE_UNAVAILABLE` | 异步依赖暂时不可用 |
| 503 | `ASYNC_INTAKE_CLOSED` | 运维已关闭新异步提交；同步 `/execute` 与既有 owner GET 仍可用 |

## Webhook 通知

异步入口开放且调用方已由服务端预注册 Webhook Endpoint 时，服务发送 `process_run.succeeded` 或 `process_run.failed` 终态事件。当前没有公开的 Endpoint 注册 API；产品请求也不能携带 Webhook URL。

```json
{
  "schemaVersion": 1,
  "eventId": "d52b4d30-3bfd-4c73-b0bc-e4c67fd97aa1",
  "type": "process_run.succeeded",
  "createdAt": "2026-08-14T10:00:02.000Z",
  "data": {
    "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
    "process": "minimal-zine-poster",
    "version": "v1",
    "status": "succeeded",
    "resultLocation": "/process-runs/c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c"
  }
}
```

Webhook 只通知终态，不携带业务输入、输出或内部错误。接收方验证签名后，使用与 Run owner 相同的网关身份读取 `data.resultLocation`。

每次请求包含以下 Standard Webhooks 风格的头：

| Header | 内容 |
| --- | --- |
| `webhook-id` | `eventId`；同一事件重试时保持不变 |
| `webhook-timestamp` | 签名时的 Unix 秒时间戳 |
| `webhook-signature` | 一个或两个以空格分隔的 `v1,<base64-hmac>`；两个签名表示 Secret 正在轮换 |

验签时保留收到的原始请求 body，不要先解析再重新序列化。移除 Secret 的 `whsec_` 前缀并 Base64 解码得到 HMAC key，然后计算：

```text
signed = webhook-id + "." + webhook-timestamp + "." + raw-request-body
expected = "v1," + base64(HMAC-SHA256(key, signed))
```

使用常量时间比较任一 `v1` 签名，并拒绝超出接收方允许时间偏差的时间戳。接收方按 `eventId` 幂等处理，只在事件已可靠保存后返回 `2xx`。

Webhook 是至少一次投递，不保证跨 Run 的全局顺序。网络错误、超时、`429` 和 `5xx` 会重试；`3xx` 不跟随，`410` 会停用 Endpoint。重复或延迟通知不改变 Run 的权威状态。

## Process 契约

### Process：`minimal-zine-poster`（`v1`）

完整请求 body：

```json
{
  "process": "minimal-zine-poster",
  "version": "v1",
  "input": {
    "brief": "为雨天旧书店制作一张安静的海报",
    "text": "RAINY BOOKS"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `brief` | string | 是 | 去除首尾空白后为 1–12000 个字符 |
| `text` | string | 否 | 去除首尾空白后为 1–80 个字符 |

响应 `output`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string | 服务端生成的绘图 Prompt |
| `recipe` | object | 包含 `layout`、`anchor`、`typography`、`accent`、`texture` 和 `mood` |
| `interpretation` | string | 对业务 brief 的视觉解释 |
| `image` | object | 生成的约 3:5 图片，结构见[图片对象](#图片对象) |

### Process：`crt-interface-image`（`v1`）

完整请求 body：

```json
{
  "process": "crt-interface-image",
  "version": "v1",
  "input": {
    "sourceImageUrl": "https://assets.example.com/source.png",
    "palette": "经典",
    "aspectRatio": "4:3",
    "grain": "normal"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `sourceImageUrl` | string | 是 | FAL 可匿名读取的公网 HTTPS URL，最长 2048 个字符；不接受 IP、端口、片段或认证信息 |
| `palette` | string | 是 | `经典`、`粉黛`、`极客01`、`极客02`、`复古01`、`复古02`、`游戏01`、`游戏02` 或 `如图` |
| `aspectRatio` | string | 是 | `3:4`、`4:3`、`9:16` 或 `16:9` |
| `grain` | string | 否 | 像素颗粒度 `fine`、`normal` 或 `coarse`，缺省 `normal`；`normal` 与未引入该字段时的输出字节级一致 |

响应 `output`：

```json
{
  "aspectRatio": "4:3",
  "image": {
    "url": "https://assets.example.com/crt/result/run.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  },
  "rawImage": {
    "url": "https://assets.example.com/crt/raw/run.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `image` | CRT 处理后的最终产物，结构见[图片对象](#图片对象) |
| `rawImage` | CRT 处理**之前**的模型原图。保留它即可在之后换一个 `grain` 重新出图而不必再次调用模型；它使用供应商返回的栅格格式，尺寸不受 CRT 输出约束 |

两者写入不同的对象前缀（`result/` 与 `raw/`），便于分别配置生命周期规则。

服务端把 `sourceImageUrl` 原样交给 FAL。图片来源不能依赖 Cookie、内网地址或本机服务。

### 新闻图片 Process（`v1`）

以下三个 Process 使用相同的请求结构：

| process | `output.style` | 图片风格 |
| --- | --- | --- |
| `news-image-narrative-monument` | `narrative-monument` | 人物叙事碑式 |
| `news-image-pale-watercolor` | `pale-watercolor` | 淡彩绘本 |
| `news-image-raw-humanism` | `raw-humanism` | 原质人文主义 |

完整请求 body（以下示例使用淡彩绘本）：

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检覆盖多座桥梁，并发现需要进一步检查的安全隐患。"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `title` | string | 是 | 去除首尾空白后为 1–300 个字符 |
| `summary` | string | 是 | 去除首尾空白后为 1–12000 个字符 |

响应 `output`：

```json
{
  "style": "pale-watercolor",
  "image": {
    "url": "https://assets.example.com/news-image/result.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  }
}
```

新闻图片固定为 4:3 PNG；当前生产图片服务输出 1600×1200。

### Process：`composed-task`（`v1`）

部署显式设置 `COMPOSED_TASK_ENABLED=true` 后才可调用。完整请求 body：

```json
{
  "process": "composed-task",
  "version": "v1",
  "input": {
    "goal": "把这段介绍精简后做一张极简 zine 海报",
    "material": {
      "copy": "雨天的旧书店，安静、缓慢，适合长时间停留。"
    },
    "constraints": {
      "maxSteps": 3
    }
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `goal` | string | 是 | 去除首尾空白后为 1–4000 个字符的自然语言目标 |
| `material` | object | 否 | 至多 16 个条目；键匹配 `^[a-z][a-zA-Z0-9]{0,31}$`，值为 1–12000 个字符的字符串。这是 Planner 能转交给各步骤的全部业务素材 |
| `constraints.maxSteps` | integer | 否 | 1–8，只能收紧服务端上限，不能放宽 |

调用方不能指定步骤、Process 顺序、Skill、模型或 Tool。服务端 Planner 从固定 allow-list（七个 Process，不含照片海报）中选择步骤，每个步骤仍按该 Process 自己的输入契约校验，并受服务端 `COMPOSED_TASK_MAX_STEPS`（默认 6）与 `COMPOSED_TASK_MAX_PRICED_STEPS`（默认 2，限制成功的图片步骤数）约束。

响应 `output`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `summary` | string | Planner 对所做步骤的一两句说明 |
| `steps` | array | 按执行顺序列出全部步骤，包括失败的；每项含 `step`、`process`、`version`、`status`，成功时带该 Process 的 `output`，失败时带 `error.code` 与 `error.message` |
| `result` | JSON | 逐字取自成功步骤输出的值：某个步骤的完整 `output`、其中一个子值，或由这类子值组成的平铺对象 |

部分步骤失败而 Planner 合理收尾时仍返回 `succeeded`，失败信息保留在 `steps` 中。`steps` 里的图片步骤输出沿用[图片对象](#图片对象)。

该 Process 专属的失败语义：

| error.code | 条件 |
| --- | --- |
| `AGENT_FAILURE` | Planner 未运行任何成功步骤、输出无法解析，或 `result` 不是逐字取自成功步骤 |
| `DEPENDENCY_FAILURE` | 运行过的步骤全部因业务服务不可用失败，且没有任何付费步骤成功 |
| `DEPENDENCY_FAILURE_AFTER_COMMIT` | 至少一个付费图片步骤已成功，但 Planner 之后失败、超时或输出无效；已产生费用，不得自动重试 |
| `PROCESS_TIMEOUT` | 整个 Run 超过 `COMPOSED_TASK_TIMEOUT_MS`（默认 600000 毫秒）；进行中的步骤一并取消 |

一次调用可能触发多次付费图片生成，费用上限由服务端 `COMPOSED_TASK_MAX_PRICED_STEPS` 决定。同一 Run 的每个步骤以 `<runId>.<step>` 作为下游幂等键。

## 成功响应

接口成功时返回 HTTP `200`：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "succeeded",
  "output": {
    "style": "pale-watercolor",
    "image": {
      "url": "https://assets.example.com/news-image/result.png",
      "contentType": "image/png",
      "width": 1600,
      "height": 1200
    }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `runId` | string | 本次执行的唯一标识；排查问题时提供此值 |
| `process` | string | 实际执行的 Process |
| `version` | string | 实际执行的版本 |
| `status` | string | 成功时固定为 `succeeded` |
| `output` | object | Process 对应的输出 |

## 图片对象

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 可访问的 HTTP(S) 图片地址 |
| `contentType` | string | 是 | 海报支持 PNG、JPEG、WebP；CRT 和新闻图片固定为 `image/png` |
| `width` | integer | 是 | 图片宽度，单位为像素 |
| `height` | integer | 是 | 图片高度，单位为像素 |
| `expiresAt` | string | 否 | 临时 URL 的 ISO 8601 失效时间 |

调用方直接使用 `url`，不要自行拼接对象存储路径。

## 失败响应

Process 执行失败时，响应包含 `runId`：

```json
{
  "runId": "c48dfd91-973f-4ee1-9d04-dd2b46ba8c9c",
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "status": "failed",
  "error": {
    "code": "INVALID_INPUT",
    "message": "The process input is invalid"
  }
}
```

HTTP 层在执行前拒绝请求时，不返回 `runId`：

```json
{
  "status": "failed",
  "error": {
    "code": "UNSUPPORTED_MEDIA_TYPE",
    "message": "Content-Type must be application/json"
  }
}
```

| HTTP 状态 | error.code | 说明 |
| ---: | --- | --- |
| 400 | `INVALID_INPUT` | JSON 结构或 Process 输入无效 |
| 404 | `PROCESS_NOT_FOUND` | Process 或版本不存在 |
| 413 | `REQUEST_TOO_LARGE` | 请求体超过服务端限制 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` 不是 JSON |
| 500 | `INVALID_OUTPUT` | Process 输出不符合契约 |
| 500 | `INTERNAL_ERROR` | 服务端发生内部错误 |
| 502 | `AGENT_FAILURE` | Agent 未能完成任务 |
| 502 | `DEPENDENCY_FAILURE` | Business Capability、图片服务或存储服务不可用；是否已经产生外部副作用取决于 Process，付费图片调用不得据此自动重试 |
| 502 | `DEPENDENCY_FAILURE_AFTER_COMMIT` | 图片已生成并计费，但后处理、存储或引用解析失败导致无法交付；`composed-task` 中指付费步骤已成功而 Run 未能完成。重试会再次产生费用，不得自动重试 |
| 503 | `SERVICE_BUSY` | 同步执行容量已满；按 `Retry-After` 重试 |
| 504 | `PROCESS_TIMEOUT` | 执行超时 |

错误响应不会返回 Prompt、模型响应、凭证或内部异常正文。

`error.code` 保持稳定，`error.message` 是面向人的中文说明，可随诊断改进变化。照片海报、极简海报、CRT、新闻图片、内容优化及模板编译的可识别模型失败只说明阶段和已知原因；运维建议仅在控制台展示；不能识别时明确写“具体原因尚未确认”。整体超时仍返回 `PROCESS_TIMEOUT`；外部取消沿用 `INTERNAL_ERROR`，消息明确取消，运维活动终态标记 `cancelled`。这些说明不增加自动重试权限，已产生副作用时仍须先核对原请求。

公开文案按“失败事实、调用方约束、运维操作”区分。公开响应说明已知失败事实；仅当会影响调用方是否发起新副作用时，保留明确约束，例如“可能已产生费用，请勿直接重新生成或重放付费操作”。核对凭证、DNS/Fake-IP、日志、取消来源、步骤耗时或下游请求状态属于运维排查，只在控制台展示；不使用“核对后再试”暗示完成检查就允许重投。Attempt 的取消、超时和未知异常只陈述结果，图片读取只陈述无法读取/解码或已知地址拒绝。已有公开错误码与重试合同不变。

## 重试判断

| 结果 | 调用方动作 |
| --- | --- |
| 异步提交没有返回 `runId`，或返回 `429`、`503` | 等待 `Retry-After`，使用同一个 `Idempotency-Key` 和完全相同的请求重试 |
| 异步提交响应丢失或客户端超时 | 使用同一个 `Idempotency-Key` 和完全相同的请求重试；不得生成新 key |
| 异步 GET 返回 `503` | 等待 `Retry-After` 后安全重试同一个 GET |
| 同步 `/execute` 在执行前返回 `SERVICE_BUSY` | 等待 `Retry-After` 后可以重试 |
| 同步调用返回 `INVALID_INPUT`、`PROCESS_NOT_FOUND` 或其他确定性 `4xx` | 修正请求后再调用 |
| 同步调用网络超时、连接中断、`PROCESS_TIMEOUT` 或 `DEPENDENCY_FAILURE` | 执行和外部副作用可能已经发生。先按 `X-Request-Id` 联系服务方排查；付费图片 Process 不自动重试 |
| `DEPENDENCY_FAILURE_AFTER_COMMIT` | 已越过计费或外部提交点，不自动重试 |

同步入口每次接受请求都会创建新的 `runId`，没有调用方幂等保证。异步入口的幂等保证只作用于同一已认证 caller、同一个 key 和同一个规范化请求。

## 调用示例

curl：

```bash
curl -X POST 'https://pi.ganjiuwanshi.com/execute' \
  -H 'content-type: application/json' \
  -d '{
    "process": "news-image-pale-watercolor",
    "version": "v1",
    "input": {
      "title": "城市开始使用无人机巡检老旧桥梁",
      "summary": "首批巡检发现需要进一步检查的安全隐患。"
    }
  }'
```

PowerShell：

```powershell
$body = @{
    process = "news-image-pale-watercolor"
    version = "v1"
    input = @{
        title = "城市开始使用无人机巡检老旧桥梁"
        summary = "首批巡检发现需要进一步检查的安全隐患。"
    }
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
    -Uri "https://pi.ganjiuwanshi.com/execute" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body
```

异步提交与轮询：

```bash
idempotency_key='replace-with-one-stable-operation-id'

curl --include --request POST 'https://pi.ganjiuwanshi.com/process-runs' \
  --header 'authorization: Bearer replace-with-gateway-credential' \
  --header "idempotency-key: ${idempotency_key}" \
  --header 'content-type: application/json' \
  --data '{
    "process": "minimal-zine-poster",
    "version": "v1",
    "input": { "brief": "为雨天旧书店做一张安静的海报" }
  }'

curl --include \
  --header 'authorization: Bearer replace-with-the-same-caller-credential' \
  'https://pi.ganjiuwanshi.com/process-runs/replace-with-run-id'
```

JavaScript 同步调用：

```javascript
const response = await fetch("https://pi.ganjiuwanshi.com/execute", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-request-id": crypto.randomUUID(),
  },
  body: JSON.stringify({
    process: "minimal-zine-poster",
    version: "v1",
    input: { brief: "为雨天旧书店做一张安静的海报" },
  }),
  signal: AbortSignal.timeout(260_000),
});

const result = await response.json();
if (!response.ok || result.status !== "succeeded") {
  throw new Error(`${result.error?.code ?? response.status}: request failed`);
}
```

## 图片背景参数

CRT 与九个照片海报的 `v1` 接受可选 `background: auto | transparent | opaque`；省略时保留原行为。背景参数直接传给模型，不追加或改写提示词；CRT 后处理同步变换 alpha。透明成品必须同时存在可见与透明像素；不符合时失败且不自动重绘。该参数进入下游幂等摘要，不能用同一个键切换背景。发布时先部署 Pipipi，再开放 Memebuy 能力声明；本地验证不代表生产已生效。

例如：`{"process":"woodcut-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","background":"transparent"}}`。其他 Process 未开放该字段。FAL 参数取值依据 [GPT Image 2 编辑接口](https://fal.ai/models/openai/gpt-image-2/edit/api)。

## 照片海报

规则编译失败仍为 HTTP 502 / `AGENT_FAILURE`，`error.message` 说明失败阶段与可识别原因，运维排查建议仅在控制台展示，例如“照片海报规则编译失败（校验编译规则：模型结果未通过规则校验）”。可区分鉴权、限流、连接、服务端拒绝或不可用、模型超时或取消、空响应、响应未完成、JSON 和 Schema 错误；不能识别时明确写“具体原因尚未确认”。调用方按错误码处理，不解析文案，不自动重试。响应不包含模型正文、字段原值、供应商地址或异常。整体超时仍为 `PROCESS_TIMEOUT`，外部取消沿用 Runner 的 `INTERNAL_ERROR`，活动标记为 `cancelled`。

以下九个 Process 均使用 `POST /execute`，版本固定为 `v1`。每次处理一张照片；批量由调用方逐张提交，不能上传流程、Skill、模型或运行参数。

| process | style | 输出规格 |
| --- | --- | --- |
| `dopamine-photo-poster` | `dopamine` | 1200×1600 PNG |
| `mono-color-photo-poster` | `mono-color` | 1200×1600 PNG |
| `travel-abstraction-photo-poster` | `travel-abstraction` | 1200×1600 PNG |
| `crayon-photo-poster` | `crayon` | 1200×1600 PNG |
| `monochrome-photo-poster` | `monochrome` | 1200×1600 PNG |
| `woodcut-photo-poster` | `woodcut` | 1200×1600 PNG |
| `photo-doodle-collage` | `photo-doodle-collage` | 1200×1600 PNG |
| `photo-fashion-manga` | `photo-fashion-manga` | 1200×1600 PNG |
| `manga-panels` | `manga-panels` | 1200×1600 PNG |

除旅行抽象、日式时装漫画与漫画分镜外，input 为 `{ sourceImageUrl, text? }`。sourceImageUrl 必须为公网 HTTPS URL（最大 2048 字符，无凭据、片段、自定义端口或 IP 字面量）；text 为 1–200 字符的海报原文，不参与模型或风格选择。

### 漫画分镜

`manga-panels/v1` 接收公网 HTTPS `sourceImageUrl`、可选 `preset` 与 `background`。只允许以下固定预设；省略时使用 `three-panel-details`。不接受 `dialogues`、`text`、画格数量、任意风格或 Prompt，越权字段与非法预设返回 `INVALID_INPUT`。

| preset | 效果 | 构图 |
| --- | --- | --- |
| `three-panel-details` | C · 细节三格 | 上方约三分之一为两个细节格，下方约三分之二为主体；清晰墨线与克制网点 |
| `sketchy-mixed-panels` | D · 粗笔拼页 | 约七成的斜向主格，加右上眼神与左下细节；粗细笔触、干笔及黑块 |

两者均为三个画格、中性黑白、无文字。主格保留原图可见姿态，细节取自原图已有的脸、手或配饰；不补出不可见身体，不增加故事动作。原图 URL 不进入文本 Agent。`background` 沿用图片背景合同；固定黑白画法不改写背景参数。技术成功不证明视觉验收通过。

Memebuy 可将两个模板分别绑定同一 Process 与固定 preset，用户只需上传参考图。返回 `style` 为 `manga-panels`，preset 保留于运行输入，不增加正式输出字段。

```json
{"process":"manga-panels","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/person.png","preset":"sketchy-mixed-panels"}}
```

### 日式时装漫画文案

`photo-fashion-manga/v1` 接收真实单人照片的 `sourceImageUrl`，以及可选的 `background` 和以下文案。画风固定为墨黑轻线、红蓝平涂与米白纸底；照片决定人物身份、服装类别、动作和可见身体范围，不补画照片外身体。暂不接收第二张风格图。

| 字段 | 长度 | 省略时的默认值 | 位置与颜色 |
| --- | --- | --- | --- |
| `text` | 0–200 字符 | `WIBI\nSTYLE` | 下方主标题，首行暖红、次行灰蓝 |
| `kicker` | 0–100 字符 | `EVERYDAY, REDRAWN.` | 上方墨黑小引题 |
| `caption` | 0–100 字符 | `my own way.` | 头肩旁更小的墨黑小注 |

每项独立覆盖，空字符串或纯空白表示去掉该项，`null` 无效。主标题保留明确分行；没有换行时按自然词界适配两行，单词不拆写。全部文案保留大小写与标点，仅作为待印刷文字，不参与规则编译；其他照片 Process 不接受 `kicker` 或 `caption`。

```json
{"process":"photo-fashion-manga","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/person.jpg","text":"MY OWN\nSTYLE","kicker":"EVERYDAY, REDRAWN.","caption":""}}
```

### Mono Color 可编辑预设

`mono-color-photo-poster/v1` 在上述输入之外接受以下可选业务参数。旧请求不传这些参数时，保持 Skill 自动搭配。只要提供设计参数而未指定 `preset`，基于 `blue_orange_overlap` 补齐默认值。显式设置优先于预设；`preset` 字符串作为调整项的值时表示跟随当前预设。

| 字段 | 允许值 |
| --- | --- |
| `preset` | `blue_orange_overlap`（蓝橙穿字）、`blue_orange_diagonal_crop`（蓝橙斜切）、`black_red_statement`（黑红宣言）、`black_red_frame`（黑红取景框）、`black_red_diagonal_type`（黑红斜排） |
| `palette` | `preset`、`cobalt_terracotta`、`charcoal_red`、`green_oxblood` |
| `typography` | `preset`、`literary`、`condensed` |
| `composition` | `preset`、`editorial_cover`、`diagonal_crop`、`statement`、`frame`、`diagonal_type` |
| `emphasis` | `preset`、`gentle`、`balanced`、`bold` |
| `texture` | `preset`、`light`、`standard`、`strong` |
| `designNotes` | 1–500 字符的设计偏好；不覆盖结构化设置、主体保持、文字和输出规则 |

```json
{"process":"mono-color-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","preset":"blue_orange_diagonal_crop","palette":"charcoal_red","typography":"preset","text":"MY CAT","designNotes":"注释放左下角"}}
```

五个预设的默认设计如下；标题占比随 `emphasis` 调整，用户原文优先于分行要求，单词或长文案会适应版式，不补词或删词。

| 预设 | 标题与版式 |
| --- | --- |
| `blue_orange_overlap` | 蓝色衬线大标题分两行占下部约 35–45%，与原有主体轮廓穿插，橙色仅点缀主体细节 |
| `blue_orange_diagonal_crop` | 上部蓝色主标题与斜向裁切边界结合，短引导词可用橙色，露出主体焦点 |
| `black_red_statement` | 炭黑大标题在下部紧密堆叠两行、约占 35–45%，红色点缀现有主体细节，不退化成底部单行字幕 |
| `black_red_frame` | 上部较小红色标题、下部更大炭黑标题围合主体；仅保留原图已有的取景手势 |
| `black_red_diagonal_type` | 炭黑两行大字从左下向中部上扬，与右侧主体穿插，深色交叠处留纸白轮廓，红色局部点缀 |

五个预设默认使用接近白色的干净纸底、阴影细网点和清晰轮廓，不强制泛黄、粗网点或动漫化。线稿和阴影使用主色，背景留白，不铺大块辅色底板。显式覆盖配色或版式后，标题颜色分工跟随最终解析的配色与版式；显式 `texture: "strong"` 仍可使用粗网点。设计规则在编译前传入，并在最终图片指令中覆盖通用 Skill 的复古印刷要求。

旧 `preset` 值仍兼容：`within_reach` → `blue_orange_overlap`、`half_hidden` → `blue_orange_diagonal_crop`、`your_move` → `black_red_statement`、`hold_still` → `black_red_frame`、`look_again` → `black_red_diagonal_type`。只在输入校验时转换，复用相同设计规则；新调用使用新标识，Process 仍为 `v1`。

五个预设来自样图的设计归纳，不是作者公开的精确配方。它们调整版式和印刷处理，保留输入图主体、数量、动作及核心关系；不会为匹配示例额外制造伸手或手势。`text` 留空时按实际参考图提炼短英文，不把预设名印在画面上。只返回单张 1200×1600 PNG，不提供可编辑图层。其他照片 Process 不接受这些新增字段。

### 其他照片海报示例

```json
{"process":"dopamine-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","text":"SUMMER DAYS"}}
```

摄影剪贴与涂鸦小人示例：

```json
{"process":"photo-doodle-collage","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","text":"don't let go."}}
```

旅行抽象 input 为 `{ sourceImageUrl, phrase, archiveNumber?, capturedOn? }`。phrase 是用户根据照片提供的 1–3 个大写英文单词，最多 60 字符；archiveNumber 为 1–999，默认 1，无跨请求计数；capturedOn 为 YYYY-MM-DD，缺省采用服务端 UTC 创建日期，不猜测拍摄日期。

```json
{"process":"travel-abstraction-photo-poster","version":"v1","input":{"sourceImageUrl":"https://assets.example.com/photo.png","phrase":"QUIET PAWS","archiveNumber":1,"capturedOn":"2026-09-07"}}
```

成功 output 为 `{ style, image: { url, contentType: "image/png", width, height, expiresAt? } }`。正式输出不返回 Prompt、原图 URL、模型、Skill、供应商或存储配置。全部输出均为独立风格化成品，不附原照片、不分上下对照。旅行抽象的档案字样直接绘制在抽象成品上。

输入或额外字段不合法返回 INVALID_INPUT；版本不匹配返回 PROCESS_NOT_FOUND；编译失败返回 AGENT_FAILURE；明确未发起图片调用时失败返回 DEPENDENCY_FAILURE；已发出图片调用、响应丢失、保存失败或内部 pending 返回 DEPENDENCY_FAILURE_AFTER_COMMIT。禁止对后者自动重试，先核对执行记录。Process 超时仍按统一 PROCESS_TIMEOUT 契约处理，图片费用可能已产生。

内部图片服务 `POST /photo-posters` 是受控 Capability 协议，不供产品直连；使用 `CRT_BUSINESS_API_BASE_URL`，连接超时由服务端 `PHOTO_POSTER_API_TIMEOUT_MS` 配置，默认 180000 ms。

## 模板图片生产与两次审核

以下三个固定 Process 仅供受信任的 Memebuy 后台调用，均使用既有 `/execute` 或 `/process-runs` Interface。不得向普通用户开放可自行填写 reviewerRef 的调用入口。Process 身份、模型、Skill、存储与执行指令均由服务端固定；浏览器只提交候选 ID、当前摘要和审核决定。

| Process / version | input | output | Process 预算 |
| --- | --- | --- | --- |
| `template-image-plan/v1` | `{ imageUrl, note? }`，沿用原图片编译输入限制 | `{ productionId, sourceImageSha256, strategySha256, strategy }` | 240 秒 |
| `template-image-render/v1` | `{ productionId, objectSha256, reviewerRef }`，objectSha256 为方案摘要 | `{ productionId, imageSha256, reviewPackageSha256, width, height, imageDataUrl }` | 270 秒 |
| `template-from-source/v1` | `{ productionId, objectSha256, reviewPackageSha256, reviewerRef, note? }`，objectSha256 为成图摘要，note 为本轮模板编译要求 | `{ template, coverImageUrl, preparedImage }` | 570 秒 |

模板内容不满意时，调用方可用原成图审批发起新的编译轮次，并提交可选 `note`（去首尾空白后 1–500 字符）。新要求只覆盖本次编译的备注，不修改方案、生图指令或成图批准；省略时沿用原方案备注。已经上传的审核图片复用内容寻址对象，不重新生图或上传，返回的图片摘要保持不变。新轮次仍须人工审阅模板草稿；异步调用使用新轮次的幂等键，技术失败恢复沿用原运行。

方案校验失败时可在原 240 秒预算内进行一次受限字段修正，仍不通过则返回 `AGENT_FAILURE`；不会自动生图或批准方案。

productionId 为 UUID；摘要为小写 64 位 SHA-256；reviewerRef 为 1–191 字符的服务端审核者引用。字段闭合，不接受额外运行配置。strategy 是待人审阅的完整业务方案，包含替换目标、类别判断、组件分组、依赖与特征权限、文字/标记动作、冻结项、风险；准确结构由 `GET /processes` 的输出 Schema 给出，调用方不能用策略正文替代已持久化 productionId。新输出另含 execution：`{ version: "v2", prompt, promptSha256 }`，精确十二段指令由服务端从策略生成，与源图及策略一起纳入 strategySha256。原审批入参保持不变。

targetCanvas 增加 carrierRole（none/apparel/device/mechanism）、reason、excludedScopes；frozenSet 改为 `{ scope: "design" | "carrier" | "environment", regionId, instruction }[]`；文字项增加 originalText、componentId，exactText 表示最终文字，删除为空串。replacementComponentIds 关联闭包中实际替换的组件。审核端应展示这些业务要求，旧记录缺失字段标记“未记录”。完整场景需显示依据并显式勾选确认。

已保存的旧方案不自动转换：尚未提交生成的方案必须重新规划和确认；已知 requestId 继续恢复，已有成图继续原审批。明确拒绝、未知提交和需要重新批准的提示沿用现有公开错误分类。明确非重试 4xx 不恢复批准；未知提交禁止重投。

imageDataUrl 是完整 PNG 的 Base64 Data URL，原 PNG 至多 20,000,000 字节，整个成图审核输出至多 28,000,000 字节。该特例只属于固定 render Registration，其他输出仍受默认上限约束。审核方必须保存交接结果并等待人工批准，不因收到图片而自动调用下一步。

preparedImage 为 `{ url, sha256, width, height, contentType: "image/png" }`；url 固定为 `https://assets.memebuy.cn/gallery/template-images/<sha256>.png`。template.cover、template.referenceImage 和 coverImageUrl 均引用该图片。公开输出不包含原始策略、两次审批或业务备注。

方案失败返回 `AGENT_FAILURE`；生图或上传编译不能确定完成时返回 `DEPENDENCY_FAILURE_AFTER_COMMIT`。这些错误不授权重新付费生图：人工恢复必须提交原 productionId 与原批准摘要。已知供应商请求继续查询，未知生成提交需要对账。重试编译可能重新调用编译模型，但不会再生成图片。

## 可重复制作与成图版本

Memebuy 分步工作台可保留同一替换方案反复生图。`template-image-render/v1` 兼容可选 UUID `renderId`；同一 `productionId + renderId` 恢复原成图，不同 `renderId` 表示人工明确的新生图。缺省保持旧单图语义。成图审核包摘要包含 `renderId`，`template-from-source/v1` 的图片审批须原样携带该字段，不能跨版本采用审批。每个成图独立保留 attempt、图片、审核与上传记录，提交未知时复用原身份仍禁止重投。模板重编译继续复用同一图片和审批，返回新候选；草稿身份、版本、采用和真实测试由 Memebuy 管理。

先发布支持此字段的 Pi API 与内部图片 Business API，再发布 Memebuy Web 和 Worker；旧方案与旧成图文件原样兼容。
