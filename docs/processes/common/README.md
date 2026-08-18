# 通用 Business Process

本页路由跨产品复用或契约与产品无关的 Business Process。通用表示产品可以原样采用同一准确契约；它不表示调用方可以选择 Skill、模型、供应商或运行配置。

| Process | 文档 | 用途 |
| --- | --- | --- |
| `content-processing/v1` | [`content-processing/`](content-processing/) | 处理一段业务文本 |
| `titled-content-processing/v1` | [`titled-content-processing/`](titled-content-processing/) | 组合标题与正文并复用文本处理能力 |
| `minimal-zine-poster/v1` | [`minimal-zine-poster/`](minimal-zine-poster/) | 编译、生成并持久化极简 Zine 海报 |
| `crt-interface-image/v1` | [`crt-interface-image/`](crt-interface-image/) | 根据公网参考图生成 CRT 风格 PNG |

产品采用通用 Process 时，在对应产品场景 README 中记录产品限制和采用关系，不复制 Process 契约。统一 HTTP 契约见 [`../../api.md`](../../api.md)。
