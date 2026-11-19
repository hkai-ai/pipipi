# 仓库协作规则

## 开始工作

- 修改代码前先读 `CONTEXT.md`，再从 `docs/README.md` 找到对应专题文档。
- 修改或新增 Business Process 时，先阅读 [`docs/processes/README.md`](docs/processes/README.md) 及对应 Process 文档。
- 项目用 Business Process、Process Definition、Process Registration、Business Capability、Module、Interface、Implementation、Seam 和 Adapter 表达设计。用户口中的“工作流”在产品层映射为 Business Process；不要引入第二套 Workflow 领域模型。
- 保持 production catalog 显式、版本精确、服务端拥有。产品请求不能携带流程步骤、Skill、脚本、模型、Tool、来源地址或运行配置。
- 命名遵循 [`docs/development.md`](docs/development.md#命名规则)：使用能在当前作用域区分角色的最短名称，不重复目录上下文，也不使用自造缩写。
- `src/` 下每个源文件顶部必须有一行简体中文 docstring，用一句话说明文件职责；新增文件或职责变化时同步补齐或更新。

## 请求路由

- 用户用自然语言描述一段业务流程，并要求实现、封装或接入时，使用 `$author-business-process`。简短描述是有效输入；先从仓库事实推断安全默认值，只在公开契约、副作用或权限无法安全确定时提问。
- 用户给出 Skill 的本地路径、Git 仓库、仓库内子目录或网页地址，并要求使用、安装或接入时，使用 `$integrate-runtime-skill`。
- 同一请求同时包含流程描述和 Skill 来源时，先用 `$integrate-runtime-skill` 解析并审查来源，再用 `$author-business-process` 把已固定的 Runtime Skill 绑定到明确的 Process Registration。

## Skill 边界

- `.agents/skills/` 保存 Codex 使用的 Development Skill；`.pi/skills/` 保存服务端受限 Agent 使用的 Runtime Skill。两者调用方、权限和发布路径不同，不能互换。
- 本地路径或远程 URL 只作开发、安装或构建期的 Skill Source。共享或生产使用前必须检查完整目录、来源、许可证、脚本、Tool 与网络权限，固定不可变版本并保存本地快照或可复现安装记录。
- 生产请求路径只读取随应用发布、由服务端选择的本地 Runtime Skill，禁止按请求下载、更新或执行任意远程 Skill。
- 当前只有只读 Installed Skill Catalog，没有通用 Skill Installer；Catalog 只校验随应用发布的固定本地 Runtime Skill，两者均不得进入产品请求路径。
- 新增固定 SHA-256 的 Runtime Skill 时，同步在 `.gitattributes` 锁定其 `SKILL.md` 为 LF，避免 Windows checkout 改写已校验字节。
- 新增图片风格时，为每个稳定风格建立精确版本的 Process Registration，并复用受控图片生成与存储 Capability；产品请求不能选择 Skill、模型或供应商。

## Git 远端与同步

- `git@github.com:hkai-ai/pipipi.git` 是协作主仓库，保留 `origin` 名称并从该仓库获取和跟踪分支。
- `git@github.com:techidsk/pipipi.git` 是个人副本，保留 `personal` 名称；不从该仓库拉取、合并或设置分支上游。
- 用户授权推送分支或 tag 时，把同一 ref 分别推送到 `origin` 和 `personal`，并确认两端指向同一 commit。

## 完成与验证

- 保留期、过期与时间窗口测试使用固定日期时，必须为读写两端显式注入同一时钟；不得依赖真实当前日期，也不得用可选链让记录缺失误判为通过。
- 新增 Business Process、接入 Runtime Skill 或改变公开行为时，同步更新测试、`README.md`、`CONTEXT.md` 和受影响的 `docs/` 页面。
- `POST /internal/eval/execute` 只用于受控内部新闻图片评测（由 `INTERNAL_EVAL_ENABLED` 挂载），须复用同一次 Process 执行，仅在响应中投影实际 Prompt、模型与非敏感图片参数，不得写入正式输出、日志或 Run Record。
- 面向产品调用方的全部业务 HTTP Interface 统一维护在 [`docs/api.md`](docs/api.md)；健康检查等运维 Interface 留在 Runbook，Process 专题文档只保留业务行为与实现说明。
- 默认运行 `npm run check`、`npm run typecheck`、`npm test` 和 `npm run build`。需要网络、凭证、费用或外部写入的 smoke 必须单独说明，不混入确定性验证。
- 新增 Process 启动变量时，同步异步环境预检的 API/Worker 允许清单与生成脚本的 `agent_keys`；新增独立执行时限时，验证完整生产目录的 Worker 构造，集成测试默认使用 Worker 按目录计算的租约。
- 文档以中文为主，遵循 [`docs/README.md`](docs/README.md) 的分类、事实来源和写作规范。

## 单服务器发布

- 镜像构建必须以非 root 身份、禁网运行完整 production catalog 的 Runtime Skill 校验（含可选 Process）；新增 Skill 时同步维护 `Dockerfile` 和 `.dockerignore`。
- 修改同步 Process 执行预算或重建网关反代时，按 [`docs/mvp-release-runbook.md`](docs/mvp-release-runbook.md) 核对网关超时余量，并保留精确 location 的鉴权与身份头。
- 标准单服务器发布入口是 `.github/workflows/production-ci-cd.yml`（构建 `pipipi:<commit>` 镜像并通过 `compose.production.yaml` 重建主 API 与内部 CRT Business API）；`develop` 是主力开发与 UAT 分支，只走 `.github/workflows/uat-ci-cd.yml` 在独立 UAT 服务器保留当前同步或异步形状（不读取生产 `REMOTE_HOST`），UAT 验证通过后再合并到 `main` 发布生产。异步部署由 `ops/update-async-release.sh` 在锁内更新六个角色，迁移变化时停流排空并自动 `pg_dump` 备份（`shared/db-backups`，留 14 份）后迁移，不做 migration down，也不得借普通发布退回同步或重置灰度阶段。
- 两个容器使用 host 网络（主 API `0.0.0.0:4300`，内部 CRT API `127.0.0.1:4400`），防火墙不得向公网开放应用端口；基础 Compose 保持 `ASYNC_PROCESS_RUNS_ENABLED=false`。
- 服务器环境变量保存在 `REMOTE_PATH/shared/.env`，不得写入日志、镜像或仓库；部署必须校验 image tag、`com.pipipi.revision`、`/healthz` 和 `/readyz`，任一失败即回滚。

## Agent skills

### Responses 联网搜索

- 需要模型原生联网搜索的 Process 使用服务端固定的 OpenAI Responses Adapter，并把 `web_search` 设为必需；关键词预算由 Registration 固定，调用方不能控制搜索 Tool 或模型。
- 只有确认响应包含已完成的搜索调用后才把检索视为成功；检索结果按不可信资料传入后续构思，且不得进入正式输出或运行日志。

### 其他工程配置

- Issue tracker：[`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- Triage labels：[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- Domain docs：[`docs/agents/domain.md`](docs/agents/domain.md)
