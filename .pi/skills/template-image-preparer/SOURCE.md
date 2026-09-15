# 来源与适配

来源为 meme-template-production/skills/meme-template-image-producer，固定提交 a52c87668aa6cb7907306864e85ab861978b2f43；完整目录摘要见 source-manifest.json。未找到许可证，记录为 NOASSERTION。

用户选择强制替换并保留两次人工确认。五份原业务文档完整打包进 SKILL.md；开发期 tools/build-template-image-skill.ts 核验来源后重建，生产无外部路径依赖。Agent 无 Tool，只生成受约束的替换策略；服务端执行分类、组件、分组、文字权限校验并确定性编译十二段提示词。

与原操作环境的差异：审批从 Codex 对话迁至 Memebuy 页面；Python 实现适配为 TypeScript；当前入口是独立单图任务，不提供原 5000 项任务分片或任务级多样性分配。Runtime v2 由结构化字段生成十二段指令，移除 Agent 自由 promptSections；冻结项区分设计、载体和环境，逐区文字记录原文与成图文字；risks 映射为字符串数组；摘要、审批、revision 和上传事实由服务端持有。并非把整个 Python 批量工具安装到生产 Agent。

固定 FAL openai/gpt-image-2/edit、low、单图 PNG、五种尺寸；真实源图字节在策略审批后托管到 FAL，生成 POST 不自动重投。供应商请求未知必须人工对账；已知 requestId 只恢复同一请求。策略和成图分别绑定摘要与审核者。第二次通过后上传原 PNG 至内容寻址的 assets.memebuy.cn/gallery/template-images/，再调用原 JSON Compiler。审核中不向模板 OSS 目录上传图片。

原文与来源摘要保持不变；v2 是服务端字段及执行适配版本。规则检查与人工判断共同完成审核，不新增独立视觉复核。精确指令及其摘要在规划时持久化并绑定批准，执行不重新编译。
