# 人物叙事碑式新闻封面

本文面向维护 Memene 新闻封面的产品、开发和测试人员。`news-image-narrative-monument/v1` 接收新闻标题和摘要，生成暖纸、深色人物碑、钴蓝短中文标题和旧金残环构成的 1600×1200 PNG。

## 产品契约

完整请求、响应、错误码和调用示例见 [统一 HTTP 接口](../../../api.md)。

```json
{
  "process": "news-image-narrative-monument",
  "version": "v1",
  "input": { "title": "新闻标题", "summary": "新闻摘要" }
}
```

成功输出为 `{ "style": "narrative-monument", "image": { "url", "contentType", "width", "height" } }`。调用方不能提交 Skill、Prompt、模型、供应商或存储配置。

标题长度为 1–300，摘要长度为 1–12000；服务端会清理首尾空白并合并连续空白。额外字段返回 `INVALID_INPUT`。

## 执行顺序与错误

1. 无 Tool Agent 加载固定的 `news-image-narrative-monument-prompt` 并编译 Prompt。
2. Registration 校验结构、人物碑、钴蓝标题、暖纸和旧金残环约束；无效结果返回 `AGENT_FAILURE`，且不生成图片。
3. `NewsImageRenderingCapability` 以 `runId` 为幂等键调用内部 `POST /news-images`；依赖不可用返回 `DEPENDENCY_FAILURE`。
4. 最终 PNG 保存到 `news-image/narrative-monument/` OSS 前缀，产品响应隐藏 Prompt、模型和生成参数。

## 代码与验证入口

| 责任 | 入口 |
| --- | --- |
| Registration 与风格校验 | [`src/processes/news-image/registration.ts`](../../../../src/processes/news-image/registration.ts) |
| Agent、Capability 与固定 Skill | [`src/processes/news-image/`](../../../../src/processes/news-image)、[`news-image-narrative-monument-prompt`](../../../../.pi/skills/news-image-narrative-monument-prompt/) |
| 确定性测试 | [`test/news-image-process.test.ts`](../../../../test/news-image-process.test.ts)、[`test/runtime-skills.test.ts`](../../../../test/runtime-skills.test.ts) |
| 显式真实验收 | [`test/news-image-business-acceptance.test.ts`](../../../../test/news-image-business-acceptance.test.ts)、`npm run accept:news-image-business` |

## 来源与发布门禁

来源未声明许可证，当前标记为 `NOASSERTION`。生产发布前必须确认使用和再分发权利。
