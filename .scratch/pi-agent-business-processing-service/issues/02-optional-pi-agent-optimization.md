# 02 — 为流程加入可选的 Pi Agent 优化

**What to build:** 在不改变产品调用接口的前提下，为第一张票中的业务流程增加一个由服务端配置控制的 Agent 优化路径。启用后，流程通过隔离的 pi-coding-agent Agent Runtime 执行一个明确的优化任务，加载一个 Skill，并把现有 Business Capability 作为受限 Tool 提供给 Agent；停用后，原有直接处理路径继续工作。

**Blocked by:** 01 — 跑通一个直接调用 API 的业务流程.

**Status:** ready-for-agent

- [ ] 服务端配置可以为目标流程启用或停用 Agent 优化，产品请求格式和输出契约保持不变。
- [ ] 启用 Agent 时，每次业务请求使用隔离的 Agent 会话，不会继承其他请求的消息或业务数据。
- [ ] Agent 能加载一个用于内容优化的 Skill，并能通过一个参数受校验的 Tool 调用已有 Business Capability，而不复制该能力的业务逻辑。
- [ ] Agent 默认无法使用 Shell、文件写入、代码编辑等与业务处理无关的 Coding Tools。
- [ ] Agent 返回结果在进入后续处理前经过结构化 Schema 校验；无效输出或执行失败会映射为稳定的业务处理错误。
- [ ] 停用 Agent 后，第一张票交付的确定性路径和测试仍然通过。
- [ ] 最高层执行测试使用确定性的 Agent Runtime Adapter，覆盖 Agent 成功、Tool 调用、输出校验失败和 Agent 执行失败。
- [ ] 提供一个不进入默认自动化测试套件的可选真实模型冒烟验证方式，避免日常测试依赖凭证、费用或非确定性模型输出。
