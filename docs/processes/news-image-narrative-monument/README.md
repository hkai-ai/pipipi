# 人物叙事碑式新闻封面

`news-image-narrative-monument/v1` 接收新闻标题和摘要，生成暖纸、深色人物碑、钴蓝短中文标题和旧金残环构成的 1600×1200 PNG。

完整请求、响应、错误码和调用示例见 [新闻图片接口](../news-image-api.md)。

```json
{
  "process": "news-image-narrative-monument",
  "version": "v1",
  "input": { "title": "新闻标题", "summary": "新闻摘要" }
}
```

成功输出为 `{ "style": "narrative-monument", "image": { "url", "contentType", "width", "height" } }`。调用方不能提交 Skill、Prompt、模型、供应商或存储配置。

服务端固定加载 `news-image-narrative-monument-prompt`。Agent 只编译 Prompt 且没有 Tool；Registration 校验后调用内部 `POST /news-images` Capability，图片保存到 `news-image/narrative-monument/` OSS 前缀。

来源未声明许可证，当前标记为 `NOASSERTION`。生产发布前必须确认使用和再分发权利。
