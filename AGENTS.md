# 仓库协作规则

## 开始工作

- 修改代码前先读 `CONTEXT.md`，再从 `docs/README.md` 找到对应专题文档。
- 项目用 Business Process、Process Definition、Process Registration、Business Capability、Module、Interface、Implementation、Seam 和 Adapter 表达设计。用户口中的“工作流”在产品层映射为 Business Process；不要引入第二套 Workflow 领域模型。
- 保持 production catalog 显式、版本精确、服务端拥有。产品请求不能携带流程步骤、Skill、脚本、模型、Tool、来源地址或运行配置。
- 命名遵循 [`docs/development.md`](docs/development.md#命名规则)：使用能在当前作用域区分角色的最短名称，不重复目录上下文，也不使用自造缩写。

## 请求路由

- 用户用自然语言描述一段业务流程，并要求实现、封装或接入时，使用 `$author-business-process`。简短描述是有效输入；先从仓库事实推断安全默认值，只在公开契约、副作用或权限无法安全确定时提问。
- 用户给出 Skill 的本地路径、Git 仓库、仓库内子目录或网页地址，并要求使用、安装或接入时，使用 `$integrate-runtime-skill`。
- 同一请求同时包含流程描述和 Skill 来源时，先用 `$integrate-runtime-skill` 解析并审查来源，再用 `$author-business-process` 把已固定的 Runtime Skill 绑定到明确的 Process Registration。

## Skill 边界

- `.agents/skills/` 保存 Codex 在开发仓库时使用的 Development Skill；`.pi/skills/` 保存服务端受限 Agent 使用的 Runtime Skill。两者的调用方、权限和发布路径不同，不能只靠复制目录就互换角色。
- 本地路径或远程 URL 只作为开发、安装或构建期的 Skill Source。共享或生产使用前必须检查完整目录、来源、许可证、脚本、Tool 与网络权限，固定不可变版本并保存本地快照或可复现安装记录。
- 生产请求路径只读取随应用发布、由服务端选择的本地 Runtime Skill。禁止按请求下载、更新或执行任意远程 Skill。
- 当前没有通用 Skill Installer。生产确实需要多个来源类型时，可在开发工具链增加 Skill Installer 和只读 Installed Skill Catalog；它们不得进入产品请求路径。

## Git 远端与同步

- `git@github.com:techidsk/pipipi.git` 是主仓库。保留其 `origin` 名称，并从该仓库获取和跟踪分支。
- `git@github.com:hkai-ai/pipipi.git` 是同步副本。用户授权推送分支或 tag 时，把同一 ref 推送到两个仓库，并确认两端指向同一 commit。
- 本地可以为 `origin` 配置两个 push URL；若缺少该配置，则分别推送。不要从同步副本拉取、合并或设置分支上游。

## 完成与验证

- 新增 Business Process、接入 Runtime Skill 或改变公开行为时，同步更新测试、`README.md`、`CONTEXT.md` 和受影响的 `docs/` 页面。
- 默认运行 `npm run check`、`npm run typecheck`、`npm test` 和 `npm run build`。需要网络、凭证、费用或外部写入的 smoke 必须单独说明，不把它混入确定性验证。
- 文档以中文为主，遵循 `docs/README.md` 的分类、事实来源和写作规范。

## CRT 图片输入

- `crt-interface-image/v1` 接收公网 HTTPS `sourceImageUrl`。服务端不下载参考图；FAL Adapter 将 URL 原样放入 `image_urls`。完整 URL 不得进入日志或证据，只保存摘要。
- CRT 最终 PNG 可由服务端配置保存到阿里云 OSS；FAL、模型、OSS 凭证、bucket 和对象前缀不得进入产品请求。

## 单服务器发布

- 标准单服务器发布入口是 `.github/workflows/production-ci-cd.yml`。CI 构建发布包，生产 Job 通过 SSH 把版本部署到 `REMOTE_PATH/releases/<commit>`，再用 PM2 切换 `current`。
- 同步 API 的生产端口固定为 `4300`，只向本机反向代理开放。基础流水线保持 `ASYNC_PROCESS_RUNS_ENABLED=false`；异步角色必须按独立 Runbook 发布。
- 服务器环境变量保存在 `REMOTE_PATH/shared/.env`，不得写入 GitHub Actions 日志、发布包或仓库。部署后必须同时通过 `/healthz` 与 `/readyz`，失败时切回上一 release。

## Agent skills

### Issue tracker

项目规格与工作项使用 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

项目使用五个默认 triage 角色标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

项目使用 single-context 领域文档布局：根目录 `CONTEXT.md` 与 `docs/decisions/`。详见 `docs/agents/domain.md`。
