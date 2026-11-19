/** 核验 Memebuy 来源摘要并生成拆解合同、纯检查器与完整无 Tool 规则快照。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const source = process.argv[2];
if (!source) throw new Error("请提供 Memebuy 应用目录");
const directory = ".pi/skills/print-design-template-compiler";
const manifest = JSON.parse(readFileSync(`${directory}/source-manifest.json`, "utf8")) as {files: {path: string; sha256: string}[]};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const contents = new Map<string, string>();
for (const file of manifest.files) {
    const bytes = readFileSync(resolve(source, file.path));
    if (hash(bytes) !== file.sha256) throw new Error(`来源变化，请先审查：${file.path}`);
    contents.set(file.path, bytes.toString("utf8"));
}
const generated: Record<string, string> = {};
const schema = JSON.parse(contents.get("docs/gallery/template-import/schema.json") ?? "");
schema.$id = "urn:pipipi:template-from-image:v3:runtime-v4";
schema.$defs.runtimeSemantics = {$ref: "#/$defs/runtimeSemanticsV4"};
generated[`${directory}/gallery.schema.json`] = `${JSON.stringify(schema, null, 2)}\n`;
for (const [path, content] of contents) {
    if (!path.endsWith(".ts")) continue;
    const name = path.split("/").at(-1);
    generated[`src/processes/template-from-image/design-spec/vendor/${name}`] = '/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */\n' + content
        .replaceAll("'zod'", '"zod"')
        .replaceAll("(a[i] as string).codePointAt(0)!", "((a[i] as string).codePointAt(0) ?? 0)")
        .replaceAll("(b[i] as string).codePointAt(0)!", "((b[i] as string).codePointAt(0) ?? 0)")
        .replaceAll("'@/modules/gallery/templates/design-spec-schema'", '"./design-spec-schema.js"')
        .replace(/from '\.\/([^']+)'/gu, 'from "./$1.js"');
}
function filterMarkdown(
    markdown: string,
    options: {
        keepH2?: readonly string[];
        drop: readonly string[];
    },
): string {
    const keepH2 = options.keepH2 ? new Set(options.keepH2) : undefined;
    const drop = new Set(options.drop);
    const seen = new Set<string>();
    const stack: { level: number; title: string }[] = [];
    const output: string[] = [];
    let inFence = false;
    for (const line of markdown.replace(/\r\n/gu, "\n").split("\n")) {
        if (line.startsWith("```")) inFence = !inFence;
        if (!inFence) {
            const match = line.match(/^(#{1,6})\s+(.+)$/u);
            if (match) {
                const level = match[1]?.length ?? 0;
                const title = match[2]?.trim() ?? "";
                seen.add(title);
                while (stack.length && (stack.at(-1)?.level ?? 0) >= level)
                    stack.pop();
                stack.push({ level, title });
            }
        }
        const titles = stack.map((item) => item.title);
        const keptByH2 = !keepH2 || (titles.length >= 2 && keepH2.has(titles[1] ?? ""));
        if (keptByH2 && !titles.some((title) => drop.has(title))) {
            output.push(line);
        }
    }
    for (const required of [...(options.keepH2 ?? []), ...options.drop]) {
        if (!seen.has(required)) {
            throw new Error(`来源章节标题已变化，请审查裁剪规则：${required}`);
        }
    }
    return `${output.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

const preparationDoc = filterMarkdown(
    contents.get("docs/gallery/print-design-preparation.md") ?? "",
    {
        drop: [
            "深浅衣服（2026-11-10 定）",
            "印花版：替换封面与参考图（2026-11-10 定）",
            "提示词编译",
            "生成前的设计任务书",
            "生成后独立验收",
            "参考样本观察（2026-11-04）",
            "当前验证边界",
        ],
    },
);

const runtimeContractDoc = filterMarkdown(
    contents.get("docs/gallery/agent-template-json-runtime-contract.md") ?? "",
    {
        keepH2: [
            "运行语义 v4（拆解数据）：第 3 阶段开发完成（生成链路已接入，待 UAT 对比），生产开关默认关",
            "`runtimeSemantics` 如何保存制作人意图",
        ],
        drop: [
            "动态合照群组",
            "仅作参考",
            "当前可执行能力矩阵",
            "`visualContract`：哪些视觉维度必须跨用户改写保留",
            "适配原版与透明输出",
        ],
    },
);

const preamble = `---
name: print-design-template-compiler
description: 从批准图片拆解印花结构与输入绑定，输出 Gallery 运行语义 v4 候选并独立复核。
---

# 已批准图片转印花模板

以下嵌入经裁剪的印花拆解方法正本与运行语义 v4 作者合同（已剔除实验复盘、下游印厂验收、CLI 批量导入及旧 v1～v3 visualContract 章节）。当前任务只产候选，不生成图片、不修改已批准图片、不入库、不发布。
无 Tool 环境：不执行文档内脚本、文件、网络、后台、导入或生成操作；像素测量仅使用宿主本次提供的证据，未测量的统计不得编造。
流程版本 v3 与运行语义 v4 分别管理。只输出 inputSchema.version=2 与 runtimeSemantics.version=4；没有 visualContract、promptEnhancement 或 preprocessSteps。
先看真实附件，记录整体、文字、颜色、层次和印花风险，再编写 designSpec。默认 same_design；输入绑定只开放当前引擎能消费的主体照片（全模板最多一个且 maxCount=1，使用 text+image+image_over_text，binding 固定 one_to_one）及文本、配色（固定 replace_as_unit；不支持 same_source_repeated、preserve_group、内容图或 reference_only 输入）。槽位 label 描述稳定的用户编辑意图（如“主角”“主标题”），不写原图默认答案。
将原物与外形词留在 instance/originalObject/shapeFeatures 作为证据，defaults 写可执行的作者默认迁移；不得为通过检查伪造原始观察，执行描述不得混入原物外形。可替换默认答案不写入 technique、purpose、layout.role 或固定关系。正向写看得见的特征，不写元语言（“标志特征”“锁定”）或抽象风格词（Q 版/Q版/满版风格/糖果/小幽默/萌系）；非 lightIsMood 时描述不用半透明或发光词（光晕/发光/辉光/光雾/烟雾/雾气/薄雾/朦胧/柔焦/虚化/景深/半透明/透明感/透光/光束/霓虹光/淡出/渐渐透明/逐渐透明/渐隐成透明/柔光/投影）；standalone 不用贴边词（撑满画面/占满画面/铺满画布/撑满画布/顶到画布边/贴着画布边）。描述可用 @元素id 与 {色:角色名} 引用，点缀色写具体色名或附色值。版面框为候选，必须人审叠图核对。
每个文字元素都有 defaults.texts，随主体的名字/释义标 followsSubject；固定口号保持默认字。配色角色有默认颜色。所有开放槽的文字默认值必须与绑定目标的 defaults 一致；主体可以 text+image，文字与配色只用 text。promptTemplate 由服务端从 defaults 单向生成，模型不得维护第二份提示词。
印花形态按已批准图片选一个：完整图形 standalone；场景/海报 rect_patch 且要有真实设计边框的 edge 元素；切开主体 bleed_crop。不能凭空声称审批图已有边框或已适合印刷；有缺陷如实标 needs_prep/not_for_apparel，运营可退回图片步骤重做。表达机制是推断，保留给人工确认。被文字或画布遮挡的部位只按可见范围描述（如“展示头部与上身”），不脑补不可见的下半身姿态；画法、配色总述与元素可执行描述引用颜色统一用 {色:角色名}，不写死原图具体色名。
observation 包含 texts（逐字记录设计内可读文字 {text,elementId}，无文字则空数组）与必填 sourceCondition（记录原图自身状况，不属于设计：{marks,carrier,sharpness,compressionArtifacts,notes}）。marks 只记非设计本身的附加标记，kind 取 watermark（水印）、signature（署名）、platform_logo（平台标识），可带逐字 text，无则空数组，最多 5 项；设计里的文字照旧逐字进 observation.texts，不进 marks，水印与署名文字也不进 texts。carrier 判画面载体：flat_artwork 平面设计稿、garment_photo 印在衣服上的实拍、product_photo 印在其他商品上的实拍、scene_photo 场景照片。sharpness 判原图画质：clear、slightly_blurry、severely_blurry；compressionArtifacts 为是否可见明显压缩块或振铃。notes 最多 5 条短说明，无特殊异常传空数组。只据附件如实判断，不据此改变 designSpec。
输出紧凑 {observation,draft}，draft 只包含 key/title/description/inputSchema/runtimeSemantics/metadata(tags)。只为主角、关键文字及 1～3 个核心配色角色开放输入槽；各描述用简练短句直写可见事实与可执行特征，不写冗余解释。提交前在同轮自检原物词隔离、默认值逐字一致与绑定引用。
`;
generated[`${directory}/SKILL.md`] = [
    preamble,
    `<!-- source: docs/gallery/print-design-preparation.md (v4 runtime subset) -->\n\n${preparationDoc}`,
    `<!-- source: docs/gallery/agent-template-json-runtime-contract.md (v4 runtime subset) -->\n\n${runtimeContractDoc}`,
].join("\n");
const check = process.argv.includes("--check");
for (const [path, raw] of Object.entries(generated)) {
    const content = path.endsWith(".ts") ? execFileSync("node_modules/.bin/biome", ["check", "--write", "--stdin-file-path", path], {input: raw, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]}) : raw;
    if (check) { if (readFileSync(path, "utf8") !== content) throw new Error(`需要重建：${path}`); }
    else writeFileSync(path, content);
}
console.log(JSON.stringify({check, files: Object.keys(generated), skillSha256: hash(generated[`${directory}/SKILL.md`] ?? ""), schemaSha256: hash(generated[`${directory}/gallery.schema.json`] ?? "")}));
