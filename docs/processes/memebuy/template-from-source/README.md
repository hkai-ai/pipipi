# 审核后编译模板

该 Business Process 消费已审核的图片生产项，上传已确认 PNG，再调用固定的 `template-from-image/v1` 编译 Gallery v2 草稿。完整 HTTP 合同见 [API 文档](../../../api.md#模板图片生产与两次审核)。

## 业务顺序

1. `template-image-plan/v1` 分析原图，按固定来源规则提出替换方案。Memebuy 停在“待审方案”，完整策略及服务端确定性编译的十二段生成指令供运营检查。
2. 运营确认策略摘要后，`template-image-render/v1` 托管原图字节并提交一次固定图片编辑，Memebuy 停在“待审图片”。此时没有上传模板 OSS。
3. 运营对照原图确认成图及审核包摘要，`template-from-source/v1` 将该 PNG 写入内容寻址对象，随后编译。草稿的封面与参考图均为审核通过的新图。
4. Memebuy 仍执行已有的模板草稿审阅和创建流程；图片审批不等于模板上架。

两次人工等待均不占用 Process 请求。授权身份由 Memebuy 已鉴权 Action 填写，浏览器不能填写 reviewerRef。第二次审批同时绑定 productionId、图片 SHA-256 和包含源图、策略、尺寸的审核包摘要。退回保留原因；重新选替换方案应建立新的生产项并重新审批，不修改已批准项。

## 原 Skill 与适配

来源固定为 `meme-template-image-producer` 提交 `a52c87668aa6cb7907306864e85ab861978b2f43`。五份业务文档完整打包，分类连续、强制替换、身份分组、资产依赖闭包、特征权限、逐区文字和媒介缺陷按原文处理。程序校验结构关系，人工负责视觉与替换效果。

Agent 无 Tool，不执行来源 Python；TypeScript Adapter 承担持久化、FAL 与 OSS。当前是逐项生产，不包含原离线工具的 5000 项分片、任务级多样性分配或编辑修订工作台，不宣称整个批量工具等价迁移。来源目录、许可证记录与逐文件摘要见 [.pi/skills/template-image-preparer/SOURCE.md](../../../../.pi/skills/template-image-preparer/SOURCE.md)。

## 持久化与恢复

内部 Business API 将源图、策略、两次批准和图片保存在挂载的数据目录 `template-productions/<productionId>/`。新方案同时保存 execution（version=v2、prompt、promptSha256），指令与源图、策略一起纳入 strategySha256；生图只读取已批准指令，不在部署后重新编译。旧方案未提交时必须重新规划和批准，旧 requestId 和成图继续原恢复路径。

生成提交前先写入未知提交状态；拿到 requestId 后只恢复同一请求。固定生成地址单次 HTTP POST，不使用 SDK 强制队列重试。明确非重试 4xx（排除 408、409、425、429）记录 provider_rejected，仅存类型及状态码；连接失联、临时状态、5xx 或无有效回执记录 submission_unknown。两者都不恢复已消费批准；未知状态必须对账，不得自动重新提交。托管最多三次，等待 5/10 秒；托管、查询、下载与轮询支持取消，取消本地等待不取消供应商任务。操作锁冲突拒绝并发；进程崩溃留下的锁按 Runbook 离线核对后恢复。

图片 SHA-256 决定固定对象 key。OSS 使用禁止覆盖写入；409 仅在现有对象的摘要、长度和类型均一致时复用。编译失败可以重新编译同一图片，不重新付费生图。上传与审批记录不能因容器更新丢失。

原图、模型指令和审核图片是受限运营数据。审核 PNG 通过有界 JSON 交接，仅在单项审核时读取；列表只投影状态。正式模板只携带已确认图片的公开引用，不携带策略、审批或内部备注。

## 验证

`test/template-image-production.test.ts` 经本地真实 HTTP 验证两次暂停、错误摘要、单次生成、重复恢复、未知提交以及超过默认输出上限的 PNG；供应商、存储和编译模型使用替身。OSS 内容寻址与完整 Worker 目录分别有独立测试。真实图片质量、线上页面和真实 OSS 公读验收需发布后单独完成。

## 方案审核内容

targetCanvas 先确定输出形态与 carrierRole、reason。普通服饰为 print_artwork/apparel，设备截图为 screen_content/device；保留完整场景必须为 mechanism 并说明玩法依据。独立画布排除 carrier/environment，frozenSet 按 scope、regionId、instruction 描述保留项。replacementComponentIds 与闭包、文字 componentId 对账；文字 originalText 为原文，exactText 为最终文案，删除为空串。

Agent 不再生成独立 promptSections。服务端从这些字段生成十二段指令，保持一次有界字段修正和 240 秒方案预算。结构检查不证明自然语言或视觉正确，不增加独立看图请求。

Memebuy 主审核区域展示输出形态、载体理由、逐区文字变化、标记动作、保留/去除范围、风险及媒介缺陷；完整场景需明确勾选确认。成图审核保留前后图与批准要求。旧记录缺失字段显示“未记录”，完整 JSON 折叠展示。

### 人工验收

- 新 T 恤方案：输出为独立印花，载体与环境列在去除范围，主副标题逐字确认后才生图。
- 成图：确认没有衣物轮廓、文字符合批准方案，批准后才上传并进入原草稿审核。
- 完整场景：有具体玩法理由、未勾选时不能批准方案；旧已成图显示缺失资料但仍可人工审核。
- 失败恢复：明确拒绝与未知提交不自动重投；已知 requestId 只恢复同一请求。

确定性回归还包括 `test/template-image-fal.test.ts`（真实 Adapter、替身 HTTP 与取消）、`test/template-strategy-contract.test.ts`（画布、文字、组件与机制冻结）和 `test/template-strategy-correction.test.ts`（一次修正与安全诊断）。Linux 运维脚本测试需要 Bash、jq、OpenSSL；文件不可读用例以非 root 用户运行。
