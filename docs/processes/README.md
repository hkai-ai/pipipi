# Business Process 场景目录

本目录先按产品场景路由，再进入具体 Business Process。产品归属只组织开发知识，不改变 Process ID、版本、HTTP Interface 或 production catalog。

## 场景入口

| 场景 | 何时读取 | 当前 Process |
| --- | --- | --- |
| [`memene/`](memene/) | 修改 Memene 的新闻图片能力 | 3 个新闻图片 Process |
| [`memebuy/`](memebuy/) | 修改 Memebuy 独有的业务能力 | 暂无已登记 Process |
| [`common/`](common/) | 修改跨产品复用或契约与产品无关的能力 | 文本处理、海报、CRT 图片和组合任务 Process |

先确定调用产品。一个 Process 只放在一个场景目录中；多个产品调用同一准确版本时，把文档放入 `common/`，各产品场景只记录采用关系和产品限制。

全部业务请求、响应和错误统一维护在 [`../api.md`](../api.md)。production catalog 的准确清单由 [`src/processes/catalog.ts`](../../src/processes/catalog.ts) 和 [`src/app/business-processes.ts`](../../src/app/business-processes.ts) 决定。

## 目录约定

```text
docs/processes/
├── memene/
│   ├── README.md
│   └── <process-id>/
├── memebuy/
│   ├── README.md
│   └── <process-id>/
└── common/
    ├── README.md
    └── <process-id>/
```

产品名使用稳定的小写名称。Process 目录名等于稳定 Process ID，不包含版本号。`README.md` 是场景或 Process 的入口；一个 Process 有多个长期并存版本时，在同一 Process 目录增加 `v1.md`、`v2.md` 等版本页。

Process 专属的开发模板、证据保留和迁移说明与 Process README 放在一起。跨产品 Runtime、异步执行、Skill 接入、实验和发布规则继续由 [`docs/README.md`](../README.md) 路由。

## 新增或修改 Process

1. 从产品调用方确认场景。服务单一产品时选择对应产品目录；契约可被多个产品原样复用时选择 `common/`。
2. 按 [`authoring-business-processes.md`](../authoring-business-processes.md) 完成定义与注册。
3. 创建 `docs/processes/<scenario>/<process-id>/README.md`，并从场景 README 注册入口。
4. 验证 production catalog、统一 API 文档和场景目录表达同一组准确版本。

每个 Process README 至少记录准确契约、执行顺序、依赖与副作用、稳定错误、代码和测试入口、真实验收、发布门禁及未实现边界。场景归属变化只移动文档并更新路由；公开契约变化仍按版本规则处理。
