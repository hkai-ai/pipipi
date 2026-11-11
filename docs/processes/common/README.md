# 通用 Business Process

本页路由跨产品复用或契约与产品无关的 Business Process。通用表示产品可以原样采用同一准确契约；它不表示调用方可以选择 Skill、模型、供应商或运行配置。

| Process | 文档 | 用途 |
| --- | --- | --- |
| `minimal-zine-poster/v1` | [`minimal-zine-poster/`](minimal-zine-poster/) | 编译极简 Zine 海报，复用内部图片服务生成与存储 |
| `crt-interface-image/v1` | [`crt-interface-image/`](crt-interface-image/) | 根据公网参考图生成 CRT 风格 PNG |
| `composed-task/v1` | [`composed-task/`](composed-task/) | 由服务端 Planner 在预算内组合 allow-list Process 完成一个目标；默认关闭 |
| `dopamine-photo-poster/v1` | [dopamine-photo-poster/](dopamine-photo-poster/) | 多巴胺摄影插画海报 |
| `mono-color-photo-poster/v1` | [mono-color-photo-poster/](mono-color-photo-poster/) | 双色油墨图文海报，五个预设明确标题用色与版式、默认细网点，兼容旧标识 |
| `travel-abstraction-photo-poster/v1` | [travel-abstraction-photo-poster/](travel-abstraction-photo-poster/) | 摄影抽象记忆海报 |
| `crayon-photo-poster/v1` | [crayon-photo-poster/](crayon-photo-poster/) | 彩色蜡笔抽象海报 |
| `monochrome-photo-poster/v1` | [monochrome-photo-poster/](monochrome-photo-poster/) | 黑白蜡笔摄影海报 |
| `woodcut-photo-poster/v1` | [woodcut-photo-poster/](woodcut-photo-poster/) | 限色木刻摄影海报 |
| `photo-doodle-collage/v1` | [photo-doodle-collage/](photo-doodle-collage/) | 摄影剪贴与互动黑线小人海报 |
| `photo-fashion-manga/v1` | [photo-fashion-manga/](photo-fashion-manga/) | 真人照片转红蓝少色日式时装漫画，配手刻粗字，取景随原照片与版面 |
| `manga-panels/v1` | [manga-panels/](manga-panels/) | 参考图转细节三格或粗笔拼页，无文字和对话框 |
| `memory-checklist-photo-poster/v1` | [memory-checklist-photo-poster/](memory-checklist-photo-poster/) | 上半保留原片，下半 3×3 蜡笔记忆点 |
| `risograph-album/v1` | [risograph-album/](risograph-album/) | 1:1 复古唱片封面，固定两句英文 |
| `character-emoji/v2`、`character-emoji/v3` | [character-emoji/](character-emoji/) | 按固定角色参考图生成单张表情或多格漫画。v3 支持同角色的不同形象同时登场 |
| `character-emoji/v4` | [character-emoji/](character-emoji/) | 使用请求提供的角色资料与官方原图生成单图或多格漫画 |

产品采用通用 Process 时，在对应产品场景 README 中记录产品限制和采用关系，不复制 Process 契约。统一 HTTP 契约见 [`../../api.md`](../../api.md)。

十一个照片海报 Process 里，记忆清单在 1200×1600 画布的上半保留参考照片，唱片封面输出 1200×1200。其余风格输出完整 1200×1600 风格化作品，不附原图或对照布局。

照片海报、极简海报和 CRT复用统一模型错误分类，控制台按运行 ID 展示净化原因。CRT 原有两次编译预算不变，最终失败保留最后一次原因；错误契约见 [API](../../api.md)，扩展方式见 [统一诊断](../../process-runtime-design.md#统一诊断与工具选择)。 业务依赖失败显式记录，公开文案解释已知原因并保留禁止重复付费操作的约束；控制台按公开错误码展示依赖标题和原请求核对提示，每项只出现一次。

CRT 与十一个照片海报共享 [图片背景参数](../../api.md#图片背景参数)，省略时保持各自原有行为。

角色表情包支持单图与 2 至 6 格漫画，服务端先按角色和题材提供最多8张本地短卡，由一个 DeepSeek 4.1 Flash Pi Agent 选材、按需搜梗、构思并自检；DeepSeek 负责 Tool 内联网并提供最多两个候选，Agent 按用户主题选材，以 low 推理预算检查定格动作。搜索失败直接原创，未核验材料可作灵感；程序校验同次材料身份、按角色 ID 绑定参考图并生成编号，保留 Agent 的自由布局；JSON格式、可定位结构与台词错误共用一次原会话修正机会，可读取候选冻结其余字段；搜索最多30秒，搜索失败原因及阶段耗时进入无正文观测。允许少量场景辅助文字，明确无字要求优先；单图白底贴纸为默认风格。素材取舍与质量边界见[专题](character-emoji/README.md)。 构思及修正采用上游默认输出额度，不发送输出 token 上限，仍保留120秒共享截止时间。

角色表情包主用 Flare 复用已配置的 OSS 读取固定角色原图，不缩放、不压缩，按原顺序通过 multipart 文件表单上传；独立本地运行未配置 OSS 时才使用公网取图。Flare 对齐已核验的 Memebuy 请求，省略 quality 和 output_format，不继承 CRT 参数；备用 Magikaru 保持公网 URL 直传及原有质量参数。角色表情包按所选角色注入已维护的创作背景；v2 漫画由 Agent 决定自由布局和各格大小，程序仅补编号。每格仍只有一份 scene；page 与 frame 只描述画格几何，关键行动或可辨认痕迹在 scene 呈现，同次自检核对肢体占用与道具支撑；配字优先级及创作规则见[角色表情包专题](character-emoji/README.md)。

豆包支持 Q 版（`Doubao:Chibi`），调用示例见[角色表情包 API](../../api.md#角色表情包)。
