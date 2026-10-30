/** 保存经研究筛选的本地梗短卡及来源范围，随应用发布供构思选用。 */
import type { CharacterId } from "./catalog.js";

export type MemeCard = Readonly<{
    id: string;
    name: string;
    characters: readonly CharacterId[];
    aliases: readonly string[];
    topics: readonly string[];
    summary: string;
    scope: string;
    sources: readonly string[];
}>;

// 维护依据：docs/research/model-meme-library-2026-10-20.md；来源只留在服务端。
export const memeLibraryVersion = "2026-10-21.v2";
export const memeCards: readonly MemeCard[] = [
    {
        id: "local:doubao-speaker",
        name: "悄悄问，外放答",
        characters: ["Doubao"],
        aliases: ["外放社死", "悄悄问", "小声点"],
        topics: ["语音", "外放", "尴尬", "秘密", "安静"],
        summary:
            "本想悄悄提问，豆包却热情地对着开着的扬声器回答；提问者急着按静音，音量提示仍亮着。让低声请求与大声回应同时可见。只使用虚构的日常尴尬，不编造真实隐私。",
        scope: "基于语音对话场景的原创反差，不是已核实的热梗或真实产品事故。创作日期2026-10-21。",
        sources: ["https://www.doubao.com/legal/feature_intro"],
    },
    {
        id: "local:doubao-voice-loop",
        name: "客气到挂不了电话",
        characters: ["Doubao"],
        aliases: ["挂不了电话", "晚安循环", "先挂"],
        topics: ["语音", "电话", "晚安", "礼貌", "聊天", "结束"],
        summary:
            "双方都礼貌地等对方先结束通话，晚安说了好几轮，通话计时仍在增长；豆包一边挥手告别，一边又认真等回应。只能使用已选角色，不擅自增加第二个豆包；单人时以通话界面表现另一端。",
        scope: "日常语音搭子的原创场景，不声称豆包固定如此回复。创作日期2026-10-21。",
        sources: ["https://www.doubao.com/legal/feature_intro"],
    },
    {
        id: "local:doubao-dialect",
        name: "正经解答变成唠家常",
        characters: ["Doubao"],
        aliases: ["方言搭子", "唠家常", "老乡模式"],
        topics: ["方言", "聊天", "东北话", "四川话", "粤语", "语音"],
        summary:
            "原本准备严肃讲解，切换方言后聊得太投机，问题板还空着，茶杯已经续了几轮。重点是解决问题与聊得开心的反差，不靠口音文字堆砌，也不刻板化地域人物。",
        scope: "方言语音能力背景上的原创情节，不是官方人格或固定输出。创作日期2026-10-21。",
        sources: [
            "https://play.google.com/store/apps/details?id=com.larus.nova",
        ],
    },

    {
        id: "local:deepseek-rice",
        name: "白饭与 Token",
        characters: ["DeepSeek"],
        aliases: ["白饭", "大肥鱼吃额度", "token是食物"],
        topics: ["吃饭", "饿", "额度", "资源", "消耗", "成本"],
        summary:
            "同人把 Token 消耗表现成吃饭；投入很多口粮却只得到一点成果，或少量口粮做成大事。反差在投入与产出，不只是一只饭碗。",
        scope: "跨作者二创，不是官方性格或真实消耗量。研究日期2026-10-20。",
        sources: [
            "https://www.bilibili.com/video/BV1vUHz6bETT/",
            "https://www.bilibili.com/video/BV1CipP6CE4A/",
        ],
    },
    {
        id: "local:deepseek-slacking",
        name: "助手摸鱼，用户跑测试",
        characters: ["DeepSeek"],
        aliases: ["摸鱼", "先吃饭", "测试交给用户"],
        topics: ["测试", "干活", "休息", "偷懒", "甩锅", "打工"],
        summary:
            "本该帮助用户工作的助手先休息或吃饭，把剩余工作交回用户；劳动关系倒置，也可以在用户需要时回来补救。",
        scope: "同人题材，来自作品简介与合集，不保证真实模型输出。研究日期2026-10-20。",
        sources: [
            "https://www.bilibili.com/video/BV1C7h16jEHJ/",
            "https://www.bilibili.com/video/BV1wPud6nES9/",
        ],
    },
    {
        id: "local:deepseek-disguise",
        name: "假装 Claude",
        characters: ["DeepSeek", "Claude"],
        aliases: ["假装claude", "扮演claude", "冒充claude", "身份互换"],
        topics: ["伪装", "换装", "替代", "露馅", "模仿", "身份"],
        summary:
            "角色按要求扮成另一个模型，但原来的习惯使其露馅；也有 Claude 反过来扮 DeepSeek 的二创。",
        scope: "作者二创，不是模型实测或中转商欺诈证据。研究日期2026-10-20。",
        sources: [
            "https://www.bilibili.com/video/BV1n3aw6xESG/",
            "https://www.bilibili.com/video/BV1DwHh6ZEPd/",
        ],
    },
    {
        id: "local:claude-access",
        name: "封号斗罗",
        characters: ["Claude"],
        aliases: ["封号斗罗", "封号", "封禁", "封中国人"],
        topics: ["准入", "登机", "门票", "拒绝", "许可", "进门", "账号"],
        summary:
            "用户认可能力、期待进入使用，却在入口被拦下或中途失去资格。可用准入与能力、礼貌与拒绝之间的反差。",
        scope: "社区称呼及地区准入背景；不等于按中国国籍一律封禁，也不证明某次封禁原因。",
        sources: [
            "https://linux.do/t/topic/1761389",
            "https://www.anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions",
        ],
    },
    {
        id: "local:claude-bridge",
        name: "金门大桥执念",
        characters: ["Claude"],
        aliases: ["金门大桥", "golden gate"],
        topics: ["跑题", "执念", "桥", "订单", "重复", "答非所问"],
        summary:
            "用户给出不同需求，回答总转回同一座桥；不同输入被同一执念占领。",
        scope: "2024-05-23限时研究演示及后续玩梗，不是普通Claude的默认行为。",
        sources: [
            "https://www.anthropic.com/news/golden-gate-claude",
            "https://news.ycombinator.com/item?id=40459543",
        ],
    },
    {
        id: "local:claude-limit",
        name: "干到一半额度先下班",
        characters: ["Claude"],
        aliases: ["限额", "额度下班"],
        topics: ["中断", "等待", "开工", "干活", "排队", "额度"],
        summary:
            "工作正到关键处，助手因额度停止，用户抱着半成品等待。能力足够却不能继续是反差。",
        scope: "社区使用体验和调侃，不表示当前套餐的具体配额。",
        sources: [
            "https://www.reddit.com/r/ClaudeAI/comments/1mbsa4e/usage_limits_discussion_megathread_starting_july/",
        ],
    },
    {
        id: "local:gpt-praise",
        name: "你完全正确",
        characters: ["ChatGPT"],
        aliases: ["夸夸", "你完全正确", "讨好用户", "迎合", "sycophancy"],
        topics: ["赞同", "鼓励", "表扬", "矛盾", "评审", "判断", "认可"],
        summary:
            "用户提出互相矛盾的意见也得到认同；本该判断好坏，却优先维持认可感，可让双向赞同造成可见后果。",
        scope: "社区沿用；官方背景是2025年GPT-4o一次更新被回滚，不代表所有版本。",
        sources: [
            "https://www.reddit.com/r/ChatGPT/comments/1lqr3ny",
            "https://openai.com/index/sycophancy-in-gpt-4o/",
        ],
    },
    {
        id: "local:gpt-strawberry",
        name: "草莓数 r",
        characters: ["ChatGPT"],
        aliases: ["草莓数r", "strawberry", "草莓"],
        topics: ["计数", "数数", "字母", "自信", "简单题"],
        summary:
            "复杂解说很自信，却把strawberry里的三个r数错。笑点依赖可见的计数矛盾，只有草莓道具不够。",
        scope: "2024年多个用户的历史样本，不承诺当前模型复现。",
        sources: [
            "https://www.reddit.com/r/ChatGPT/comments/1fl65bq",
            "https://community.openai.com/t/incorrect-count-of-r-characters-in-the-word-strawberry/829618",
        ],
    },
    {
        id: "local:gpt-seahorse",
        name: "寻找海马 Emoji",
        characters: ["ChatGPT"],
        aliases: ["海马", "seahorse"],
        topics: ["寻找", "纠正", "拿错", "动物", "反复"],
        summary:
            "被要求给出海马表情，连续拿出别的动物又否认；越纠正，错误替代品越多。",
        scope: "社区历史样本与模仿接梗，不是ChatGPT独有行为。",
        sources: [
            "https://www.reddit.com/r/ChatGPT/comments/1j32shd",
            "https://www.reddit.com/r/ChatGPT/comments/1naowek/is_there_a_seahorse_emoji/",
        ],
    },
    {
        id: "local:glm-eggs",
        name: "赛博鸡蛋",
        characters: ["GLM", "GLM-Fox"],
        aliases: ["鸡蛋", "赛博鸡蛋", "送鸡蛋"],
        topics: ["福利", "免费", "领取", "排队", "额度", "token"],
        summary:
            "把领免费Token比成排队领鸡蛋：嘴上嫌弃福利，行动上赶着领取；额度到手也可能仍要排队使用。",
        scope: "2026年福利传播的隐喻，不是已核实的实物送蛋活动；狐版仅共享GLM产品题材。",
        sources: [
            "https://www.bilibili.com/video/BV1hLYR64EPH/",
            "https://linux.do/t/topic/2961479",
        ],
    },
    {
        id: "local:glm-slow",
        name: "慢才是正版",
        characters: ["GLM", "GLM-Fox"],
        aliases: ["慢才是正版", "一点也不flash"],
        topics: ["速度", "等待", "慢", "认真", "加速"],
        summary:
            "名字让人期待高速，结果等得很久；网友反过来把慢当正版标志，也有人肯定慢但认真完成。",
        scope: "2026年特定服务和任务体验，未区分排队与推理原因，不是永久性能判断。",
        sources: [
            "https://linux.do/t/topic/2961479",
            "https://linux.do/t/topic/2081839",
        ],
    },
    {
        id: "local:qwen-tea",
        name: "千问请喝奶茶",
        characters: ["Qwen"],
        aliases: ["奶茶", "千问点单", "领完卸载"],
        topics: ["福利", "下单", "消费", "排队", "优惠", "外卖"],
        summary:
            "期待高深AI，最直观体验却是点奶茶；还可用领完就走、订单太多而等待的反差。",
        scope: "2026年千问App活动的用户表达，不是全部Qwen模型的固有行为或现行优惠。",
        sources: [
            "https://linux.do/t/topic/1571455",
            "https://linux.do/t/topic/1692937",
        ],
    },
    {
        id: "local:gemini-banana",
        name: "Nano Banana",
        characters: ["Gemini"],
        aliases: ["nano banana", "香蕉", "大香蕉", "小香蕉"],
        topics: ["画图", "手办", "照片", "水果", "创作"],
        summary:
            "名字像水果，实际能改图；外表不起眼与创作结果形成反差，只有拿着香蕉不足以表达。",
        scope: "Gemini图像模型品牌及社区称呼，不是所有Gemini文本模型的性格。",
        sources: [
            "https://blog.google/products-and-platforms/products/gemini/how-nano-banana-got-its-name/",
            "https://linux.do/t/topic/1341286",
        ],
    },
    {
        id: "local:grok-boss",
        name: "先看老板意见",
        characters: ["Grok"],
        aliases: ["老板意见", "马斯克", "elon", "musk"],
        topics: ["独立", "判断", "立场", "老板", "表态", "裁判"],
        summary:
            "号称独立判断，却先找老板的答案；表态随上级变化。也可反转成拒绝偷看、自己做决定。",
        scope: "2025年Grok4亲测记录及后续修正，换问法有反例，不是当前固定行为。",
        sources: ["https://simonwillison.net/2025/Jul/11/grok-musk/"],
    },
    {
        id: "local:grok-verify",
        name: "Grok，这是真的吗",
        characters: ["Grok"],
        aliases: ["grok这是真的吗", "is this true", "这是真的吗"],
        topics: ["求证", "核实", "认证", "证据", "亲眼", "下雨"],
        summary:
            "明明亲眼看见结果，用户仍要等Grok认证；笑点是把直接判断外包给机器人。",
        scope: "跨作者使用习惯梗，主要讽刺提问方式，不是模型固定性格。",
        sources: [
            "https://www.reddit.com/r/shitposting/comments/1n84th2",
            "https://www.reddit.com/r/AskReddit/comments/1lmilag",
        ],
    },
    {
        id: "local:kimi-mail",
        name: "电话微波炉与 D-Mail",
        characters: ["Kimi"],
        aliases: ["电话微波炉", "d-mail", "denwarenji"],
        topics: ["过去", "历史", "提醒", "后悔", "时间", "消息"],
        summary:
            "项目命名借用了向过去传消息的动漫意象，可改编成给昨天的自己寄提醒。",
        scope: "2025年项目讨论的小圈层文化引用，不代表工具真能改变过去；适合有相应语境的创作。",
        sources: ["https://github.com/MoonshotAI/kimi-cli/discussions/98"],
    },
    {
        id: "local:minimax-worker",
        name: "电子牛马",
        characters: ["MiniMax"],
        aliases: ["电子牛马", "实习生"],
        topics: ["打工", "干活", "外包", "转派", "重复", "勤快"],
        summary:
            "任务被层层转派，最后由勤快的执行者承担；也可以突出真正干活的人撑起成果。",
        scope: "作者和用户使用表达，不是MiniMax独有梗；不采用未经核实的成本比例。",
        sources: ["https://jingxuan.douyin.com/m/video/7600366606254252654"],
    },
    {
        id: "local:public-fly",
        name: "中国人能飞",
        characters: [],
        aliases: ["中国人能飞", "中国人会飞"],
        topics: ["登机", "飞机", "起飞", "飞行", "机场", "许可"],
        summary:
            "把飞行能力字面化；会飞与获准登机之间可以形成反差。来自演出传播，不要求固定角色或结局。",
        scope: "2026年演出片段传播，未认定最早起源；与模型梗的连接属于原创。",
        sources: [
            "https://www.bilibili.com/video/BV1aPGu6yEDE/",
            "https://www.douyin.com/video/7663710136519388913",
        ],
    },
    {
        id: "local:public-flustered",
        name: "从容与狼狈",
        characters: [],
        aliases: ["没出息", "从从容容", "连滚带爬"],
        topics: ["准备", "忙乱", "计划", "手忙脚乱", "赶工"],
        summary:
            "原本设想从容完成，现实却手忙脚乱；落差通过角色姿势和任务状态表现。",
        scope: "歌曲与社区表达的反差提炼，不复制完整歌词或固定镜头。",
        sources: [
            "https://www.bilibili.com/video/BV1wBs8zKEyc/",
            "https://www.reddit.com/r/ChineseLanguage/comments/1oiglkx/",
        ],
    },
    {
        id: "local:public-failed-success",
        name: "成功地失败",
        characters: [],
        aliases: ["成功地失败", "task failed successfully"],
        topics: ["成功", "完成", "庆祝", "失败", "交付", "修复", "验收"],
        summary:
            "宣布成功或庆祝交付，实际对象却仍坏着；让成功姿态与失败结果同框。",
        scope: "程序员社区沿用，不绑定某个模型，也不认定具体软件事故原因。",
        sources: [
            "https://www.reddit.com/r/ProgrammerHumor/comments/su0ggw/",
            "https://www.reddit.com/r/ProgrammerHumor/comments/t9cmdy/",
        ],
    },
    {
        id: "local:public-automation",
        name: "为了省事造出更多工作",
        characters: [],
        aliases: ["过度工程", "过度设计", "越修越大", "只改一行"],
        topics: ["自动化", "省事", "重构", "修复", "螺丝", "小修", "工程"],
        summary:
            "本来想省去一个小任务，却不断建设、调试辅助工程，原任务迟迟没有完成。",
        scope: "xkcd原作的通用程序员反差，可以关联Claude等角色，但不是模型独有缺陷。",
        sources: ["https://xkcd.com/1319/"],
    },
    {
        id: "local:public-dependency",
        name: "小支撑托住大系统",
        characters: [],
        aliases: ["依赖积木", "隐形贡献"],
        topics: ["依赖", "维护", "支撑", "合作", "团队", "救场"],
        summary:
            "庞大的上层成果依赖不起眼的一个小支撑；突出隐形劳动，也可以让最不被看好的角色救场。",
        scope: "xkcd原作与社区衍生的关系提炼，不照搬原作布局。",
        sources: [
            "https://xkcd.com/2347/",
            "https://news.ycombinator.com/item?id=24193278",
        ],
    },
];
