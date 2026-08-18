# 淡彩绘本新闻图片

本文面向维护 Memene 新闻图片的产品、开发和测试人员。`news-image-pale-watercolor/v1` 把新闻标题和摘要转换为淡彩绘本风格的 4:3 新闻插画。它已经进入 production catalog，并与其他流程共用 `POST /execute`。

## 产品契约

完整请求、响应、错误码和调用示例见 [统一 HTTP 接口](../../../api.md)。

```json
{
  "process": "news-image-pale-watercolor",
  "version": "v1",
  "input": {
    "title": "某城市开始使用无人机巡检老旧桥梁",
    "summary": "首批巡检覆盖多座老旧桥梁，并发现12处需要进一步检查的安全隐患。"
  }
}
```

成功结果只公开固定风格名和持久化图片：

```json
{
  "style": "pale-watercolor",
  "image": {
    "url": "https://assets.example.com/news-image/pale-watercolor/<runId>.png",
    "contentType": "image/png",
    "width": 1600,
    "height": 1200
  }
}
```

请求不接收 Prompt、Skill、模型、供应商、画幅或存储配置。标题长度为 1–300，摘要长度为 1–12000，额外字段会被拒绝。

## 执行顺序与错误

1. `PiNewsImageAgent` 只加载固定的 `news-image-pale-watercolor-prompt`，把标题和摘要编译成结构化 Prompt。
2. Registration 校验事实排除项、Prompt 段落顺序、4:3 构图和淡彩绘本核心约束。
3. `NewsImageRenderingCapability` 以 `runId` 为幂等键调用内部 `POST /news-images`。
4. 内部图片 Business API 使用 FAL GPT Image 2 生成图片，确定性转换为 1600×1200 PNG，并写入 OSS 的 `news-image/pale-watercolor/` 前缀。

Agent 没有 Tool、文件、Shell 或网络权限。Prompt、新闻正文和供应商配置不会出现在产品响应中。

Agent 输出或风格约束无效时返回 `AGENT_FAILURE`，且不调用图片 Capability；图片依赖不可用时返回 `DEPENDENCY_FAILURE`。其他稳定 HTTP 错误统一由 [业务接口文档](../../../api.md) 定义。

## 代码与验证入口

| 责任 | 入口 |
| --- | --- |
| Registration 与风格校验 | [`src/processes/news-image/registration.ts`](../../../../src/processes/news-image/registration.ts) |
| Agent、Capability 与固定 Skill | [`src/processes/news-image/`](../../../../src/processes/news-image)、[`news-image-pale-watercolor-prompt`](../../../../.pi/skills/news-image-pale-watercolor-prompt/) |
| 确定性测试 | [`test/news-image-process.test.ts`](../../../../test/news-image-process.test.ts)、[`test/runtime-skills.test.ts`](../../../../test/runtime-skills.test.ts) |
| 显式真实验收 | [`test/news-image-business-acceptance.test.ts`](../../../../test/news-image-business-acceptance.test.ts)、`npm run accept:news-image-business` |

## 来源与发布门禁

Runtime Skill 是维护者提供的 Style 07 来源的受限适配；准确哈希、权限审查和适配差异记录在 [SOURCE.md](../../../../.pi/skills/news-image-pale-watercolor-prompt/SOURCE.md)。来源未提供许可证，因此当前标记为 `NOASSERTION`。真实生产发布前必须确认生产使用和再分发权利。
