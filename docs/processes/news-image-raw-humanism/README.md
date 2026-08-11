# 原质人文主义新闻图片

`news-image-raw-humanism/v1` 接收新闻标题和摘要，生成固定原质人文主义风格的 1600×1200 PNG。

完整请求、响应、错误码和调用示例见 [新闻图片接口](../news-image-api.md)。

```json
{
  "process": "news-image-raw-humanism",
  "version": "v1",
  "input": {
    "title": "新闻标题",
    "summary": "新闻摘要"
  }
}
```

成功输出为 `{ "style": "raw-humanism", "image": { "url", "contentType", "width", "height" } }`。调用方不能提交 Skill、Prompt、模型、供应商、画幅或存储配置。

服务端固定加载 `news-image-raw-humanism-prompt`。Agent 只编译 Prompt 且没有 Tool；Registration 校验纯色背景、黑色手线、暖白实体和留白约束后，调用现有内部 `POST /news-images` Capability。图片保存到独立的 `news-image/raw-humanism/` OSS 前缀。

来源是维护者提供的本地 Skill 目录，未声明许可证，当前标记为 `NOASSERTION`。生产发布前必须确认使用和再分发权利。
