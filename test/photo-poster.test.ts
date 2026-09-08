import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessingApplication } from "../src/api/application.js";
import { createProductionRuntime } from "../src/app/business-processes.js";
import { startCrtBusinessApi } from "../src/business-api/crt-server.js";
import {
    decodeSourcePhoto,
    finalizeTravelPhoto,
} from "../src/business-api/photo-poster.js";
import { downloadSourcePhoto } from "../src/business-api/source-photo.js";
import {
    createProcessRegistry,
    createProcessRunner,
} from "../src/process-runtime/index.js";
import { HttpPhotoPosterRenderingCapability } from "../src/processes/photo-poster/capability.http.js";
import { PhotoPosterRenderingUnavailable } from "../src/processes/photo-poster/capability.js";
import { monoColorPresets } from "../src/processes/photo-poster/mono-color.js";
import { createPhotoPosterRegistration } from "../src/processes/photo-poster/registration.js";
import {
    type PhotoPosterStyle,
    photoPosterProcessId,
    photoPosterStyles,
} from "../src/processes/photo-poster/style.js";

vi.mock("../src/business-api/source-photo.js", () => ({
    downloadSourcePhoto: vi.fn(),
}));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
    vi.clearAllMocks();
});
const sourceImageUrl = "https://assets.example.com/photo.png?private=sample";
const prompt =
    "Keep the uploaded photograph as the only content source and apply the fixed editorial rules. ".repeat(
        8,
    );
const image = {
    url: "https://assets.example.com/poster.png",
    contentType: "image/png" as const,
    width: 1_200,
    height: 1_600,
};
const inputFor = (style: PhotoPosterStyle) =>
    style === "travel-abstraction"
        ? { sourceImageUrl, phrase: "QUIET PAWS", capturedOn: "2026-09-07" }
        : { sourceImageUrl, text: "你好 PHOTO" };
function runtime(
    style: PhotoPosterStyle,
    render = vi.fn().mockResolvedValue(image),
    compile = vi.fn().mockResolvedValue({ prompt }),
    timeout = 2_000,
) {
    return {
        render,
        compile,
        executor: createProcessRunner({
            registry: createProcessRegistry([
                createPhotoPosterRegistration(style, {
                    agent: { compile },
                    capability: { render },
                }),
            ]),
            processTimeoutMs: timeout,
        }),
    };
}
const requestFor = (style: PhotoPosterStyle) => ({
    process: photoPosterProcessId(style),
    version: "v1",
    input: inputFor(style),
});
const png = (width: number, height: number, background = "#F3F0E8") =>
    sharp({ create: { width, height, channels: 3, background } })
        .png()
        .toBuffer();

describe("照片海报的六个准确版本", () => {
    it.each(photoPosterStyles)(
        "%s 通过正式 HTTP 返回同一次图片调用的结果",
        async (style) => {
            const { executor, compile, render } = runtime(style);
            const app = createProcessingApplication({ executor });
            const { url } = await app.listen();
            cleanups.push(() => app.close());
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(requestFor(style)),
            });
            const result = await response.json();
            expect(response.status).toBe(200);
            expect(result).toMatchObject({
                status: "succeeded",
                output: { style, image },
            });
            expect(Object.keys(result.output).sort()).toEqual([
                "image",
                "style",
            ]);
            expect(compile).toHaveBeenCalledOnce();
            expect(render).toHaveBeenCalledOnce();
            expect(compile.mock.calls[0]?.[0]).toEqual({
                signal: expect.any(AbortSignal),
            });
            expect(render.mock.calls[0]?.[1]).toEqual({
                signal: expect.any(AbortSignal),
                idempotencyKey: result.runId,
            });
            expect(render.mock.calls[0]?.[0]).toMatchObject({
                style,
                sourceImageUrl,
            });
            expect(render.mock.calls[0]?.[0].prompt).toContain(
                "Use the entire canvas for the stylized artwork",
            );
            expect(render.mock.calls[0]?.[0].prompt).not.toContain(
                "Keep the photograph above",
            );
            if (style !== "travel-abstraction")
                expect(render.mock.calls[0]?.[0].prompt).toContain(
                    '"你好 PHOTO"',
                );
            expect(JSON.stringify(result)).not.toContain("private=sample");
            expect(JSON.stringify(result)).not.toContain(prompt);
        },
    );
    it.each(photoPosterStyles)("%s 拒绝输入越权和版本回退", async (style) => {
        const { executor, render, compile } = runtime(style);
        for (const extra of [
            { model: "other" },
            { skill: "url" },
            { prompt: "override" },
            { style: "other" },
            { aspectRatio: "1:1" },
            { sourceImageUrl: "http://localhost/photo.png" },
        ]) {
            expect(
                await executor.execute({
                    ...requestFor(style),
                    input: { ...inputFor(style), ...extra },
                }),
            ).toMatchObject({
                status: "failed",
                error: { code: "INVALID_INPUT" },
            });
        }
        expect(
            await executor.execute({ ...requestFor(style), version: "latest" }),
        ).toMatchObject({ error: { code: "PROCESS_NOT_FOUND" } });
        expect(render).not.toHaveBeenCalled();
        expect(compile).not.toHaveBeenCalled();
    });
    it("编译失败不付费，付费后错误不降级为可重试", async () => {
        const bad = runtime(
            "dopamine",
            vi.fn(),
            vi.fn().mockResolvedValue({ prompt: "short" }),
        );
        expect(
            await bad.executor.execute(requestFor("dopamine")),
        ).toMatchObject({ error: { code: "AGENT_FAILURE" } });
        expect(bad.render).not.toHaveBeenCalled();
        for (const committed of [false, true]) {
            const run = runtime(
                "dopamine",
                vi
                    .fn()
                    .mockRejectedValue(
                        new PhotoPosterRenderingUnavailable({ committed }),
                    ),
            );
            expect(
                await run.executor.execute(requestFor("dopamine")),
            ).toMatchObject({
                error: {
                    code: committed
                        ? "DEPENDENCY_FAILURE_AFTER_COMMIT"
                        : "DEPENDENCY_FAILURE",
                },
            });
            expect(run.render).toHaveBeenCalledOnce();
        }
    });
    it("超时取消编译，不进入图片服务", async () => {
        const run = runtime(
            "crayon",
            vi.fn(),
            vi
                .fn()
                .mockImplementation(
                    ({ signal }) =>
                        new Promise((_, reject) =>
                            signal.addEventListener(
                                "abort",
                                () => reject(new Error("abort")),
                                { once: true },
                            ),
                        ),
                ),
            15,
        );
        expect(await run.executor.execute(requestFor("crayon"))).toMatchObject({
            error: { code: "PROCESS_TIMEOUT" },
        });
        expect(run.render).not.toHaveBeenCalled();
    });
    it("生产 catalog 显式注册六项，未加入跳过的猫猫绘本", () => {
        const production = createProductionRuntime({
            BUSINESS_API_BASE_URL: "https://business.example",
        });
        for (const style of photoPosterStyles)
            expect(
                production.registry
                    .find({ id: photoPosterProcessId(style), version: "v1" })
                    ?.accept(inputFor(style)),
            ).toMatchObject({ accepted: true });
        expect(
            production.registry.find({
                id: "cat-storybook-photo-poster",
                version: "v1",
            }),
        ).toBeUndefined();
    });
});

describe("Mono Color 可编辑预设", () => {
    it.each(monoColorPresets)(
        "%s 经正式 HTTP 将默认搭配送到同一次图片调用",
        async (preset) => {
            const { executor, compile, render } = runtime("mono-color");
            const app = createProcessingApplication({ executor });
            const { url } = await app.listen();
            cleanups.push(() => app.close());
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    process: "mono-color-photo-poster",
                    version: "v1",
                    input: { sourceImageUrl, preset, palette: "preset" },
                }),
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                status: "succeeded",
                output: { style: "mono-color", image },
            });
            expect(render).toHaveBeenCalledOnce();
            expect(compile.mock.calls[0]?.[0]).toEqual({
                signal: expect.any(AbortSignal),
            });
            const finalPrompt = render.mock.calls[0]?.[0].prompt;
            expect(finalPrompt).toContain(
                preset === "within_reach" || preset === "half_hidden"
                    ? "#2148B8"
                    : "#30343A",
            );
            expect(finalPrompt).toContain(
                {
                    within_reach: "Editorial cover:",
                    half_hidden: "Diagonal crop:",
                    your_move: "Frontal statement:",
                    hold_still: "Typographic viewfinder:",
                    look_again: "Rising diagonal title:",
                }[preset],
            );
            expect(finalPrompt).toContain("do not invent reaching hands");
            expect(finalPrompt).toContain(
                "never include an original-photo region",
            );
        },
    );

    it("显式编辑覆盖预设，恢复跟随预设后按新预设解析", async () => {
        const { executor, render } = runtime("mono-color");
        const edited = {
            sourceImageUrl,
            preset: "half_hidden",
            palette: "green_oxblood",
            typography: "condensed",
            composition: "frame",
            emphasis: "gentle",
            texture: "strong",
            text: "MY CAT",
            designNotes: "Keep more space around the subject.",
        };
        await executor.execute({
            process: "mono-color-photo-poster",
            version: "v1",
            input: edited,
        });
        const finalPrompt = render.mock.calls[0]?.[0].prompt;
        for (const fragment of [
            "#008A4B",
            "heavy condensed",
            "Typographic viewfinder:",
            "quiet scale contrast",
            "coarser halftone",
            '"MY CAT"',
            "Keep more space",
        ])
            expect(finalPrompt).toContain(fragment);
        expect(finalPrompt).not.toContain("#2148B8");
        await executor.execute({
            process: "mono-color-photo-poster",
            version: "v1",
            input: { ...edited, preset: "your_move", palette: "preset" },
        });
        expect(render.mock.calls[1]?.[0].prompt).toContain("#30343A");
        expect(render.mock.calls[1]?.[0].prompt).toContain(
            "Typographic viewfinder:",
        );
    });

    it("旧输入不增加预设约束，非法参数在调用 Agent 前拒绝", async () => {
        const { executor, compile, render } = runtime("mono-color");
        await executor.execute(requestFor("mono-color"));
        expect(render.mock.calls[0]?.[0].prompt).not.toContain(
            "resolved design settings",
        );
        compile.mockClear();
        render.mockClear();
        for (const extra of [
            { preset: "unknown" },
            { palette: "#123456" },
            { typography: "unknown" },
            { composition: "unknown" },
            { emphasis: "unknown" },
            { texture: "unknown" },
            { designNotes: "x".repeat(501) },
            { text: "x".repeat(201) },
            { prompt: "arbitrary" },
        ]) {
            expect(
                await executor.execute({
                    ...requestFor("mono-color"),
                    input: { sourceImageUrl, ...extra },
                }),
            ).toMatchObject({
                status: "failed",
                error: { code: "INVALID_INPUT" },
            });
        }
        expect(compile).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
        const other = runtime("dopamine");
        expect(
            await other.executor.execute({
                ...requestFor("dopamine"),
                input: { sourceImageUrl, preset: "within_reach" },
            }),
        ).toMatchObject({ error: { code: "INVALID_INPUT" } });
        expect(other.compile).not.toHaveBeenCalled();
    });
});

describe("照片海报图片 Capability", () => {
    it("跨两个 HTTP 边界生成并下载，幂等重放和重启都不重复付费", async () => {
        const directory = await mkdtemp(join(tmpdir(), "photo-posters-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const bytes = await png(1_200, 1_600);
        const edit = vi
            .fn()
            .mockResolvedValue({ bytes, mimeType: "image/png" });
        const upload = vi.fn().mockResolvedValue({ url: image.url });
        const options = {
            directory,
            imageClient: { edit },
            storage: { provider: "test", upload },
        };
        const business = await startCrtBusinessApi(options);
        cleanups.push(business.close);
        const capability = new HttpPhotoPosterRenderingCapability({
            baseUrl: business.url,
            timeoutMs: 10_000,
        });
        const render = vi.fn(capability.render.bind(capability));
        const run = runtime("woodcut", render);
        const result = await run.executor.execute(requestFor("woodcut"));
        expect(result).toMatchObject({
            status: "succeeded",
            output: { image },
        });
        const rendered = render.mock.calls[0];
        if (!rendered) throw new Error("未调用图片服务");
        expect(edit).toHaveBeenCalledOnce();
        expect(upload).toHaveBeenCalledOnce();
        expect(edit.mock.calls[0]?.[0]).toMatchObject({
            imageUrl: sourceImageUrl,
            size: "1200x1600",
        });
        expect(downloadSourcePhoto).not.toHaveBeenCalled();
        expect(
            Buffer.from(
                await (
                    await fetch(
                        `${business.url}/photo-posters/${result.runId}.png`,
                    )
                ).arrayBuffer(),
            ),
        ).toEqual(bytes);
        expect(await capability.render(rendered[0], rendered[1])).toEqual(
            image,
        );
        await expect(
            capability.render(
                { ...rendered[0], style: "dopamine" },
                rendered[1],
            ),
        ).rejects.toBeInstanceOf(PhotoPosterRenderingUnavailable);
        await business.close();
        const restarted = await startCrtBusinessApi(options);
        cleanups.push(restarted.close);
        const recovered = new HttpPhotoPosterRenderingCapability({
            baseUrl: restarted.url,
            timeoutMs: 10_000,
        });
        expect(await recovered.render(rendered[0], rendered[1])).toEqual(image);
        expect(edit).toHaveBeenCalledOnce();
        const record = await readFile(
            join(directory, "photo-poster-results", `${result.runId}.json`),
            "utf8",
        );
        expect(record).not.toContain(sourceImageUrl);
        expect(record).not.toContain(prompt);
    });
    it("存储失败后保留 pending，不重复图片调用", async () => {
        const directory = await mkdtemp(join(tmpdir(), "photo-failure-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const edit = vi.fn().mockResolvedValue({
            bytes: await png(1_200, 1_600),
            mimeType: "image/png",
        });
        const business = await startCrtBusinessApi({
            directory,
            imageClient: { edit },
            storage: {
                provider: "test",
                upload: vi
                    .fn()
                    .mockRejectedValue(new Error("secret upstream error")),
            },
        });
        cleanups.push(business.close);
        const capability = new HttpPhotoPosterRenderingCapability({
            baseUrl: business.url,
            timeoutMs: 10_000,
        });
        const args = [
            { style: "crayon" as const, prompt, sourceImageUrl },
            { signal: new AbortController().signal, idempotencyKey: "once" },
        ] as const;
        for (let n = 0; n < 2; n++)
            await expect(capability.render(...args)).rejects.toMatchObject({
                committed: true,
            });
        expect(edit).toHaveBeenCalledOnce();
    });
    it("旅行抽象只返回独立成品，原图仅作参考", async () => {
        const directory = await mkdtemp(join(tmpdir(), "travel-photo-"));
        cleanups.push(() => rm(directory, { recursive: true, force: true }));
        const source = await png(640, 480, "#226699");
        vi.mocked(downloadSourcePhoto).mockResolvedValue(source);
        const edit = vi.fn().mockResolvedValue({
            bytes: await png(1_200, 1_600),
            mimeType: "image/png",
        });
        const business = await startCrtBusinessApi({
            directory,
            imageClient: { edit },
        });
        cleanups.push(business.close);
        const capability = new HttpPhotoPosterRenderingCapability({
            baseUrl: business.url,
            timeoutMs: 10_000,
        });
        const output = await capability.render(
            {
                sourceImageUrl,
                prompt,
                style: "travel-abstraction",
                archive: {
                    number: 1,
                    date: "2026-09-07",
                    phrase: "QUIET PAWS",
                },
            },
            { idempotencyKey: "travel", signal: new AbortController().signal },
        );
        expect(output).toMatchObject({ width: 1_200, height: 1_600 });
        expect(downloadSourcePhoto).not.toHaveBeenCalled();
        expect(edit.mock.calls[0]?.[0]).toHaveProperty(
            "imageUrl",
            sourceImageUrl,
        );
        expect(edit.mock.calls[0]?.[0]).not.toHaveProperty("image");
        const final = Buffer.from(
            await (await fetch(output.url)).arrayBuffer(),
        );
        expect(
            await sharp(final)
                .extract({ left: 0, top: 0, width: 640, height: 480 })
                .removeAlpha()
                .raw()
                .toBuffer(),
        ).not.toEqual((await decodeSourcePhoto(source)).data);
    }, 15_000);
    it("拒绝不可解码参考图，档案字样不改变成品尺寸", async () => {
        await expect(
            decodeSourcePhoto(Buffer.from("invalid")),
        ).rejects.toThrow();
        const final = await finalizeTravelPhoto(await png(1_200, 1_600), {
            number: 9,
            date: "2026-09-07",
            phrase: "QUIET PAWS",
        });
        expect(await sharp(final).metadata()).toMatchObject({
            width: 1_200,
            height: 1_600,
        });
    });
});
