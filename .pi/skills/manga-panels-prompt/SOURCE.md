# 来源与适配记录

- 上游：[RemiPelloux/agent-mangaka-forge](https://github.com/RemiPelloux/agent-mangaka-forge)，Skill 路径 `skills/generatemangapage/`。
- 固定 commit：`1168ba358e539a94a3a1743ecbf98dbdf9720d65`；审查日期：2026-10-07。MIT，保留同目录 LICENSE 与原作者署名。
- 本地身份：`manga-panels-prompt@v1`，绑定 `manga-panels/v1`；正文完整性以 `src/processes/photo-poster/skills.ts` 的 SHA-256 校验，LF 固定。

## 来源审查

完整目录含 SKILL.md、三个 references 文档、agents/openai.yaml 与 scripts/manage_img_memory.py，无其他资产或 MCP 声明。已阅读全部文件；脚本会按调用参数创建目录、复制图片、读写 manifest 与 page JSON，没有网络、凭证读取或子进程执行，但路径写入范围不符合受限 Runtime，因此不安装、不运行脚本。agents/openai.yaml 仅声明开发宿主的名称和调用提示，不安装。

以下为固定 ref 中采用的原始业务资料摘要，可从上述 commit 的相同路径重现；不是运行时下载清单。

| 上游路径（相对仓库） | SHA-256 |
| --- | --- |
| `LICENSE` | `53225b916a365327c239d3667ddbfb67f4d0e6b327692f139668ce191dc7195f` |
| `skills/generatemangapage/SKILL.md` | `5649844c2f45ac456ab9b8b802fefa563400ff39d5663e108331902a043c4c45` |
| `skills/generatemangapage/references/modes.md` | `7c9f59e7df6a9b4f18f71d99c61f1f2b2dbd63066e87479a8a2a803c3b15048f` |
| `skills/generatemangapage/references/prompt-rules.md` | `baea3810b24f6eda51dab29ab547b30d0291b4cf18b81df29c0f22861736940d` |
| `skills/generatemangapage/references/img-memory-contract.md` | `049aefd8bdcf88c383305f740dacfef81c60a2fb2c74efcff54a31f1a1b88285` |

## 兼容性取舍

这是经用户选定 C、D 效果后的受限适配版，不是完整上游的等价安装。采用人物一致性、明确阅读顺序、画格层级、细节取景、黑白墨线及无文字原则。固定为细节三格与粗笔拼页两个业务预设，规则由 `manga-panels.ts` 解析后同时交给编译 Agent 和图片模型。

上游跨页 img-memory、设定图生成、多参考图、角色进化与变体、文件读写、自动重绘均不支持。唯一参考图 URL 直接交给受控图片 Adapter；无 Tool 文本 Agent 只编译抽象规则，不看图或猜角色。Runtime 所需规则完整写入 SKILL.md，不读取 SOURCE.md、LICENSE 或外部参考文件。

原 C、D 临时生图未经过正式文本 Agent，且有字母残留及裁切问题；不视作本接入版本的完整验收。调用可能产生一次图片费用与存储写入，技术成功不代表视觉通过。更新须重新审查来源与固定摘要；首版无已发布前身，回滚恢复上一应用制品。不为删除的未发布单色漫画保留兼容别名。
