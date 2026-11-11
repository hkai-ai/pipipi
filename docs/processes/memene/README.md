# Memene Business Process

本页路由 Memene 独有的 Business Process。Memene 当前使用三个固定新闻图片风格；每个风格拥有独立 Process ID、Runtime Skill 和存储前缀，共用受控新闻图片 Capability。

| Process | 文档 | 用途 |
| --- | --- | --- |
| `news-image-narrative-monument/v1` | [`news-image-narrative-monument/`](news-image-narrative-monument/) | 人物叙事碑式新闻封面 |
| `news-image-pale-watercolor/v1` | [`news-image-pale-watercolor/`](news-image-pale-watercolor/) | 淡彩绘本新闻图片 |
| `news-image-raw-humanism/v1` | [`news-image-raw-humanism/`](news-image-raw-humanism/) | 原质人文主义新闻图片 |

Memene 调用方只提交新闻标题、摘要和准确 Process 版本。风格不是请求参数；新增稳定风格时新增 Process Registration，并在本页登记。统一 HTTP 契约见 [`../../api.md`](../../api.md)。

三个新闻图片 Process 共用模型失败分类和脱敏活动诊断，字段校验失败保留安全路径与规则码；编译失败不调用图片服务。新增模型错误处理复用 [统一诊断](../../process-runtime-design.md#统一诊断与工具选择)，不透传模型正文。 图片渲染的已知依赖失败单独分类；公开说明不包含服务端运维建议。
