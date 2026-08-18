# 异步 Process Run 实施记录

状态：实现完成。Issue #10–#23 已交付代码、测试、文档和受控发布门禁；异步 Interface 仍默认关闭，实际发布必须按 [异步发布手册](../async-process-runs-runbook.md) 单独授权。

追踪规格：[GitHub Issue #9](https://github.com/techidsk/pipipi/issues/9)。当前 Interface 和可靠性规则以 [异步 Process Run 设计](../async-process-runs-design.md) 为准。

## 已交付里程碑

| 里程碑 | 结果 |
| --- | --- |
| Runtime Seam | Registration 分离 `accept` 与 `run`，同步 `/execute` 保持兼容 |
| 内存纵切 | 固定异步状态机、owner 隔离和 caller-scoped idempotency |
| PostgreSQL 与 HTTP | 持久化 Run、事务 Outbox、提交与 owner 查询 |
| BullMQ Worker | 最小 Job、独立角色、租约接管、受控重试和 Queue Recovery |
| Webhook Delivery | 独立 Queue、签名、重试、审计、重放和 SSRF 防护 |
| 生产硬化 | retention、容量门禁、运维快照、故障演练和 staged release |

## 保留结论

- PostgreSQL 是 Run、Attempt、Event、Outbox 和 Webhook Delivery 的权威存储。
- Process Queue 和 Webhook Queue 相互隔离；Redis 丢失后从 PostgreSQL 受控重建。
- Queue 只承诺至少一次投递，下游副作用以稳定 `runId` 幂等。
- 调用方只学习提交、查询和可选 Webhook，不接触 BullMQ、Redis、Attempt 或运行配置。
- 同步 `/execute`、准确 production catalog、Skill 安全边界和公开错误保持兼容。

详细实施顺序和中间状态由 Git 与 Issue 保存。本页只保留完成状态和仍影响当前维护的结论。
