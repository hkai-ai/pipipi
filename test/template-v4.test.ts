/** 经正式 HTTP 与流程接缝验证拆解候选、按需修正、旧版兼容及跨仓交接。 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AgentExecutionFailure } from "../src/agent-runtime/failure.js";
import { AgentJsonSyntaxError } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
} from "../src/process-runtime/index.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import type { PrintDesignAgent } from "../src/processes/template-from-image/design-spec/agent.js";
import {
    candidateIssues,
    compilePromptSchema,
    compileResult,
    PrintDesignContractError,
    readCandidate,
} from "../src/processes/template-from-image/design-spec/contract.js";
import { printDesignProduction } from "../src/processes/template-from-image/design-spec/production.js";
import { createPrintDesignRegistration } from "../src/processes/template-from-image/design-spec/registration.js";
import { toTemplatePlan } from "../src/processes/template-from-image/projection.js";
import { createTemplateRegistration } from "../src/processes/template-from-image/registration.js";
import { createTemplateSourceRegistration } from "../src/processes/template-from-source/registration.js";
import { candidate, reviewFor } from "./fixtures/template-candidate.js";

const fixture = () =>
    readCandidate(
        JSON.parse(
            readFileSync(
                new URL(
                    "./fixtures/template-v4-candidate.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        ),
    );
const image = {
    data: "cG5n",
    mimeType: "image/png" as const,
    width: 1024,
    height: 1024,
};
const imageUrl = `https://assets.memebuy.cn/gallery/template-images/${"c".repeat(64)}.png`;

const applications: ReturnType<typeof createProcessingApplication>[] = [];
afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
});
function dependencies() {
    return {
        loadImage: vi.fn(async () => image),
        agent: {
            compile: vi.fn<PrintDesignAgent["compile"]>(async () => fixture()),
        },
    };
}
async function run(deps = dependencies()) {
    const registration = createPrintDesignRegistration(deps);
    const accepted = registration.accept({ imageUrl });
    if (!accepted.accepted) throw new Error("输入不合法");
    return createProcessAttemptRunner().run({
        runId: "fixed-template-v4",
        registration,
        acceptedInput: accepted.acceptedInput,
    });
}
it("源图批准入口 v3 首轮合规直接单次返回，回包可交给 Memebuy；旧 v1 仍精确执行", async () => {
    const deps = dependencies();
    const compiler = createPrintDesignRegistration(deps);
    const old = candidate();
    const oldCompile = vi.fn(async () => toTemplatePlan(old));
    const legacy = createTemplateRegistration({
        loadImage: async () => image,
        agent: {
            compile: oldCompile,
            review: async () => ({ ...old, review: reviewFor(old) }),
        },
    });
    const preparation = {
        savePlan: vi.fn(),
        render: vi.fn(),
        finalize: vi.fn(async () => ({
            url: imageUrl,
            sha256: "c".repeat(64),
            width: 1024,
            height: 1024,
            contentType: "image/png" as const,
            note: "原始要求",
        })),
    };
    const source = createTemplateSourceRegistration({
        runtimeVersion: 4,
        compiler,
        attemptRunner: createProcessAttemptRunner(),
        preparation,
    });
    const app = createProcessingApplication({
        executor: createProcessExecutor({
            registrations: [compiler, source, legacy],
        }),
    });
    applications.push(app);
    const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
    const approval = {
        productionId: "10000000-0000-4000-8000-000000000001",
        renderId: "20000000-0000-4000-8000-000000000001",
        objectSha256: "c".repeat(64),
        reviewPackageSha256: "d".repeat(64),
        reviewerRef: "operator",
    };
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "template-from-source",
            version: "v3",
            input: { ...approval, note: "本轮编译要求" },
        }),
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.output.template.runtimeSemantics.version).toBe(4);
    expect(
        result.output.template.runtimeSemantics.visualContract,
    ).toBeUndefined();
    expect(result.output.template.cover).toBe(imageUrl);
    expect(result.output.template.referenceImage).toBe(imageUrl);
    expect(result.output.preparedImage.sha256).toBe(approval.objectSha256);
    expect(preparation.finalize).toHaveBeenCalledWith(
        approval,
        expect.any(AbortSignal),
    );
    expect(preparation.render).not.toHaveBeenCalled();
    expect(deps.agent.compile).toHaveBeenCalledWith(
        expect.objectContaining({ note: "本轮编译要求" }),
    );
    expect(deps.loadImage).toHaveBeenCalledWith(
        imageUrl,
        expect.any(AbortSignal),
    );
    expect(deps.agent.compile).toHaveBeenCalledOnce();
    if (process.env.PIPIPI_V4_CONTRACT_OUTPUT)
        writeFileSync(
            process.env.PIPIPI_V4_CONTRACT_OUTPUT,
            `${JSON.stringify(result.output, null, 2)}\n`,
        );
    const legacyResponse = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "template-from-image",
            version: "v1",
            input: { imageUrl },
        }),
    });
    expect(legacyResponse.status).toBe(200);
    expect(
        (await legacyResponse.json()).output.template.runtimeSemantics.version,
    ).toBe(2);
    expect(oldCompile).toHaveBeenCalledOnce();
});
it("结构不可读只按需修正一次后成功；模型执行错误不重投", async () => {
    const deps = dependencies();
    deps.agent.compile.mockRejectedValueOnce(
        new AgentJsonSyntaxError("not-json"),
    );
    expect((await run(deps)).status).toBe("succeeded");
    expect(deps.agent.compile).toHaveBeenCalledTimes(2);
    const failed = dependencies();
    failed.agent.compile.mockRejectedValue(
        new AgentExecutionFailure({ stage: "request", code: "connection" }),
    );
    expect(await run(failed)).toMatchObject({
        status: "failed",
        error: { code: "AGENT_FAILURE" },
    });
    expect(failed.agent.compile).toHaveBeenCalledOnce();
});
it("结构错误保留安全字段，动态键仅显示星号", () => {
    const value = fixture();
    const broken = structuredClone(value);
    broken.draft.runtimeSemantics.designSpec.defaults.accentSources.private_key =
        "示例";
    expect(() => readCandidate(broken)).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: expect.arrayContaining([
                    {
                        path: "/draft/runtimeSemantics/designSpec/defaults/accentSources/*",
                        code: "expected_accent_element",
                    },
                ]),
            }),
        }),
    );
    expect(() =>
        readCandidate({
            ...value,
            draft: {
                ...value.draft,
                runtimeSemantics: {
                    ...value.draft.runtimeSemantics,
                    inputBindings: {
                        secret: {
                            operation: "replace_content",
                            targetIds: ["test"],
                            distributionPolicy: "replace_as_unit",
                        },
                    },
                },
            },
        }),
    ).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: expect.arrayContaining([
                    {
                        path: "/draft/runtimeSemantics/inputBindings/*/valueKind",
                        code: "invalid_value",
                    },
                ]),
            }),
        }),
    );
});
it("省略 overview、printRisks 与文字 location 的紧凑输出可直接通过合同", () => {
    const compact = structuredClone(fixture());
    Reflect.deleteProperty(compact.observation, "overview");
    Reflect.deleteProperty(compact.observation, "printRisks");
    for (const item of compact.observation.texts) {
        Reflect.deleteProperty(item, "location");
    }
    for (const slot of compact.draft.inputSchema.slots) {
        Reflect.deleteProperty(slot.text, "placeholder");
        if (slot.image) {
            Reflect.deleteProperty(slot.image, "promptValue");
            Reflect.deleteProperty(slot.image, "hint");
        }
    }
    expect(compilePromptSchema.safeParse(compact).success).toBe(true);
    const parsed = readCandidate(compact);
    expect(compileResult(parsed, imageUrl, image).template.status).toBe(
        "DRAFT",
    );
});
it("原物词命中可执行字段与关系行时记录叶子路径与规则，不泄露禁词", () => {
    const value = fixture();
    const spec = value.draft.runtimeSemantics.designSpec;
    spec.bannedWords.push("受限原物词");
    spec.whole.technique += "受限原物词";
    expect(() => compileResult(value, imageUrl, image)).toThrowError(
        expect.objectContaining({
            diagnostic: {
                stage: "schema",
                code: "invalid_contract",
                issues: [
                    {
                        path: "/draft/runtimeSemantics/designSpec/whole/technique",
                        code: "source_word",
                    },
                ],
            },
        }),
    );
    const relValue = fixture();
    const relSpec = relValue.draft.runtimeSemantics.designSpec;
    const relations = relSpec.whole.composition.relations;
    if (!relations?.length) throw new Error("测试样本必须包含构图关系");
    relSpec.bannedWords.push("受限原物");
    relations[0][2] = "受限原物";
    expect(() => compileResult(relValue, imageUrl, image)).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: [
                    {
                        path: "/draft/runtimeSemantics/designSpec/whole/composition/relations/0",
                        code: "source_word",
                    },
                ],
            }),
        }),
    );
});
it("原文观察与默认迁移文字可以不同，文字元素引用错误仍被拒绝", () => {
    const value = fixture();
    const original = value.observation.texts[0].text;
    const element = value.observation.texts[0].elementId;
    value.observation.texts[0].text = `${original}!`;
    expect(candidateIssues(value)).toEqual([]);
    expect(compileResult(value, imageUrl, image).source.texts[0].text).toBe(
        `${original}!`,
    );
    expect(
        value.draft.runtimeSemantics.designSpec.defaults.texts[element],
    ).toBe(original);
    value.observation.texts[0].elementId = "unknown";
    expect(() => compileResult(value, imageUrl, image)).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: expect.arrayContaining([
                    {
                        path: "/observation/texts/0/elementId",
                        code: "expected_text_element",
                    },
                ]),
            }),
        }),
    );
});
const fixtureFile = (name: string) =>
    JSON.parse(
        readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
    );
it("#1092 重档真实候选：原文与迁移默认字不同仍通过，原文逐字回传", () => {
    const value = readCandidate(
        fixtureFile("template-v4-1092-heavy-candidate.json"),
    );
    expect(candidateIssues(value)).toEqual([]);
    const result = compileResult(value, imageUrl, image);
    const spec = value.draft.runtimeSemantics.designSpec;
    expect(result.source.texts[1]).toEqual({
        text: "MACROSS",
        elementId: "main_title",
    });
    expect(spec.defaults.texts.main_title).toBe("NOCTURNE");
    expect(result.template.promptTemplate).toContain("NOCTURNE");
    expect(result.template.promptTemplate).not.toContain("MACROSS");
});
it("#1092 重档真实候选：槽默认值与迁移默认字不一致仍被拒绝", () => {
    const value = readCandidate(
        fixtureFile("template-v4-1092-heavy-candidate.json"),
    );
    const slot = value.draft.inputSchema.slots.find(
        (item) => item.id === "main_title",
    );
    if (!slot) throw new Error("夹具缺少 main_title 槽");
    slot.text.defaultValue = "MACROSS";
    expect(() => compileResult(value, imageUrl, image)).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: expect.arrayContaining([
                    {
                        path: "/draft/inputSchema/slots/2/text/defaultValue",
                        code: "value_mismatch",
                    },
                ]),
            }),
        }),
    );
});
it("#1092 绑定里唯一合法的常量被写错时按合同改回，真正的取舍错误仍被拒绝", () => {
    const base = fixtureFile("template-v4-1092-light-candidate.json");
    const noisy = structuredClone(base);
    const bindings = noisy.draft.runtimeSemantics.inputBindings;
    bindings.subject.bindingPolicy = "many";
    bindings.subject.groupToSinglePolicy = "merge";
    bindings.subject.allowedSourceGrouping = ["group"];
    bindings.main_slogan.distributionPolicy = "split";
    bindings.main_slogan.valueKind = "text";
    bindings.ink_color.valueKind = "colour";
    const value = readCandidate(noisy);
    const fixed = value.draft.runtimeSemantics.inputBindings;
    expect(fixed.subject).toMatchObject({
        bindingPolicy: "one_to_one",
        groupToSinglePolicy: "reject",
        allowedSourceGrouping: ["single_subject"],
    });
    expect(fixed.main_slogan).toMatchObject({
        valueKind: "exact_text",
        distributionPolicy: "replace_as_unit",
    });
    expect(fixed.ink_color).toMatchObject({ valueKind: "color" });
    expect(candidateIssues(value)).toEqual(
        candidateIssues(readCandidate(base)),
    );
    for (const mutate of [
        (b: typeof base) => {
            b.draft.runtimeSemantics.inputBindings.main_slogan.valueKind = "x";
            b.draft.runtimeSemantics.inputBindings.main_slogan.targetIds = [
                "missing",
            ];
        },
        (b: typeof base) => {
            b.draft.runtimeSemantics.inputBindings.subject.clothingOwnership =
                "none";
        },
    ]) {
        const broken = structuredClone(base);
        mutate(broken);
        expect(() => readCandidate(broken)).toThrowError(
            PrintDesignContractError,
        );
    }
    const wrongKind = structuredClone(base);
    wrongKind.draft.runtimeSemantics.inputBindings.ink_color.valueKind =
        "exact_text";
    expect(() =>
        compileResult(readCandidate(wrongKind), imageUrl, image),
    ).toThrowError(PrintDesignContractError);
});
it.each(["binding", "default", "shapeLeak", "secondImage", "wrongVersion"])(
    "拒绝 %s 违规，修正后仍不合规时失败且不放松作者合同",
    async (reason) => {
        const value = fixture();
        if (reason === "binding")
            value.draft.runtimeSemantics.inputBindings.subject.targetIds = [
                "missing",
            ];
        if (reason === "default")
            value.draft.inputSchema.slots[0].text.defaultValue = "冲突默认值";
        if (reason === "shapeLeak")
            value.draft.runtimeSemantics.designSpec.whole.technique += "Q版";
        if (reason === "secondImage")
            value.draft.inputSchema.slots[1].image =
                value.draft.inputSchema.slots[0].image;
        if (reason === "wrongVersion")
            Object.assign(value.draft.runtimeSemantics, { version: 3 });
        const deps = dependencies();
        deps.agent.compile.mockResolvedValue(value);
        expect((await run(deps)).status).toBe("failed");
        expect(deps.agent.compile).toHaveBeenCalledTimes(2);
    },
);
it("首轮语义问题进入一次按需 correction 修正，通过后直接返回且不暴露 observation", async () => {
    const broken = fixture();
    broken.draft.inputSchema.slots[0].text.defaultValue = "冲突默认值";
    expect(candidateIssues(broken).length).toBeGreaterThan(0);
    const deps = dependencies();
    deps.agent.compile
        .mockResolvedValueOnce(broken)
        .mockResolvedValueOnce(fixture());
    const result = await run(deps);
    expect(result.status).toBe("succeeded");
    expect(deps.agent.compile).toHaveBeenCalledTimes(2);
    expect(
        deps.agent.compile.mock.calls[1][0].correction?.issues.join("\n"),
    ).toContain("默认值与 designSpec.defaults 不一致");
    if (result.status === "succeeded")
        expect(result.output).not.toHaveProperty("observation");
});
it("结构修正准确指出缺失的文本展示方式与图片来源", () => {
    const raw = fixture();
    const slot = raw.draft.inputSchema.slots[0];
    Reflect.deleteProperty(slot.text, "presentation");
    if (!slot.image) throw new Error("夹具缺少图片输入");
    Reflect.deleteProperty(slot.image, "sourceOptions");
    try {
        readCandidate(raw);
        expect.fail("缺失作者字段的候选应进入修正");
    } catch (error) {
        if (!(error instanceof PrintDesignContractError)) throw error;
        expect(error.issues.join("\n")).toContain(
            "draft.inputSchema.slots.0.text.presentation",
        );
        expect(error.issues.join("\n")).toContain(
            "draft.inputSchema.slots.0.image.sourceOptions",
        );
    }
});
it("成功输出回传 source：文字取 text+elementId，状况取 sourceCondition", async () => {
    const custom = fixture();
    custom.observation.sourceCondition = {
        marks: [{ kind: "watermark", text: "sample.com" }],
        carrier: "garment_photo",
        sharpness: "slightly_blurry",
        compressionArtifacts: true,
        notes: ["右下角有水印"],
    };
    const deps = dependencies();
    deps.agent.compile.mockResolvedValueOnce(custom);
    const result = await run(deps);
    expect(result.status).toBe("succeeded");
    expect(deps.agent.compile).toHaveBeenCalledOnce();
    if (result.status !== "succeeded") return;
    const output = result.output as ReturnType<typeof compileResult>;
    expect(output.source).toEqual({
        texts: fixture().observation.texts.map(({ text, elementId }) => ({
            text,
            elementId,
        })),
        condition: {
            marks: [{ kind: "watermark", text: "sample.com" }],
            carrier: "garment_photo",
            sharpness: "slightly_blurry",
            compressionArtifacts: true,
            notes: ["右下角有水印"],
        },
    });
    expect(output.source.texts[0]).not.toHaveProperty("location");
    expect(output).not.toHaveProperty("observation");
});
it("缺少 sourceCondition 进入修正预算而不是崩溃，修正后成功", async () => {
    const broken = fixture();
    Reflect.deleteProperty(broken.observation, "sourceCondition");
    expect(() => readCandidate(broken)).toThrowError(
        expect.objectContaining({
            diagnostic: expect.objectContaining({
                issues: [
                    {
                        path: "/observation/sourceCondition",
                        code: "invalid_type",
                    },
                ],
            }),
        }),
    );
    const deps = dependencies();
    deps.agent.compile
        .mockResolvedValueOnce(broken)
        .mockResolvedValueOnce(fixture());
    const result = await run(deps);
    expect(result.status).toBe("succeeded");
    expect(deps.agent.compile).toHaveBeenCalledTimes(2);
    expect(
        deps.agent.compile.mock.calls[1][0].correction?.issues.join(),
    ).toContain("observation.sourceCondition");
});
it("生产装配在未指定 TEMPLATE_MODEL 时默认选用 gpt-6.1-terra", () => {
    const registration = printDesignProduction.build({
        pi: { provider: "openai", model: "gpt-5.4-mini" },
        environment: {},
        skills: [
            {
                name: "print-design-template-compiler",
                version: "v3",
                sha256: "f373a22b93be426661727ae382048b703db7e23136ca04a2bd8404652dedd45d",
                path: ".pi/skills/print-design-template-compiler",
            },
        ],
        members: {
            registry: createProcessRegistry([]),
            attemptRunner: createProcessAttemptRunner(),
        },
        positiveInteger: (_name, fallback) => fallback,
    });
    expect(registration.identity).toEqual({
        id: "template-from-image",
        version: "v3",
    });
});
