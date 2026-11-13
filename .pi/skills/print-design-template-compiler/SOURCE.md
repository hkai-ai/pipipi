# 来源与运行适配

来源为同组织仓库 `hkai-ai/memebuy_monorepo` 的 Memebuy 应用。准确修订与逐文件 SHA-256 在 `source-manifest.json`；运行规则完整嵌入 `SKILL.md`，纯 schema/检查器由 `tools/build-template-v4-contract.ts` 固定生成。无第三方图像或执行脚本进入快照。

审查范围包括 `print-same-style` 的入口及方法正本、作者合同、纯 schema 与检查器；原开发 Skill 的模型命令、文件写入、网络、凭证、导入和报告脚本不进入生产 Agent。只安装声明性规则，禁止 Tool、Shell、文件和网络访问；受控图片由宿主提供。格式与非空码点取值的适配不改变检查规则。

模型正常两次调用：看图拆解后独立看图复核；结构不可读最多补一次，复核只提供现有字段补丁。宿主校验和 Memebuy 作者校验均保留；通过结构检查不证明视觉或实际印刷质量。候选观察不进入公开模板、日志或 Run Record。bbox 仍须人工叠图核对；缺少的像素统计保持未知。

回退新请求可恢复 Process v2。v1/v2 的旧 Skill、Schema 和恢复路径不改；已保存 V4 模板仍需支持 V4 的消费者。更新来源时先审查、更新 manifest，再重建快照和固定摘要；`--check` 逐文件核验，不按请求下载来源。
