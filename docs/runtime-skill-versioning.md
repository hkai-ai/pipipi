# Runtime Skill 的版本管理

本文供维护团队 Skill 和 Pipipi 的开发者使用。团队在独立仓库修改、发布 Skill，Pipipi 为每个使用它的 Process 选择版本。发布新版只让它可供选择；Pipipi 同步快照并完成部署后，新版才在线上生效。

全部生产 Runtime Skill（含可选流程）均从团队私仓同步。完整名称、所选版本、来源提交和快照摘要见[生产版本清单](../src/agent-runtime/skill-lock.json)。共享同一 Skill 的 Process 随绑定一起升级，例如双色油墨的 v1 和 v2。Codex 使用的 Development Skill 仍按原方式维护。

手写 Skill 直接编辑团队仓库的 `skills/<name>/`；生成型 Skill 在该仓库修改规则或运行生成器，验证后发布。详情见[团队仓库维护说明](https://github.com/hkai-ai/skills#readme)。Pipipi 负责执行接口、模型、工具权限、业务校验器和宿主侧提示词。原来源许可和使用范围继续适用。

## 在哪里改，在哪里选

| 要做的事 | 位置 | 规则 |
| --- | --- | --- |
| 修改团队维护的 Skill | [团队 Skills 仓库](https://github.com/hkai-ai/skills) 的 `skills/<name>/` | 这里保存可编辑的正本。从第三方引入时，在 `SOURCE.md` 保留原始来源、修订或内容摘要、许可及本地适配说明。团队可以基于同一上游修订发布多个内部版本。 |
| 发布一个可供采用的版本 | 同一仓库的 Git 标签 | 使用 `<name>/<version>`，例如 `minimal-zine-poster-prompt/v1`。已发布标签始终指向原提交；后续修改另发新版本。每个 Skill 独立编号。 |
| 让 Process 采用某版 | Pipipi 的 Process 绑定和 `.pi/skills/` 快照 | 在开发阶段显式同步，评审后把绑定和快照作为同一次改动提交。构建、API 和 Worker 使用本地文件，生产请求只选择 Business Process 版本。 |

Process 版本和 Skill 版本独立。例如，调整海报构图规则可以只升级 Skill；如果同时改变了产品输入或输出，还要单独评审 Process 契约。

## 发布与采用

1. **在 Skills 仓库发布。** 修改正本，在评审中写清行为变化。评审完成后，在选定提交上创建并推送该 Skill 的新标签。Pipipi 继续使用原先选定的版本。
2. **在 Pipipi 同步。** 从 Pipipi 根目录执行下方命令。它需要 Git、网络和团队私仓的读取权限，并会写入本地工作区。示例选取已经发布的海报 `v1`，升级时换成目标版本。

   ```sh
   npm run skill:sync -- minimal-zine-poster-prompt v1
   ```

3. **核对并发布 Pipipi。** 查看快照和绑定记录的 Git 差异，核对变更是否符合该 Process 的预期。若文件清单或所需权限变化，先按接入规则重新审查。运行仓库检查与受影响的 Process 测试，再随 Pipipi 发布。[Skill 接入与审查](integrating-runtime-skills.md)

同步命令会记录团队仓库地址、Skill 名称和版本、标签解析到的 commit、完整目录的 Git tree，以及 `SKILL.md` 的 SHA-256。重复同步同一版本应没有差异；若本地快照已有改动，命令会停止，保留现场。以海报为例，可以直接对照[版本绑定记录](../src/agent-runtime/skill-lock.json)和[随服务发布的快照](../.pi/skills/minimal-zine-poster-prompt/)。

## 查询与回退

查某个版本**从哪里来**，看绑定记录里的 commit 和该版本的 `SOURCE.md`。查某个环境**正在用哪版**，看该环境运维控制台的 Skill 目录，或查看已部署 Pipipi 提交中的绑定记录。本地选中的版本可能还在等待部署。

只需回退 Skill 时，用同一条同步命令选回旧标签，评审并发布恢复后的快照和绑定。如果此次升级还修改了 Process 代码或输出格式，应一起验证旧 Skill 与当前代码的兼容性，必要时恢复已经验证过的应用版本。
