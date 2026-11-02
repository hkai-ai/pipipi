# Pi Runtime 升级评估

本文面向维护本项目 Pi Adapter 的开发者，核对生产依赖的可升级版本、迁移点和验证范围。查证日期：2026-10-31。

## 结论

项目已将 Pi 依赖从 `^0.84.1` 升级并固定为 `@earendil-works/pi-coding-agent@1.4.0`。查证时 npm 官方 `latest` 为 `1.4.0`，官方 Changelog 标注发布日期为 `2026-10-21`，Node 要求为 `>=22.19.0`，本项目 `>=24` 满足要求。原声明不会自动跨到 `1.4.0`；本次已同步修改声明和锁文件。[npm metadata](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest)、[版本记录](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md)

升级前先在临时副本验证兼容性，再在主工作区关闭三处缓存预热、隔离共享 Session 配置并适配 Tool 测试上下文。当前配置边界以 [项目级 Agent 与 Skill](../integrating-runtime-skills.md#项目级-agent-与-skill) 为准。未调用真实模型、付费图片生成或生产服务。

## 与本项目有关的变化

| 变化 | 本项目影响与处理 |
| --- | --- |
| `0.86.0` 将 provider 的流输入改为 `TranscriptContext`，Tool 参数和结果 details 收紧为 JSON 值 | 项目通过 `ModelRuntime` 和 SDK 使用内置协议，没有自定义底层 stream；当前生产源码通过新版构建类型检查。 |
| `0.87.0` 以 `SessionManager` 为模型上下文权威来源 | 项目创建请求级内存 Session，通过 `session.prompt()` 输入，通过 `session.messages` 读取；未依赖写入 `agent.state.messages`，无需迁移该行为。 |
| 新版 Tool execute context 增加 `tools` 和 `executeTool` | 原 `fakeExtensionContext()` 声明旧 `ExtensionContext`，六处调用报类型错误；现已适配 `ExtensionToolContext` 并显式拒绝 fixture 的嵌套 Tool 执行。 |
| `1.0.3` 把 Azure provider 更名为 `azure` | 本次扫描的业务 Adapter 未固定旧 Azure provider；若部署使用该配置，需单独迁移。 |
| `1.3.0` 固定 Pi 内部包的准确版本 | `1.4.0` 的 pi-ai、pi-agent-core、pi-mcp、pi-codemode、pi-tui 均固定为 `1.4.0`，降低内部版本混用风险；仍需提交项目锁文件。 |

这些变更来自官方 [coding-agent Changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md)、[pi-ai Changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/CHANGELOG.md)、[Tool context 定义](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/extensions/types.ts) 和 [npm 依赖 metadata](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/1.4.0)。表中项目影响是静态扫描与临时验证的结论，不代表真实供应商网关已通过验收。

新版还修复了 OpenAI 兼容协议的空白 Tool 输出、畸形 Tool 参数、部分上游失败重试以及截断响应后的上下文恢复。对本项目的主要价值是 SDK 与模型协议维护；CLI 界面、MCP、codemode 和内置图片生成不应自动进入本项目生产能力。[官方版本记录](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md)

## 必须固定的 Session 策略

`1.4.0` 的 `cacheWarming` 默认值是 `streaming`，SDK 会装配 CacheWarmer；它可能在长 Tool 运行期间增加模型请求。不能把它视为纯性能开关或默认关闭。`SettingsManager.inMemory()` 只表示配置不落盘，未填写的字段仍使用默认值。[默认配置源码](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/settings-defaults.ts)、[SettingsManager 源码](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/settings-manager.ts)、[SDK 装配源码](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/sdk.ts)

本次在三处明确 `cacheWarming: "off"`，业务预算继续由服务端配置拥有：

- `src/agent-runtime/session.ts`：已采用请求级内存配置，让 ResourceLoader 与 Session 使用同一 SettingsManager，不读取本地 Pi settings。
- `src/processes/template-from-image/agent.pi.ts`：独立 `SettingsManager.inMemory` 继续关闭 retry/provider retry 与 compaction，已在这一覆盖层关闭预热。
- `src/processes/character-emoji/agent.pi.ts`：已有独立内存配置及调用预算；已关闭预热，不能只依赖 `setAutoRetryEnabled(false)` 与 `setAutoCompactionEnabled(false)`。

继续验证无 Tool Session 的空 allow-list、带 Tool Session 的准确白名单和 Runtime Skill 摘要。新版 SDK 支持更多 Tool 来源，升级不构成开放 MCP、codemode、Shell 或其他内置 Tool 的授权。

## 新增业务 Adapter 的兼容性

模板编译使用的 `session.agent.onPayload` 仍可修改 Responses 的 `text.format` 或 Chat Completions 的 `response_format`。角色表情包依赖的 `textSignature` 仍采用 `{v:1,id,phase}`，保留 `commentary` 与 `final_answer`，当前按最终正文筛选的逻辑不需要因版本变化重写。[Agent 属性定义](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/src/agent.ts)、[Responses 签名实现](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/api/openai-responses-shared.ts)

角色表情包会移除缓存字段与 `max_output_tokens`、动态清空 Tool 并自行设置 reasoning 和 JSON 输出。临时测试验证了这些 Adapter 路径，但未验证实际 DeepSeek 网关对新版序列化载荷的接受情况。

## 升级前的临时验证结果

临时副本来自合入 `origin/main` 后的工作区，只把 Pi 直接依赖改为 `1.4.0`；依赖安装使用 `--ignore-scripts`，没有执行第三方安装脚本。

| 检查 | 结果 |
| --- | --- |
| 原样 `npm run typecheck` | 六个错误，全部来自 `test/agent-runtime.test.ts` 的旧 Tool context fixture。 |
| 仅在临时副本把 fixture 类型改为 `ExtensionToolContext` 后重跑 `npm run typecheck` | 通过，包括服务端与 console。这个临时改动仅验证类型迁移，正式实现应提供符合用途的测试 context。 |
| `npx tsc -p tsconfig.build.json` | 原生产代码通过，无需修改生产 TypeScript 才能编译。 |
| 六个 Pi 相关测试文件 | 113 个测试全部通过。 |

六个文件为 `agent-runtime.test.ts`、`runtime-skills.test.ts`、`character-emoji-agent.test.ts`、`template-agent.test.ts`、`agent-conversations-image-http.test.ts` 和 `photo-poster-agent.test.ts`。初次临时运行缺少 Dockerfile 与 Development Skill 来源文件，补齐副本后上述测试全部通过。

这些临时结果用于确认迁移范围；主工作区的验证结果见下节。真实模型与图片 smoke 需要单独明确网络、凭证、费用及外部写入范围。

## 升级后的验证结果

主工作区已通过 `npm run check`、`npm run typecheck`、`npm test` 和 `npm run build`。全量测试为 138 个文件通过、10 个文件跳过，1482 个用例通过、90 个用例按配置跳过。

新增真实 SDK 离线测试：在包含缓存预热、图片屏蔽和 Coding Tool 配置的临时 Pi 目录下，分别创建无 Tool 与只允许 `echo` 的 Session，确认本地设置不生效、预热关闭、活动和可嵌套调用的 Tool 集合均符合白名单，并确认会话未落盘。模板编译与角色表情包测试也检查其专属 SettingsManager 关闭预热。除 Pi 及其传递依赖外，已有直接依赖的安装版本保持不变。

未执行真实模型网关、PostgreSQL/Redis 或付费图片 smoke；确定性验证通过不代表生产网关已经完成验收。本次升级尚未部署。
