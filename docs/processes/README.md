# Business Process 文档目录

本目录面向产品、开发和测试人员。每个进入 production catalog 的 Business Process 都使用与 Process ID 相同的独立目录；目录内文档集中说明该 Process 的版本化契约、执行顺序、依赖、错误、验证入口和当前边界。

## 当前目录

| Process Registration | 独立文档 | 主要能力 |
| --- | --- | --- |
| `content-processing/v1` | [`content-processing/`](content-processing/) | 规范化并处理文本，可由服务端选择 Direct 或受限 Agent 路径 |
| `titled-content-processing/v1` | [`titled-content-processing/`](titled-content-processing/) | 组合标题与正文并复用文本处理能力 |
| `minimal-zine-poster/v1` | [`minimal-zine-poster/`](minimal-zine-poster/) | 编译固定海报风格 Prompt，并生成和持久化图片 |
| `crt-interface-image/v1` | [`crt-interface-image/`](crt-interface-image/) | 用已上传参考图生成 CRT 界面风格 PNG，并提供同类图片流程开发模板 |

production catalog 的准确清单由 [`src/processes/catalog.ts`](../../src/processes/catalog.ts) 和 [`src/app/business-processes.ts`](../../src/app/business-processes.ts) 决定。若本文与运行行为冲突，以 `src/` 和 `test/` 为准，并在同一改动中修正文档。

## 目录约定

目录名必须等于稳定的 Process ID，不包含版本号：

```text
docs/processes/
└── <process-id>/
    ├── README.md
    └── <process-specific-topic>.md
```

`README.md` 是该 Process 的稳定入口。只有一个已注册版本时，入口直接记录该版本；多个版本需要长期并存或契约差异较大时，在同一目录增加 `v1.md`、`v2.md` 等版本页，并由 `README.md` 路由。不要为版本创建另一个平级 Process 目录。

开发模板、证据保留、迁移或其他仅属于该 Process 的专题也放在同一目录，并从 `README.md` 链接。不要把这些专题平铺到 `docs/` 根目录。

Process 目录只保存该 Process 独有的知识。跨 Process 的 Runtime、异步执行、Skill 接入、实验和发布规则继续由 [`docs/README.md`](../README.md) 列出的仓库级文档负责。

## 新增或修改 Process

新增 Process 时，按 [`authoring-business-processes.md`](../authoring-business-processes.md) 完成定义与注册，并在同一改动中创建 `docs/processes/<process-id>/README.md`。至少记录：

- 准确的 Process ID、版本、输入和输出；
- 服务端拥有的执行顺序、依赖、Skill 与副作用；
- 稳定错误和不会进入产品请求或响应的实现字段；
- Registration、Capability、Adapter、Runtime Skill、确定性测试和显式真实验收入口；
- 已实现能力、发布门禁和未实现边界。

Process 行为、版本、依赖或公开错误变化时，先更新对应目录；只有影响多个 Process 时，才同时修改仓库级设计或 Runbook。
