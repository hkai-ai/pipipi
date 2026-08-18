# `titled-content-processing/v1` Business Process

本文面向维护带标题文本处理能力的产品、开发和测试人员。`titled-content-processing/v1` 负责规范化标题与正文、按服务端分隔符组合内容，再复用 Content Processing Capability；它不引入独立 Agent 或第二套文本处理规则。

## 产品契约

```json
{
  "process": "titled-content-processing",
  "version": "v1",
  "input": {
    "title": "  Launch Notes  ",
    "body": "  Ready   for review.  "
  }
}
```

`input` 是严格对象；`title` 和 `body` 都必须是非空字符串。Process 分别去掉首尾空白，把连续空白折叠成一个空格，再用服务端固定分隔符组合。默认分隔符是两个换行符。

成功输出保留规范化标题，并返回 Capability 处理后的组合内容：

```json
{
  "title": "Launch Notes",
  "content": "Processed: Launch Notes\n\nReady for review."
}
```

调用方不能提交分隔符、Capability 地址、重试、模型、Skill 或其他实现配置。

## 执行顺序与边界

1. Registration 独立验证 `title` 和 `body`。
2. Process 分别规范化两个字段，再用构造时固定的 `separator` 组合。
3. Registration 以 Process `runId` 作为幂等键，只调用一次 Content Processing Capability。
4. Process 保留规范化标题，并把 Capability 的 `content` 放入输出。

该 Process 与 `content-processing/v1` 共享 Capability Interface，但拥有独立 Schema、Process Definition 和配置实例。修改一个 Registration 的配置不能改变另一个 Process。

运行活动日志用固定的 `content_processing` 标记 Capability 调用，只记录活动结果与耗时，不记录标题、正文或组合内容。

## 错误与副作用

| 阶段 | 公开错误 | 条件 |
| --- | --- | --- |
| 输入接受 | `INVALID_INPUT` | 标题或正文为空、字段类型错误或包含额外字段 |
| 业务依赖 | `DEPENDENCY_FAILURE` | Content Processing Capability 不可用或响应不符合协议 |
| 输出验证 | `INVALID_OUTPUT` | Process Definition 返回不符合输出 Schema 的结果 |
| 执行治理 | `PROCESS_TIMEOUT` | 总超时先于结果完成 |

Process 本身不持久化内容，也不调用 Agent。远程 Capability 的副作用与幂等由其服务契约负责。

## 代码与验证入口

| 目标 | 文件 |
| --- | --- |
| 产品 Schema、分隔符和执行顺序 | [`src/processes/titled-content/registration.ts`](../../../../src/processes/titled-content/registration.ts) |
| 共享 Capability Interface | [`src/processes/content/capability.ts`](../../../../src/processes/content/capability.ts) |
| 独立 Schema、配置隔离与版本测试 | [`test/execute-process.test.ts`](../../../../test/execute-process.test.ts) |

不联网的聚焦验证从仓库根目录运行：

```bash
npm test -- test/execute-process.test.ts
```
