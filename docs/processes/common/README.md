# 通用 Business Process

本页路由跨产品复用或契约与产品无关的 Business Process。通用表示产品可以原样采用同一准确契约；它不表示调用方可以选择 Skill、模型、供应商或运行配置。

| Process | 文档 | 用途 |
| --- | --- | --- |
| `content-processing/v1` | [`content-processing/`](content-processing/) | 处理一段业务文本 |
| `titled-content-processing/v1` | [`titled-content-processing/`](titled-content-processing/) | 组合标题与正文并复用文本处理能力 |
| `minimal-zine-poster/v1` | [`minimal-zine-poster/`](minimal-zine-poster/) | 编译、生成并持久化极简 Zine 海报 |
| `crt-interface-image/v1` | [`crt-interface-image/`](crt-interface-image/) | 根据公网参考图生成 CRT 风格 PNG |
| `composed-task/v1` | [`composed-task/`](composed-task/) | 由服务端 Planner 在预算内组合 allow-list Process 完成一个目标；默认关闭 |
| `dopamine-photo-poster/v1` | [dopamine-photo-poster/](dopamine-photo-poster/) | 多巴胺摄影插画海报 |
| `mono-color-photo-poster/v1` | [mono-color-photo-poster/](mono-color-photo-poster/) | 双色油墨图文海报，五个预设明确标题用色与版式、默认细网点，兼容旧标识 |
| `travel-abstraction-photo-poster/v1` | [travel-abstraction-photo-poster/](travel-abstraction-photo-poster/) | 摄影抽象记忆海报 |
| `crayon-photo-poster/v1` | [crayon-photo-poster/](crayon-photo-poster/) | 彩色蜡笔抽象海报 |
| `monochrome-photo-poster/v1` | [monochrome-photo-poster/](monochrome-photo-poster/) | 黑白蜡笔摄影海报 |
| `woodcut-photo-poster/v1` | [woodcut-photo-poster/](woodcut-photo-poster/) | 限色木刻摄影海报 |

产品采用通用 Process 时，在对应产品场景 README 中记录产品限制和采用关系，不复制 Process 契约。统一 HTTP 契约见 [`../../api.md`](../../api.md)。

六个照片海报 Process 均输出完整 1200×1600 风格化作品，不附原图或对照布局。

CRT 与六个照片海报共享 [图片背景参数](../../api.md#图片背景参数)，省略时保持各自原有行为。
