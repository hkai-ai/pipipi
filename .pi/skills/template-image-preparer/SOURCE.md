# 来源与适配

来源为 meme-template-production/skills/meme-template-image-producer，固定提交 a52c87668aa6cb7907306864e85ab861978b2f43；完整目录摘要见 source-manifest.json。未找到许可证，记录为 NOASSERTION。

用户选择强制替换并保留两次人工确认。原入口与五份业务引用全文完整打包进 SKILL.md；开发期 tools/build-template-image-skill.ts 核验来源后重建，生产无外部路径依赖。Agent 无 Tool，只生成受约束的替换策略；服务端执行分类、组件、分组、文字权限校验并确定性编译十二段提示词。

与原操作环境的差异：审批从 Codex 对话迁至 Memebuy 页面；Python 实现适配为 TypeScript；当前入口是独立单图任务，不提供原 5000 项任务分片或任务级多样性分配。Runtime Skill v3 由结构化字段生成十二段简洁执行指令，移除 Agent 自由 promptSections；冻结项区分设计、载体和环境，逐区文字记录原文与成图文字；risks 映射为字符串数组；摘要、审批、revision 和上传事实由服务端持有。并非把整个 Python 批量工具安装到生产 Agent。

固定 FAL openai/gpt-image-2/edit、low、单图 PNG、五种尺寸；真实源图字节在策略审批后托管到 FAL，生成 POST 不自动重投。供应商请求未知必须人工对账；已知 requestId 只恢复同一请求。策略和成图分别绑定摘要与审核者。第二次通过后上传原 PNG 至内容寻址的 assets.memebuy.cn/gallery/template-images/，再调用原 JSON Compiler。审核中不向模板 OSS 目录上传图片。

来源固定提交与原文摘要不变；Runtime Skill 更新为 v3，公开字段及落盘 execution 合同继续为 v2。规则检查与人工判断共同完成审核，不新增独立视觉复核。精确指令及其摘要在规划时持久化并绑定批准，执行不重新编译。

2026-09-15 适配核对：保持完整来源快照；在 Pi 请求 Schema 中说明原文的观察、排版、冻结与媒介语义，字段修正同时提供目标字段 Schema。确定性指令将这些字段表述为执行要求，残留清理遵循原文的特征权限，不把重绘范围扩大为设计修改权限。逐项映射与视觉验证边界见 docs/processes/memebuy/template-from-source/README.md 的“来源适配核对”；不以来源摘要一致宣称视觉效果等价。

模型同次请求接收原图与最多五张固定区域局部图，先逐区记录原文和六项排版观察，再决定替换与组件权限；服务端把观察原样投影到现有 layout 字符串，总览仍决定主体数量与布局，局部图不保存为生产源图；持久化 Schema 顺序保持稳定，以兼容旧审批摘要。排版字段展开可观察几何而不预设具体造型。指令以简洁语句投影实际要求，省去研究记录、授权布尔值及重复校验结构；旧批准仍读取原落盘指令。
