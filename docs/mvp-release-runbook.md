# 受控 Business Process MVP 发布手册

本手册面向发布与运维人员，用于发布现有同步 Business Process 服务，包括文本处理、`minimal-zine-poster/v1` 与 `crt-interface-image/v1`。生产 Compose 同时运行主 API 和内部 CRT Business API；后者负责 FAL GPT Image 2、确定性 finalizer 与阿里云 OSS。CRT 候选还依赖产品图片上传和来源权利确认；缺少任一门禁时不得开放该 Process。本文不发布异步作业或公网匿名接口。项目范围以
[`CONTEXT.md`](../CONTEXT.md) 为准；文档维护要求见 [`docs/README.md`](README.md)。

## 发布边界

只允许受控调用方通过私有入口或可信网关访问服务。入口必须终止 TLS、认证调用方，并阻止客户端绕过网关访问容器端口。浏览器通过现有后端或 BFF 调用；服务不启用 CORS。

部署平台负责入口认证。应用继续根据服务端注册表决定可用的 Business Process、版本、Agent 模式和 Tool；调用方不能选择模型、Skill、Tool 或下游地址。

## 初始容量与超时

| 控制项 | 初始值 | 约束 |
| --- | ---: | --- |
| 单实例执行并发 | 2–4 | `MAX_CONCURRENT_EXECUTIONS` 必须与平台实例并发相匹配 |
| 最大实例数 | 2–5 | 在平台设置硬上限，形成模型费用上限 |
| 请求体 | 262144 字节 | 用 `HTTP_MAX_REQUEST_BODY_BYTES` 调整 |
| Business Capability 超时 | 10 秒 | `BUSINESS_API_TIMEOUT_MS=10000` |
| Poster Rendering Capability 超时 | 90 秒 | `POSTER_API_TIMEOUT_MS=90000` |
| CRT Rendering Capability 超时 | 180 秒 | `CRT_API_TIMEOUT_MS=180000` |
| Process Run 超时 | 240 秒 | 本发布显式设置 `PROCESS_TIMEOUT_MS=240000`；代码默认 30 秒。`composed-task/v1` 本发布保持 `COMPOSED_TASK_ENABLED=false`；开启时它自带 `COMPOSED_TASK_TIMEOUT_MS`（默认 600 秒），平台请求超时必须随之调高 |
| 平台请求超时 | 270–300 秒 | 必须长于 Process Run 超时 |

服务在上限以内并发执行请求。每个 Agent 请求建立独立内存会话；实例之间不共享业务会话，因此平台可以水平扩容。提升并发或实例数前，先检查实例内存、P95 延迟、Business Capability 容量、模型配额和单次运行成本。

## 运行配置

部署平台通过环境变量和 Secret 注入配置。镜像不包含 `.env` 文件或凭证。

| 变量 | 要求 |
| --- | --- |
| `BUSINESS_API_BASE_URL` | 必填；供文本和海报 Capability 使用。CRT 可以通过单独的 `CRT_BUSINESS_API_BASE_URL` 覆盖 |
| `CRT_BUSINESS_API_BASE_URL` | Compose 固定为 `http://127.0.0.1:4400`，不要写入产品请求 |
| `PORT` | 可选；默认 `3000` |
| `CONTENT_PROCESSING_MODE` | `direct` 或 `agent`；默认 `direct` |
| `HTTP_MAX_REQUEST_BODY_BYTES` | 正整数；默认 `262144` |
| `MAX_CONCURRENT_EXECUTIONS` | 正整数；默认 `4` |
| `BUSINESS_API_TIMEOUT_MS` | 正整数；代码默认 `10000`，本发布显式设置 `10000` |
| `POSTER_API_TIMEOUT_MS` | 正整数；代码默认 `90000`，本发布显式设置 `90000` |
| `CRT_API_TIMEOUT_MS` | 正整数；代码默认 `180000`，本发布显式设置 `180000` |
| `PROCESS_TIMEOUT_MS` | 正整数；代码默认 `30000`，本发布必须显式设置 `240000` |
| `PROCESS_RUN_LOG_LEVEL` | Pino 阈值；默认 `info`，生产建议保留 `info` 以观察完整活动时间线 |
| `ASYNC_PROCESS_RUNS_ENABLED` | 本同步 MVP 必须保持 `false`；异步生产发布使用独立 Runbook |
| `PROCESS_RUN_RECORD_STORE` | `file` 或 `postgres`；默认 `file`，生产 Compose 固定为 `postgres` |
| `DATABASE_URL` | `PROCESS_RUN_RECORD_STORE=postgres` 时必填。必须启用 TLS；自签证书用 `uselibpqcompat=true&sslmode=verify-ca&sslrootcert=<挂载路径>` 固定证书 |
| `PROCESS_RUN_RECORD_POOL_MAX` | 记录存储独占的连接上限；默认 `4`，与异步角色的池分开，避免记录挤占业务连接 |
| `PROCESS_RUN_OBSERVATION_TIMEOUT_MS` | Worker 等待活动冲刷与终态观测写入的上限；默认 `2000`，数据库 Pool 同时设置 query/statement timeout |
| `PROCESS_RUN_RECORD_DIRECTORY` | 文件存储的目录；必须是宿主机卷。生产 Compose 保留为 `/var/lib/pipipi-run-records`，以便回退到文件存储时不改 Compose |
| `PROCESS_RUN_RECORD_CONTENT` | `omit` 或 `accepted-input-and-output`；默认 `omit`，生产设为后者 |
| `PROCESS_RUN_RECORD_RETENTION_DAYS` | 正整数；默认 `30`。应与对象存储生命周期规则对齐 |
| `CONSOLE_ENABLED` | `true` 或 `false`；默认 `false`。为 `true` 时必须配置可用观测存储；文件模式必须设置 `PROCESS_RUN_RECORD_DIRECTORY` |
| `CONSOLE_BASE_PATH` | 控制台挂载路径；默认 `/console`，不得遮蔽 `/execute`、`/process-runs`、`/healthz` 或 `/readyz` |
| `PI_PROVIDER`、`PI_MODEL` | 按组设置；海报与 CRT 流程始终使用 Agent |
| `OPENAI_BASE_URL`、`OPENAI_API_MODE` | 使用 OpenAI 或兼容网关时设置 |
| `PI_SKILL_DIRECTORY` | 可选；只覆盖固定的 `content-optimization` 路径，不改变 Skill 集合 |
| `PI_POSTER_SKILL_DIRECTORY` | 可选；只覆盖固定的 `minimal-zine-poster-prompt` 路径 |
| `PI_CRT_SKILL_DIRECTORY` | 可选；只覆盖固定的 `tait-crt-interface-prompt` 路径 |
| `PI_PALE_WATERCOLOR_SKILL_DIRECTORY` | 可选；只覆盖固定的 `news-image-pale-watercolor-prompt` 路径 |
| `PI_RAW_HUMANISM_SKILL_DIRECTORY` | 可选；只覆盖固定的 `news-image-raw-humanism-prompt` 路径 |
| `PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY` | 可选；只覆盖固定的 `news-image-narrative-monument-prompt` 路径 |
| `OPENAI_API_KEY` | 执行使用 OpenAI 的 Agent 时由平台 Secret 注入；禁止写入镜像、仓库或普通配置 |
| `FAL_KEY` | 内部 CRT Business API 调用 FAL 的生产 Secret |
| `OBJECT_STORAGE_PROVIDER` | 生产 Compose 固定为 `aliyun-oss` |
| `OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` | CRT 最终 PNG 的持久化配置 |
| `OSS_URL_ACCESS` | `signed` 或 `public`；使用 `public` 时还必须设置 `OSS_PUBLIC_BASE_URL` |

若 Business Capability 需要认证，优先使用私网身份、工作负载身份或服务网格。当前 HTTP Adapter 不发送调用方提供的任意认证头。`POST /posters` 与 `POST /crt-images` 必须以 `Idempotency-Key: <runId>` 去重，并返回在声明期限内可访问的 HTTP(S) 图片 URL；短期签名 URL 必须返回 `expiresAt`。CRT endpoint 接受经过主 API 校验的公网 HTTPS URL，并原样交给 FAL。生产 Compose 固定 `CRT_IMAGE_EVIDENCE_MODE=off`，产品请求不能覆盖证据策略。

`PROCESS_TIMEOUT_MS=240000` 是本手册的受控发布覆盖值，不改变代码的 30 秒默认值。它必须长于 `CRT_API_TIMEOUT_MS`；候选镜像、部署平台和回滚配置都必须显式保留该覆盖值。启用异步 Worker 时，`PROCESS_RUN_CLAIM_LEASE_MS` 还必须长于 Process 总超时。

## 部署环境预检

构建完成并由平台注入目标环境的变量和 Secret 后，先运行 API 角色预检：

```bash
npm run check:deployment-env -- api
npm run check:deployment-env -- crt-business-api
```

同步 API 的无默认必填项是 `BUSINESS_API_BASE_URL`；设置 `PI_PROVIDER=openai` 时还必须提供 `OPENAI_API_KEY`。API 与 Process Worker 预检还会读取镜像内七个 Runtime Skill，校验目录、`SKILL.md`、精确名称与版本、固定哈希和快照内容；失败时只输出脱敏事件并返回非零状态。生产部署在数据库迁移和容器切换前执行该预检，因此旧 `.env` 中失效的 Skill 路径覆盖不会进入活动服务。CRT Business API 预检要求 FAL、存储供应商和 OSS 凭证；Compose 固定供应商为 `fal` 与 `aliyun-oss`。若目标环境设置 `ASYNC_PROCESS_RUNS_ENABLED=true`，API 预检还会检查异步角色变量。缺少任一项时，命令一次列出全部变量名并返回非零状态；它不输出值，也不连接外部系统。

实际生产启动会在创建 Adapter 前重复同一检查，再校验 URL、正整数、枚举和跨字段约束。预检通过不证明 Secret 有效或依赖可达。`PI_PROVIDER` 与 `PI_MODEL`、模型凭证、Business Capability 契约和图片持久化仍按本手册的 smoke 与发布门禁验证。

## 运行时兼容性

当前入口是主动监听 `0.0.0.0:$PORT` 的 Node.js 24 HTTP 进程，并在运行时读取镜像内的 Skill 文件。普通 Docker 主机、Kubernetes 和支持长运行容器的平台可以运行同一镜像。

Vercel Functions、Netlify Functions 和 Cloudflare Workers 不能直接运行当前入口。迁移到函数或边缘运行时前，必须把主动监听改成平台 Handler，并重新设计文件资源、长请求、取消和超时。

## 单服务器 GitHub Actions 发布

仓库通过 [production CI/CD](../.github/workflows/production-ci-cd.yml) 把同步 API 发布到一台 Linux Docker 服务器。Pull Request 并行执行确定性的 `Check and build` 与真实依赖的 `Async durable acceptance`；后者在隔离 PostgreSQL/Redis 中按固定顺序验证 Store、BullMQ/跨 Seam 和构建控制台的浏览器旅程，并始终执行 Compose 清理。新闻图片付费验收默认关闭，不影响非 Pull Request 候选；启用后，相关路径命中时必须先由 required reviewer 批准 `news-image-acceptance` Environment，并让准确 `github.sha` 完成三个真实 Process Run。`main` 推送和手动触发只有免费检查与已启用且需要的付费验收都成功后，才把镜像归档与生产 Compose 上传服务器并激活。生产 Job 使用 GitHub `production` Environment，并与新闻图片验收及异步 internal 发布共享 `pipipi-production-release` 并发组；服务器的 `shared/deployment.lock` 还会拒绝 Actions 之外的并发发布。

生产镜像固定 Node.js 24、编译产物、生产依赖和七个 Runtime Skill，不包含源码、`.env` 或凭证。服务器加载 `pipipi:<commit>` 镜像，再通过 [`compose.production.yaml`](../compose.production.yaml) 以同一镜像重建 `pipipi` 和 `pipipi-business-api` 两个容器。部署脚本校验两个容器的 image tag、revision label、liveness 和 readiness；失败时恢复部署前的镜像与 Compose 形状。release artifact 同时携带 `pipipi-<commit>.compose.async.yaml`，但自动部署不上传或激活它；该文件只供通过异步 Runbook 门禁后的显式叠加部署使用。若服务器存在任一异步角色容器，默认同步流水线会拒绝继续；发布人员必须先按异步手册停流、处理已接受 Run，并执行显式回退，不能借普通发布隐式删除 Worker。

异步 `internal` 使用独立的手动 [`Async internal release`](../.github/workflows/async-internal-release.yml)，不属于本同步流水线的自动步骤。它由 `async-internal` Environment 授权并复用本流水线产出的候选 artifact；完整配置、证据和回退要求见[异步发布手册](async-process-runs-runbook.md#受控-internal-发布入口)。

### GitHub 配置

在仓库 Settings → Secrets and variables → Actions 配置部署连接。所有值使用 Repository scope，与现有项目保持一致。

Repository secrets：

| 名称 | 内容 |
| --- | --- |
| `SSH_PRIVATE_KEY` | GitHub Actions 连接部署账户的私钥 |
| `SSH_KNOWN_HOSTS` | 经独立可信渠道核对的目标服务器 host key；`production` 与 `async-internal` Environment 都必须可读取 |

Repository variables：

| 名称 | 内容 |
| --- | --- |
| `REMOTE_HOST` | 服务器域名或 IP |
| `REMOTE_USER` | 部署账户，当前服务器填写 `root` |
| `REMOTE_PATH` | 绝对部署目录，例如 `/opt/pipipi` |
| `CONSOLE_PUBLIC_URL` | 已由入口网关保护的完整 HTTPS 控制台路径；生产发布会在替换容器前验证匿名请求均被拒绝 |
| `NEWS_IMAGE_ACCEPTANCE_ENABLED` | 可选；精确设为 `true` 才启用新闻图片付费验收，缺省或其他值均跳过且不阻塞发布 |

workflow 的生产 Job仍使用 GitHub `production` Environment 记录部署并执行并发控制。应在 Settings → Environments 创建 `production`，配置 required reviewer 和 `main` 分支限制，并把已核对的 `SSH_KNOWN_HOSTS` 保存为该 Environment 的 Secret；`async-internal` Environment 同样保存该值。其他连接 Secret 和 Variable 可使用 Repository scope。

当前无需创建 `news-image-acceptance` Environment；保持 `NEWS_IMAGE_ACCEPTANCE_ENABLED` 未设置即可默认跳过。需要启用时，先创建 required-reviewer 管理并限制为 `main` 的 `news-image-acceptance` Environment，再把 Repository Variable `NEWS_IMAGE_ACCEPTANCE_ENABLED` 设为 `true`。该 Environment 的 Secrets 是 `OPENAI_API_KEY`、`FAL_KEY`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 和可选 `OSS_STS_TOKEN`；Variables 是 `PI_MODEL`、`OPENAI_API_MODE`、可选 `OPENAI_BASE_URL`、`OSS_REGION`、`OSS_BUCKET`、可选 `OSS_ENDPOINT` 与 `OSS_CNAME`、`NEWS_IMAGE_ACCEPTANCE_EXPECTED_OSS_HOST`、`NEWS_IMAGE_ACCEPTANCE_EXPECTED_OSS_PATH_PREFIX` 和两位小数的正数 `NEWS_IMAGE_ACCEPTANCE_COST_LIMIT_USD`。使用最小权限、短期凭证和验收专用对象前缀；reviewer 在批准前确认三次 Agent、三次 FAL 图片生成和三次 OSS PUT 的预算。workflow 不把这些值写入 artifact。

Actions 私钥只用于连接服务器。服务器不需要读取 Git 仓库或访问镜像仓库，因为流水线直接上传 CI 生成的镜像归档和 Compose 文件。

### 服务器初始化

以下命令会安装软件和创建系统目录，只能由有 sudo 权限的运维人员在目标服务器执行：

```bash
sudo apt update
sudo apt install -y curl docker.io docker-compose-v2 util-linux
```

1Panel 已安装 Docker 时不要重复安装；只需确认 Docker Engine 与 Compose 可用：

```bash
docker version
docker compose version
```

Node.js 24 和生产 npm 依赖都在镜像内，服务器不需要安装 Node.js、npm 或 PM2。随后建立共享配置目录：

```bash
mkdir -p /opt/pipipi/shared
chmod 700 /opt/pipipi/shared
install -d -m 700 -o 1000 -g 1000 /opt/pipipi/shared/crt-business-api
```

在 `/opt/pipipi/shared/.env` 写入生产配置，并设置权限：

```bash
chmod 600 /opt/pipipi/shared/.env
```

文件至少固定以下值，其他变量按 [环境变量样例](../.env.example) 和本手册“运行配置”补齐：

```dotenv
NODE_ENV=production
PORT=4300
BUSINESS_API_BASE_URL=https://business-api.example.internal
CONTENT_PROCESSING_MODE=direct
BUSINESS_API_TIMEOUT_MS=10000
POSTER_API_TIMEOUT_MS=90000
CRT_API_TIMEOUT_MS=180000
PROCESS_TIMEOUT_MS=240000
HTTP_MAX_REQUEST_BODY_BYTES=262144
MAX_CONCURRENT_EXECUTIONS=4
ASYNC_PROCESS_RUNS_ENABLED=false
FAL_KEY=replace-with-production-secret
OBJECT_STORAGE_PROVIDER=aliyun-oss
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=replace-with-bucket
OSS_ACCESS_KEY_ID=replace-with-production-key
OSS_ACCESS_KEY_SECRET=replace-with-production-secret
OSS_URL_ACCESS=public
OSS_PUBLIC_BASE_URL=https://assets.example.com
CRT_IMAGE_MODEL=gpt-image-2
CRT_IMAGE_QUALITY=low
CRT_IMAGE_TIMEOUT_MS=180000
CRT_IMAGE_OBJECT_PREFIX=crt-interface-image
```

即使文本流程使用 `direct`，海报和 CRT 流程仍使用 Agent。生产 catalog 包含这些流程时，必须配置可用的 `PI_PROVIDER`、`PI_MODEL`、`OPENAI_BASE_URL`、`OPENAI_API_MODE` 和对应模型凭证。Compose 会把 `CRT_BUSINESS_API_BASE_URL` 固定到内部 `127.0.0.1:4400`；不要在 `.env` 中覆盖它。`BUSINESS_API_BASE_URL` 继续服务文本和海报流程。

### SSH 配置

在可信机器生成专用部署密钥，不要复用个人 SSH 密钥：

```bash
ssh-keygen -t ed25519 -C "pipipi-github-actions" -f ./pipipi-deploy
```

把 `pipipi-deploy.pub` 加入服务器部署账户的 `~/.ssh/authorized_keys`，把私钥正文保存为 Repository secret `SSH_PRIVATE_KEY`。

从服务器控制台或另一条可信管理通道读取 SSH host key 指纹，由两名运维人员与服务器记录核对后，把完整 known_hosts 行保存为 `production` 和 `async-internal` Environment secret `SSH_KNOWN_HOSTS`。流水线固定 `StrictHostKeyChecking=yes`，不在发布网络路径上调用 `ssh-keyscan`；host key 轮换必须先复核并更新两个 Environment，不能临时关闭校验。

### 1Panel、OpenResty 与防火墙

两个生产容器都使用 host 网络。主 API 监听 `0.0.0.0:4300`，保持现有 OpenResty 上游；CRT Business API 只监听 `127.0.0.1:4400`，无需配置 1Panel 网站或安全组规则。服务器防火墙不得向公网开放 `4300` 或 `4400`；1Panel 管理的 OpenResty 只反代主 API。

在 1Panel 应用商店安装 OpenResty后，通过“网站 → 创建网站 → 反向代理”转发到 `http://<服务器内网IP>:4300`。OpenResty 运行在容器中时，不要默认使用指向容器自身的 `127.0.0.1`。以下配置仅用于说明等价的代理参数：

```nginx
server {
    listen 443 ssl;
    server_name process.example.com;

    client_max_body_size 256k;

    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

以上片段不包含证书和身份认证。生产入口必须按“发布边界”接入现有可信网关、mTLS 或 `auth_request`，不能直接匿名开放。只允许外部访问 SSH、HTTP 跳转和 HTTPS；阻止公网访问 `4300` 以及 Business API 的内部端口。

### 首次发布与日常发布

首次发布前，在服务器确认以下命令成功：

```bash
docker version
docker compose version
test -f /opt/pipipi/shared/.env
curl --version
```

随后在 GitHub Actions 手动运行 `Production CI/CD`，或把已评审改动合入 `main`。流水线依次执行确定性检查、构建镜像、验证 Business API 必填变量、用 Compose 重建两个容器、核对 image/revision，并检查两项服务的健康端点。

发布成功后在服务器确认：

```bash
docker compose --project-name pipipi \
  --file /opt/pipipi/shared/compose.production.yaml ps
docker inspect pipipi \
  --format 'image={{.Config.Image}} revision={{index .Config.Labels "com.pipipi.revision"}} status={{.State.Status}} health={{.State.Health.Status}}'
docker inspect pipipi-business-api \
  --format 'image={{.Config.Image}} revision={{index .Config.Labels "com.pipipi.revision"}} status={{.State.Status}} health={{.State.Health.Status}}'
curl --fail http://127.0.0.1:4300/healthz
curl --fail http://127.0.0.1:4300/readyz
curl --fail http://127.0.0.1:4400/healthz
curl --fail http://127.0.0.1:4400/readyz
```

流水线不会运行付费图片流程。完成确定性健康检查后，发布负责人按本手册“发布门禁”从受控入口执行对应 smoke 和图片业务验收。

### 回滚与镜像清理

健康检查失败时，流水线自动恢复部署前的镜像。已经成功发布但随后出现业务问题时，运维人员选择已知正常的本地镜像 tag 手工切换：

```bash
IMAGE="pipipi:<known-good-commit>"
PIPIPI_IMAGE="$IMAGE" \
PIPIPI_REVISION="<known-good-commit>" \
PIPIPI_ENV_FILE="/opt/pipipi/shared/.env" \
  docker compose --project-name pipipi \
  --file /opt/pipipi/shared/compose.production.yaml \
  up -d --force-recreate --no-build
curl --fail http://127.0.0.1:4300/healthz
curl --fail http://127.0.0.1:4300/readyz
curl --fail http://127.0.0.1:4400/healthz
```

确认当前版本和至少一个回滚镜像后，才用 `docker image rm pipipi:<commit>` 删除不再需要的旧镜像。不要删除当前容器或回滚候选使用的镜像，也不要在同一次回滚中修改生产 `.env`。

## Run Record 策略

`PROCESS_RUN_RECORD_STORE` 选择记录存储，两个实现通过同一套契约测试：

| 取值 | 存储 | 必需配置 | 用途 |
| --- | --- | --- | --- |
| `postgres` | PostgreSQL 两张表 | `DATABASE_URL` | 生产。数据库有备份，列表、筛选与聚合是查询而不是手写扫描 |
| `file`（默认） | 按 UTC 日期分文件的 JSONL | `PROCESS_RUN_RECORD_DIRECTORY` | 本地开发与测试，不依赖数据库 |

无论哪种，存储都必须在容器之外：容器每次发布都会重建。文件存储不设置目录时不记录任何内容，行为与引入前一致。

记录**不受 `ASYNC_PROCESS_RUNS_ENABLED` 影响**。同步发布同样需要说清楚自己做过什么，因此记录与异步开关是独立关注点，只共用 `DATABASE_URL`。

Run Record 是给运维看的观测记录，不是异步 Run Store：它只保存已终态的结果，不承载排队与运行中状态，也没有任何代码读它来决定业务状态、重试或投递。

同一个存储还保存 Run Activity 归档（PostgreSQL 的 `process_run_activities` 表，或 `activities-YYYY-MM-DD.jsonl`）。Pino 输出到 stdout 的活动日志会同时写入这里，因此 Attempt 与活动级时间线在容器重建后仍可按 `runId` 还原。Pino 侧行为不变，既有日志采集不受影响；持久化侧失败被隔离，不影响 stdout 输出，也不改变 Process 结果。

两个归档是各自独立的尽力而为写入，不改变 Process 的权威结果。同步 `/execute` 不等待观测，因此响应后记录仍可能稍晚落盘；异步 Worker 在 Store 接受权威终态后，用有界等待先冲刷该进程已接受的活动，再写 Run Record，使控制台看到异步终态记录时也能看到其时间线。超过 `PROCESS_RUN_OBSERVATION_TIMEOUT_MS` 或写入失败会被隔离，不能阻止 Queue 确认或耗尽 Worker concurrency。

`PROCESS_RUN_RECORD_CONTENT` 决定内容边界：

| 取值 | 保存内容 |
| --- | --- |
| `omit`（默认） | 只保存 `runId`、Process、版本、状态、错误码和记录时间 |
| `accepted-input-and-output` | 追加已校验的业务输入与成功输出 |

生产当前使用 `accepted-input-and-output`，以便控制台回看每次执行提交了什么、产出了哪张图。以下边界仍然成立：

1. `crt-interface-image` 的 `sourceImageUrl` 永远只保存 SHA-256 摘要，完整 URL 不进入记录。
2. 不保存系统 Prompt、Tool 过程、模型消息、隐藏推理、无效请求内容或内部错误详情。
3. 记录中的图片 URL 指向对象存储。`PROCESS_RUN_RECORD_RETENTION_DAYS`（默认 30）应与 OSS 生命周期规则对齐，否则过期对象会在控制台留下死链。
4. Adapter 写入失败不得改变 Process Run 的返回结果；记录发生在响应路径之外，因此记录可能比响应稍晚落盘。
5. 保留期以整日文件为单位，超出窗口的文件在启动时删除。

### 数据库前置条件

发布前，`REMOTE_PATH/shared/` 下必须同时具备：

1. `.env` 里的 `DATABASE_URL`，指向应用专用数据库，并带 TLS 参数；
2. `pg-server.crt`，即 `DATABASE_URL` 中 `sslrootcert` 指向的证书。

两者缺任何一个，发布都会在替换容器**之前**失败：部署脚本会先跑 api 角色的环境预检，再检查证书文件是否存在。这是刻意的——记录写入是尽力而为，配置错误不会让服务崩溃，只会让它安静地什么都不记录，因此必须在部署期拦截而不是等到上线后发现空白页面。

证书是公开信息，不是密钥，但不进仓库。导出方式：

```bash
openssl s_client -starttls postgres -connect <数据库主机:端口> </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > /opt/pipipi/shared/pg-server.crt
```

Schema 由部署脚本在激活新容器前执行 `npm run db:migrate` 应用，因此 `node-pg-migrate` 与 `migrations/` 随生产镜像发布。迁移使用 advisory lock，重复执行安全。紧接着，部署脚本在同一镜像和 `DATABASE_URL` 上运行 `npm run audit:production-database`，通过 live session 强制验证 TLS 已启用、数据库不是 `postgres`/template 维护库、登录角色不是 PostgreSQL superuser，不具备建库、建角色、复制或绕过 RLS 等管理权限，不属于任何其他角色，不能连接同集群的其他非模板数据库，且 `session_user` 与 `current_user` 相同。任何一项失败都在替换容器前停止；用 `postgres` 登录再 `SET ROLE` 到应用角色或通过继承角色间接获得权限都不再被接受。共享集群应撤销其他数据库对该登录角色及 `PUBLIC` 的 `CONNECT`，再只向应用角色授予 `pipipi` 数据库所需权限。

若审计失败且不能从脱敏错误分类确定修复方式，可对已上传的候选镜像手动运行 `Production database boundary inspection`。该只读 workflow 绑定 `production-database-inspection` 受保护 Environment，输入活动 revision 与候选 SHA。它报告当前连接是否使用 TLS、是否切换角色、是否拥有管理权限或其他数据库访问，以及固定 CA 后 TLS 和有效角色直登是否可用。`currentConnection.clientTls` 来自候选进程的实际 socket，表示应用到 `DATABASE_URL` 端点这一跳；`currentConnection.tls` 来自 `pg_stat_ssl`，表示执行查询的 PostgreSQL 后端看到的入站连接。两者不一致说明中间可能有数据库代理，不能把任一字段当成端到端加密证明。`connectionTargetPortMatchesBackend` 只比较连接串端口和 PostgreSQL 报告的后端端口，不输出端口值；不相等时，检查器会在同一目标主机的后端端口用固定 CA 做一次只读探测，只有客户端与后端 TLS 都成立且数据库实例身份精确一致，`directBackendEndpointAvailable` 才为真。`serverTlsEnabled` 只表示 PostgreSQL `ssl` 设置已开启；`serverCertificateConfigured` 与 `serverKeyConfigured` 只表示对应 GUC 路径非空，不证明文件存在、可读或匹配。`tlsWithoutCertificateVerificationAvailable` 用 `sslmode=require` 区分“服务端未提供 TLS”和“CA 验证失败”，不能替代固定 CA 门禁。两条 TLS 探针以客户端 socket 为准，其 `FailureReason` 只会是 `none`、认证失败、证书校验失败、服务端 TLS 不可用、会话未使用 TLS、传输失败或未预期失败；成功时必须为 `none`，失败时必须为其他枚举。`directEffectiveRoleLoginWithoutTlsAvailable` 显式关闭客户端 TLS，只用于区分角色凭证/HBA 与 TLS 配置问题，绝不是可接受的生产连接形状；`directEffectiveRoleBoundaryVerified` 仍同时要求客户端与 PostgreSQL 后端两跳都使用 TLS。artifact 不包含数据库名、角色名、主机、端口、连接串或原始错误。检查入口不执行 SQL DDL/DCL、不改 `.env`、不重启容器；修复仍需另行评审和批准。

自签证书且按 IP 连接时不能用 `verify-full`：它校验主机名，而证书的 SAN 通常只有内部主机名。`verify-ca` 配合固定证书等价于证书 pinning，主动中间人无法用另一张证书冒充。`uselibpqcompat=true` 不能省，否则当前 `pg` 版本会把 `verify-ca` 也当成 `verify-full`。

## 运维控制台

`CONSOLE_ENABLED=true` 时，API 在 `CONSOLE_BASE_PATH`（默认 `/console`）挂载一个自包含的运维页面。它是运维 Interface，不属于产品契约，也不在 [`docs/api.md`](api.md) 中记录。

| 路由 | 用途 |
| --- | --- |
| `GET {base}` | 控制台页面。带不带尾斜杠都可以 |
| `GET {base}/assets/<file>` | 构建产物。文件名带内容哈希，因此按不可变缓存返回 |
| `GET {base}/runs?limit=&before=&process=&status=&errorCode=&since=&until=` | 按记录时间倒序读取 Run Record；组合筛选 Process、状态、错误码和时间范围。`since` 为闭区间、`until` 为开区间；`before` 是服务端返回的不透明稳定游标 |
| `GET {base}/runs/{runId}` | 读取单条 Run Record |
| `GET {base}/runs/{runId}/activities` | 读取该 Run 的 Attempt 与活动时间线，按 Attempt 序号和 sequence 排序 |
| `GET {base}/processes` | 读取生产 catalog：精确版本、固定活动名、Registration 级重试策略，以及输入输出字段表 |
| `GET {base}/stats?hours=` | 窗口内的执行计数、按 Process 汇总、UTC 每日吞吐与错误码分布、最近失败、Attempt 耗时分位数，以及实时并发占用。`hours` 为 1–720，缺省 24 |

页面是 Preact + Vite 构建的单页应用，四个视图：运行记录（检索、组合筛选、稳定翻页，以及声明活动顺序与各 Attempt 实际顺序的对照）、服务压力（每日吞吐、错误随时间分布和最近失败）、Process 目录、提交任务。它由 `npm run build` 一并构建到 `dist/console`，随镜像发布，由 API 同源提供——服务不启用 CORS，控制台不能独立部署到其他源。

构建工具与框架是 devDependencies，生产镜像用 `--omit=dev` 安装运行时依赖，因此它们不进入运行时容器，只有构建产物进入。

资源路由只提供构建输出 `assets` 目录下的单个文件，文件名按严格模式校验而不是解析为路径，因此请求无法走出构建目录。页面本身按部署的 `CONSOLE_BASE_PATH` 注入 `<base>`，所以改路径不需要重新构建。

提交表单由 `{base}/processes` 返回的 Schema 生成：新增 Process 或改字段不需要改控制台。Console Process Run Client 在首次 POST 前把请求 SHA-256 摘要、幂等键、创建时间和恢复分类写入 tab-scoped `sessionStorage`；收到 `202` 后再保存 `runId` 与公开 Process identity。它不保存业务输入、输出、凭证或隐藏运行配置。响应丢失、可重试 admission 和刷新后的恢复都复用同一 key；未确定或可重试操作只有在操作者点击“明确开始新提交”时才会被替换。accepted 映射不能被新提交覆盖，必须等终态完成或由操作者点击“移除恢复记录”。Storage 读取、写入或清理失败时，Client 返回结构化不可用结果，且在无法完成首次持久化时禁止发送 POST。

页面只调用 Console Process Run Client Interface。该 Module 在运行时校验提交、拒绝和查询响应，向页面公开 accepted/observed 进度，以及 succeeded、failed、结果过期、查询超时、客户端取消、acceptance unknown、可重试 admission、明确拒绝、恢复冲突、恢复存储不可用和协议错误；非 JSON、缺字段、未知状态、不一致的 `runId`，以及跨源或错误资源形状的 `Location` 都不会被页面当成有效 Process Run。刷新后，页面可继续查询已接受的 Run；未确定提交要求操作者重新填写相同输入，Client 以摘要匹配后才允许同 key 重放。

恢复记录按浏览器标签页隔离，只解决同一标签页刷新与单一活动操作，不跨标签共享。可信网关必须保证一个控制台标签页内的 caller session 稳定；切换 caller 前必须先处理或明确移除该标签页的恢复记录，不能把旧 caller 的 uncertain 操作带入新身份。

`{base}/processes` 的字段表由每个 Process Registration 自己的 Zod Schema 推导，因此不会与 `accept` 实际执行的校验漂移。它**不取代** [`docs/api.md`](api.md)：错误语义、计费边界、提交后依赖失败不可自动重试这类约束无法从 Schema 推导，仍以那份文档为准。某个 Schema 无法表示为 JSON Schema 时，该字段被省略而不是让整个目录视图失败。

注意 `retry` 报告的是 Registration 级策略。`crt-interface-image` 在图片调用前对无副作用 Agent 编译的重试发生在 Registration 内部，不计为 Attempt，因此不出现在这里。

启用前必须理解的四件事：

- **控制台没有自带鉴权。** 页面上的提交表单会真实调用 `POST /process-runs`，每次都可能产生图片费用。公网入口必须在 OpenResty 一侧加 Basic Auth 或 `auth_request`；可信网关还必须按异步 Interface 的要求注入 caller 身份。缺少任一层保护时，不得开放提交页面。
- **必须先配置 `PROCESS_RUN_RECORD_DIRECTORY`。** 缺少它时部署环境预检和启动构造都会直接失败，避免上线一个永远空白的页面。
- **提交依赖异步运行角色。** 基础同步 Compose 仍保持 `ASYNC_PROCESS_RUNS_ENABLED=false`；部署方必须先按[异步发布手册](async-process-runs-runbook.md)完成 migration、角色、身份和容量门禁，再开放控制台提交。
- **页面默认查询 300 秒。** 期限从 durable acceptance 后开始。有效 `Retry-After` 限制在 1–30 秒；缺失或无效时使用 1、2、4、8、16、30 秒的有界退避。瞬时 GET transport，以及 `429`、`502`、`504` 和经过验证的 `500`/`503` 服务失败会在期限内恢复；稳定 `401`/`404` 与协议错误立即结束当前等待。查询超时、AbortSignal 或关闭页面只会中止 transport、timer 与 polling，不会请求服务端取消；恢复映射保留，操作者仍可用同一 `runId` 继续查询，终态随后写入 Run Record。

OpenResty 上为控制台加 Basic Auth 的等价配置：

```nginx
location /console {
    auth_basic "pipipi console";
    auth_basic_user_file /etc/nginx/conf.d/console.htpasswd;
    proxy_pass http://<服务器内网IP>:4300;
}
```

现有生产虚拟主机由 1Panel 管理、Console 与其他 Interface 共用同一反代时，使用受保护的 [Console gateway change](../.github/workflows/console-gateway-change.yml) 做一次性变更。工作流要求先由只读 readiness artifact 固定宿主配置路径、SHA-256、网关容器名与容器内配置路径；`CONSOLE_GATEWAY_APPLICATION_CONTAINER` 固定提供 Console 的应用容器。变更前再次核对完整摘要、mount Adapter 和应用容器的 `com.pipipi.revision` label，从已核验备份生成 candidate，并在凭证安装前和原子替换前重复校验活动摘要，避免覆盖 1Panel 并发变更。它只在唯一 `server_name` 内按 `$uri` 为 Console 路径启用动态 Basic realm，不改变已有 `location` 或 `proxy_pass`。

工作流仅允许生产 root SSH Adapter，把 `CONSOLE_BASIC_AUTH_HTPASSWD` 与 `CONSOLE_AUTHORIZATION` 作为相互独立的 Environment Secret 临时传到权限为 `0700` 的服务器目录；认证文件由 root 持有、group 精确设置为活动 OpenResty worker GID，权限为 `0640`。安装后执行 `openresty -t` 和 reload，再对页面、Process 目录和统计 Interface 分别执行本机 HTTPS 与公网匿名/认证探测。reload 后的匿名探测最多重试 20 次，等待新 OpenResty worker 接管；连接失败、超时和非 `401` 都只表示本轮尚未就绪。六组匿名探测的最坏预算约 149 秒；连同六组认证探测，全部探针不超过 4.5 分钟，为 10 分钟 Job 保留回滚时间。窗口结束时仍未出现 Basic challenge 就回滚。匿名请求必须返回带 `WWW-Authenticate: Basic` challenge 的 `401`；普通上游 `403` 不算认证生效。认证请求必须返回 `200`，并满足 HTML、Process catalog JSON 或统计 JSON 契约。

正常版本的六条认证响应都必须携带输入 revision 的 `x-pipipi-revision`。若活动旧版本尚未实现该响应头，Environment 可临时设置 `CONSOLE_GATEWAY_LEGACY_REVISION`；它必须精确等于本次输入 SHA。此兼容路径仍要求六条返回体契约全部匹配；旧统计响应必须提供 totals、byProcess、byErrorCode、concurrency 和 attemptDurationMs，新版响应仍必须提供 byDay 与 recentFailures。工作流还会在探测前后确认应用容器保持运行、容器身份未变且 revision label 精确匹配；它不接受空、重复、混合或错误响应头。新版本上线后删除该变量。配置测试、reload、探测、revision、契约、证据输出或 SSH hangup 任一步失败都恢复本次实际改变的配置与认证文件，并再次测试、reload；若 1Panel 在 activation 前改变配置，只撤销本次认证文件变更，绝不以旧备份覆盖外部配置。成功 artifact 只记录状态码、revision、revision 验证方式和配置摘要；失败 artifact 只记录稳定失败阶段与 `rollbackStatus`，不包含用户名、凭证、响应体、配置正文或上游地址。

控制台上线后，还必须对当前生产 revision 手动运行 [Console production readiness](../.github/workflows/console-production-readiness.yml)。该工作流绑定受保护的 `console-production-readiness` Environment，只读检查服务器和公网网关，不部署镜像、不切换流量，也不触发 Process。Environment 需要以下配置：

| 类型 | 名称 | 含义 |
| --- | --- | --- |
| Variable | `REMOTE_HOST`、`REMOTE_USER`、`REMOTE_PATH` | 与生产发布相同的 SSH 目标 |
| Variable | `CONSOLE_PUBLIC_URL` | 已受网关保护的完整 HTTPS 控制台路径，不含 query、fragment 或凭证 |
| Secret | `SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS` | 只读核验服务器所需的 SSH 身份与固定 host key |
| Secret | `CONSOLE_AUTHORIZATION` | 可直接作为 HTTP `Authorization` header 值的控制台凭证 |
| Secret | `BACKUP_EVIDENCE_HMAC_KEY` | 至少 32 字节，只授予真实备份/恢复作业和该只读门禁，用于认证备份证据来源 |

工作流要求主 API 与内部 CRT Business API 都运行输入的完整 commit SHA，并在活动主 API 容器中重新执行数据库 live audit。它随后从 `$REMOTE_PATH/shared/postgres-backup/evidence.json` 读取备份平台发布的证据。该文件不是人工勾选项：必须由真实成功的备份作业与定期恢复演练生成，且写入前应验证备份对象确实可恢复。格式为：

```json
{
  "schemaVersion": 1,
  "event": "postgres_backup_verified",
  "status": "succeeded",
  "databaseIdentitySha256": "64位小写十六进制摘要",
  "backupId": "备份系统中的稳定非秘密引用",
  "completedAt": "2026-08-14T12:00:00Z",
  "restoreVerifiedAt": "2026-08-01T12:00:00Z",
  "retentionUntil": "2026-12-31T00:00:00Z",
  "signatureSha256": "64位小写十六进制 HMAC-SHA256"
}
```

`databaseIdentitySha256` 是 UTF-8 字节 `数据库名 + NUL + 登录角色名 + NUL + service_instance_identity.identity` 的 SHA-256。最后一项由 migration 在数据库首次建立时随机生成，随真实备份和恢复保留，但不直接写入证据；同名 staging 或重新初始化的数据库不能复用摘要。备份作业必须先验证备份对象存在，再从隔离恢复实例读取该身份并完成可用性检查，最后用 `BACKUP_EVIDENCE_HMAC_KEY` 对 `schemaVersion、event、status、databaseIdentitySha256、backupId、completedAt、restoreVerifiedAt、retentionUntil` 按此顺序用 NUL 连接的 UTF-8 字节计算 HMAC-SHA256。手写或来自另一套库的 JSON 无法通过签名与 live identity 双重校验。

时间必须是严格的 UTC 秒格式 `YYYY-MM-DDTHH:mm:ssZ`：备份完成不超过 24 小时，真实恢复验证不超过 90 天，剩余保留期不少于 30 天。公网核验要求未携带凭证访问控制台页面、Process 目录与统计 Interface 均返回 `401` 或 `403`；携带凭证不只要求 `200`，还会验证控制台 HTML 标记、Process catalog JSON 和统计 JSON 契约。若当前服务器存在异步 Compose 形状，同 revision 的 Process Worker 也必须在线，并固定使用 PostgreSQL 与完整输入输出观测策略。成功后只上传 revision、摘要、备份引用、时间、状态码和验证布尔值等无内容证据，保留 90 天；没有该次真实成功记录时，控制台的生产闭环未完成。

失败时同样上传 artifact。`server.json` 的 `failureGate` 标识 revision、异步形状、数据库或备份门禁，`databaseAuditFailure` 只使用稳定错误码：`database_url_required`、`tls_required`、`dedicated_database_required`、`non_superuser_required`、`administrative_privileges_present`、`other_database_access_present`、`role_switching_present`、`role_membership_present`、`invalid_audit_result` 或 `connection_or_unclassified_failure`。`prerequisites` 只记录活动容器与共享 `.env` 是否配置数据库、CA 文件和备份证据是否存在；它不上传连接串、环境变量值或远端原始异常。无法归类的连接错误必须回到服务器受控终端排查，不能为了诊断把原始 stderr 加进 Actions artifact。

服务器门禁失败时，工作流还会生成只读的 `gateway-host.json`。检查范围包括受控默认目录与运行中 OpenResty/Nginx 容器 mount 到 `nginx.conf`、`conf.d`、`sites-enabled` 或 `http.d` 的 host 配置来源；`sites-enabled` 支持无 `.conf` 后缀的普通文件、相对文件软链和映射到同一配置 mount 的容器绝对文件软链，目录、循环、越界或只在宿主机可达的软链会 fail closed，重叠目录中的同一 block 会去重。HTML、证书、日志或备份 mount 不参与扫描，也不能建立 reload 归属。事件 `console_gateway_host_inspected` 只记录与生产域名精确匹配的 `server` block 数量；唯一匹配时再记录配置绝对路径、文件 SHA-256、目标公网路径对应的 `location` 计数，以及该 block 内非注释的 `auth_basic`、`auth_request` 与 `proxy_pass` 指令计数。Docker reload Adapter 只有在唯一网关容器的允许配置 scope 覆盖命中配置时才成立，并按最长 Destination 匹配排除被子目录或单文件 mount 遮蔽的父配置，再记录容器内配置路径，供后续变更做精确前置条件。它不上传配置正文、反代目标、证书、认证文件或 Secret；容器枚举、mount 读取、配置枚举或解析不完整都会返回 `inspection_failed`，零个或多个 block 匹配也只用于诊断，不能自动选择文件或修改网关。

网关宿主定位成功后，失败门禁会继续生成只读的 `effective-gateway.json`。它对 `openresty -T` 做前后相同的只读快照，用分号、block、quote 与 comment 感知的语句解析器按 source 汇总容器规范路径、可验证的宿主映射、SHA-256，以及 `server_name` 精确匹配、`location`、`auth_basic`、`proxy_pass`、`include`、`satisfy`、`allow` 与 `deny` 的分类计数。访问控制只区分 `any`/`all` 与其他 operand，不上传 IP、网段或原始值。每个 source section 必须与容器内真实文件摘要一致；宿主映射按容器规范目标选择最长 mount，目标必须留在规范 mount source 边界内，且容器与宿主摘要相等。未映射到宿主的镜像内 source 仍保留容器摘要与计数，但宿主路径为 `null`。artifact 不包含配置正文、指令操作数、反代地址或 Secret；伪造或重复 source marker、非规范路径、子 mount 歧义、快照漂移、摘要不一致或无法读取时均 fail closed。该证据只用于定位覆盖关系，不能自动修改网关。

## 构建并检查镜像

从干净的发布提交构建镜像，并记录生成的镜像摘要：

```bash
docker build --pull -t pi-business-processing-service:rc .
docker image inspect pi-business-processing-service:rc --format '{{.Id}}'
```

发布系统应扫描镜像。推送仓库后，记录 registry 返回的 RepoDigest，并按该摘要部署。运行镜像前检查非 root 身份、生产依赖和 Skill：

```bash
docker run --rm --entrypoint id pi-business-processing-service:rc -u
docker run --rm --entrypoint sh pi-business-processing-service:rc -c \
  'test -f llms.txt && test -f docs/api.md && test -f .pi/skills/content-optimization/SKILL.md && test -f .pi/skills/content-integrity/SKILL.md && test -f .pi/skills/minimal-zine-poster-prompt/SKILL.md && test -f .pi/skills/tait-crt-interface-prompt/SKILL.md && test -f .pi/skills/news-image-narrative-monument-prompt/SKILL.md && test -f .pi/skills/news-image-pale-watercolor-prompt/SKILL.md && test -f .pi/skills/news-image-raw-humanism-prompt/SKILL.md && test ! -d node_modules/typescript && test ! -d node_modules/vitest'
```

用生产形状的非秘密配置启动候选镜像。健康检查不得访问模型或 Business Capability：

```bash
docker run --rm -d --name pi-business-processing-rc \
  -p 127.0.0.1:4300:4300 \
  -e BUSINESS_API_BASE_URL=http://business-capability.internal \
  -e BUSINESS_API_TIMEOUT_MS=10000 \
  -e POSTER_API_TIMEOUT_MS=90000 \
  -e CRT_API_TIMEOUT_MS=180000 \
  -e PROCESS_TIMEOUT_MS=240000 \
  -e HTTP_MAX_REQUEST_BODY_BYTES=262144 \
  -e MAX_CONCURRENT_EXECUTIONS=4 \
  -e ASYNC_PROCESS_RUNS_ENABLED=false \
  pi-business-processing-service:rc

curl --fail --silent http://127.0.0.1:4300/healthz
curl --fail --silent http://127.0.0.1:4300/llms.txt | grep -Fq '# Pipipi Business Process API'
curl --fail --silent http://127.0.0.1:4300/docs/api.md | grep -Fq '# 业务接口文档'
docker stop pi-business-processing-rc
```

## 发布门禁

候选版本必须依次通过以下门禁：

```bash
npm ci
npm run check
npm run typecheck
npm test
npm run build
docker build -t pi-business-processing-service:rc .
```

随后完成环境验收：

1. 从公网直接访问容器地址必须失败。
2. 授权调用方必须能通过 TLS 网关访问 `/healthz`、`/execute` 和 `/internal/eval/execute`；公开 Agent 必须能读取 `/llms.txt` 和 `/docs/api.md`，且两个文档来自同一候选镜像。网关未放行 `/internal/eval/execute` 时会先返回 `401`，请求不会到达应用。
3. 网关请求超时必须长于 `PROCESS_TIMEOUT_MS`。
4. 平台实例并发不得高于应用并发闸门；平台必须设置最大实例数。
5. 日志系统必须收到 Pino 单行 JSON，识别数值 `level`，能按 `runId`、`process`、`status|outcome` 和 `errorCode` 检索，并能按 `attemptNumber + sequence` 还原固定活动时间线；日志中不得出现业务内容、Prompt、Tool 参数、模型消息或内部异常正文。
6. `BUSINESS_API_BASE_URL` 必须连接真实 Business Capability。
7. `POST /posters` 必须按 `runId` 去重，并验证图片 URL 的访问控制、有效期、媒体类型和尺寸。
8. `POST /crt-images` 必须按 `runId` 去重，并验证资产权限、GPT Image 2 编辑、finalizer、PNG 引用、费用和删除生命周期；生产证据模式必须为 `off`，或有单独批准的数据保留策略。
9. 启用 `NEWS_IMAGE_ACCEPTANCE_ENABLED=true` 后，新闻图片相关候选必须让同一 commit 的三个固定 Process 经真实 Agent、FAL 和 OSS 各成功一次，并验证准确 style、单次图片生成、批准的 OSS 路径和 1600×1200 PNG；未启用时跳过该付费门禁。
10. 若候选版本注入了 Run Record Adapter，必须验证成功和失败记录可按 `runId` 查询，并验证存储故障不影响 `/execute` 结果。

Agent 模式启用后，先在受控发布 runner 中连接真实模型和 Business Capability。该命令强制使用 Agent 模式；若 Agent 未恰好调用一次 Business Capability、最终输出并非来自 Tool 结果，或默认受保护内容在 Tool 输入中发生变化，命令会失败。它可能产生模型费用：

```bash
BUSINESS_API_BASE_URL=https://business-capability.staging.internal \
npm run smoke:agent
```

随后确认部署平台已设置 `CONTENT_PROCESSING_MODE=agent`，再从授权入口检查已部署镜像：

```bash
STAGING_SERVICE_BASE_URL=https://private-agent.example.internal \
STAGING_AUTHORIZATION='Bearer replace-with-short-lived-token' \
npm run smoke:staging
```

第一条命令证明真实 Agent 和 Business Capability 都参与执行，并检查 Tool 调用次数、结果来源与默认受保护内容。第二条命令检查健康状态、一次结构化成功结果和一个字段严格受限的 `INVALID_INPUT` 失败响应。两条命令都不比较精确文案，也不输出业务内容、Tool 输入或认证值。

海报候选还必须运行本地业务验收。它会从产品 `POST /execute` 进入 production catalog，调用真实 Agent、production HTTP Adapter、受控 `POST /posters` Capability 与所选图片 Adapter；配置 OSS 时还会写远端对象。先确认测试主题、凭证、bucket、对象前缀和费用范围：

```bash
npm run accept:poster-business
```

通过后检查报告中的 `POST /execute` HTTP 200、单次 `POST /posters`、`runId` 幂等键、`minimal-zine-poster/v1`、四段 Prompt、六轴 recipe、图片字节、3:5 尺寸和 URL 下载哈希。该命令使用本地受控 Business API，不替代目标部署对 `POST /posters` 容量、权限和 URL 生命周期的验收。

CRT 候选先运行显式 GPT Image 2 edit smoke。它读取本地参考图、产生模型费用并写 `artifacts/`；确认图片不敏感、凭证和费用范围后再运行：

```bash
CRT_SOURCE_IMAGE_FILE=/absolute/path/to/non-sensitive-test-image.png \
npm run smoke:crt-gpt-image
```

该 smoke 不运行 Runtime Skill Agent、production catalog 或 finalizer。随后用一条 FAL 可读取的公网 HTTPS 图片 URL 运行完整业务验收：

```bash
CRT_SOURCE_IMAGE_URL=https://images.example.com/source.png \
IMAGE_PROVIDER=fal \
FAL_KEY=replace-with-local-secret \
npm run accept:crt-business
```

该命令进入产品 `POST /execute`，验证真实 Agent、单次 `POST /crt-images`、`runId` 幂等、FAL GPT Image 2 URL 编辑、确定性 finalizer、目标尺寸与调色板及结果下载。默认 `full` 证据模式按 `runId` 保存模型原始图、最终图和脱敏 manifest；配置 `OBJECT_STORAGE_PROVIDER=aliyun-oss` 后还验证 OSS 输出。

新闻图片候选不需要发布人员在普通提交上手工运行付费命令。默认未设置 `NEWS_IMAGE_ACCEPTANCE_ENABLED` 时，`Production CI/CD` 跳过该 Job 且不阻塞部署。显式设为 `true` 后，workflow 只在相关路径变化时进入受保护的 `news-image-acceptance` Environment；reviewer 确认准确 revision、费用上限、最小权限凭证、bucket 和批准的 host/path prefix 后放行。Job 临时启动当前 commit 的 production Composition 与图片 Business API，从产品 `POST /execute` 依次运行三个准确 Process，并要求三次 FAL 生成、三次 OSS PUT、三个不同 `runId`、固定 style 和可下载的 1600×1200 PNG。证据保留 90 天，只含 revision、Process identity、Run ID、图片摘要/尺寸/字节数、访问判据和费用批准摘要，不含测试新闻、Prompt、图片 URL、签名参数或凭证。启用后失败或未批准时，生产部署保持阻塞。

本地通过仍不满足生产发布门禁。发布前必须按 [`processes/common/crt-interface-image/`](processes/common/crt-interface-image/) 完成来源授权、生产上传的身份与资产安全、生产 `POST /crt-images`、持久化 URL、删除生命周期、九种调色板、四种画幅和人工视觉验收，并按 [CRT 图片证据保留](processes/common/crt-interface-image/evidence-retention.md) 确认生产模式与清理责任。

## 发布与回滚

保留上一版本的镜像摘要。先把少量受控流量切到新 revision，观察 5xx、503、超时、内存、模型配额和下游错误，再逐步增加流量。

出现以下任一情况立即回滚：授权路径不可用、容器端口公开可达、错误响应泄露内部信息、持续 5xx、超时显著增加、模型费用越过预算，或 Business Capability 饱和。回滚时把流量切回上一镜像摘要，停止新 revision，验证旧版本 `/healthz`，并用结构化日志保存受影响的 `runId`。

## 本次不发布

本次 MVP 不增加应用用户系统、RBAC、多租户、数据库、持久化或跨实例执行历史、Run Record 查询接口、通用幂等、队列、自动重试、CORS、生成后自动视觉质检、自动重绘或全量基础设施即代码。CRT 产品请求只提交公网 HTTPS `sourceImageUrl`；FAL 和 OSS 配置由服务端拥有。两个图片流程都有模型费用和图片持久化副作用，必须保持调用权限、`runId` 幂等、并发和费用门禁。
