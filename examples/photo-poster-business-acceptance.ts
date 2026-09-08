import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { constructProcessingService } from "../src/app/api.js";
import { startLocalCrtBusinessApi } from "../src/business-api/crt-server.js";
import { createImageGenerationClient } from "../src/business-api/image-generation-config.js";
import { createObjectStorageFromEnvironment } from "../src/business-api/object-storage-config.js";
import { decodeSourcePhoto } from "../src/business-api/photo-poster.js";
import { downloadSourcePhoto } from "../src/business-api/source-photo.js";
import {
    photoPosterImageSchema,
    sourcePhotoSchema,
} from "../src/processes/photo-poster/capability.js";
import { createPhotoPosterSkillRefs } from "../src/processes/photo-poster/skills.js";
import {
    photoPosterNames,
    photoPosterProcessId,
    photoPosterStyles,
} from "../src/processes/photo-poster/style.js";

const sourceImageUrl = sourcePhotoSchema.parse(
    process.env.PHOTO_POSTER_SOURCE_IMAGE_URL,
);
const directory = resolve(
    "artifacts/photo-poster-acceptance",
    String(Date.now()),
);
await mkdir(directory, { recursive: true });
const timeoutMs = 240_000;
const selected = process.env.PHOTO_POSTER_ACCEPTANCE_STYLES?.split(",");
if (
    selected?.some(
        (style) =>
            !photoPosterStyles.includes(
                style as (typeof photoPosterStyles)[number],
            ),
    )
)
    throw new Error("未知验收风格");
const styles = photoPosterStyles.filter(
    (style) => !selected || selected.includes(style),
);
const source = await downloadSourcePhoto(
    sourceImageUrl,
    AbortSignal.timeout(30_000),
);
const original = await decodeSourcePhoto(source);
await writeFile(
    join(directory, "source.png"),
    await sharp(original.data, { raw: original.info }).png().toBuffer(),
);
const generation = createImageGenerationClient(process.env, {
    timeoutMs: 180_000,
});
if (generation.provider !== "fal")
    throw new Error("验收需要 IMAGE_PROVIDER=fal");
const storage = createObjectStorageFromEnvironment(process.env);
const calls: Array<Record<string, unknown>> = [];
const uploads: Array<{ url: string; sha256: string }> = [];
const businessApi = await startLocalCrtBusinessApi({
    directory: join(directory, "business"),
    provider: generation.provider,
    model: "gpt-image-2",
    quality: "low",
    imageClient: {
        edit: async (request) => {
            const evidence: Record<string, unknown> = {
                model: request.model,
                reference: request.image ? "locked-rgb" : "public-url",
                size: request.size,
            };
            calls.push(evidence);
            const started = Date.now();
            try {
                const result = await generation.client.edit(request);
                Object.assign(evidence, {
                    requestId: result.requestId,
                    durationMs: Date.now() - started,
                    sha256: sha256(result.bytes),
                });
                return result;
            } catch (error) {
                Object.assign(evidence, {
                    failed: true,
                    durationMs: Date.now() - started,
                    error: error instanceof Error ? error.name : "Error",
                });
                throw error;
            }
        },
    },
    ...(storage
        ? {
              storage: {
                  provider: storage.provider,
                  upload: async (request, options) => {
                      const result = await storage.upload(request, options);
                      uploads.push({
                          url: result.url,
                          sha256: sha256(request.bytes),
                      });
                      return result;
                  },
              },
          }
        : {}),
});
let application:
    | ReturnType<typeof constructProcessingService>["application"]
    | undefined;
const results: Array<Record<string, unknown>> = [];
try {
    application = constructProcessingService({
        ...process.env,
        NODE_ENV: "development",
        BUSINESS_API_BASE_URL: businessApi.url,
        PROCESS_TIMEOUT_MS: String(timeoutMs),
        PHOTO_POSTER_API_TIMEOUT_MS: "200000",
        ASYNC_PROCESS_RUNS_ENABLED: "false",
        CONSOLE_ENABLED: "false",
        PROCESS_RUN_RECORD_STORE: "file",
        PROCESS_RUN_RECORD_DIRECTORY: "",
        INTERNAL_EVAL_ENABLED: "false",
    }).application;
    const { url } = await application.listen();
    for (const style of styles) {
        console.log(JSON.stringify({ started: style }));
        const started = Date.now();
        const before = calls.length;
        const item: Record<string, unknown> = {
            style,
            process: photoPosterProcessId(style),
            skill: createPhotoPosterSkillRefs(style)[0],
            passed: false,
        };
        try {
            const response = await fetch(`${url}/execute`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    process: photoPosterProcessId(style),
                    version: "v1",
                    input: {
                        sourceImageUrl,
                        ...(style === "travel-abstraction"
                            ? {
                                  phrase: "QUIET AFTERNOON",
                                  capturedOn: "2026-09-07",
                                  archiveNumber: 1,
                              }
                            : {}),
                    },
                }),
                signal: AbortSignal.timeout(timeoutMs + 10_000),
            });
            const result = await response.json();
            Object.assign(item, {
                httpStatus: response.status,
                runId: result.runId,
                status: result.status,
                errorCode: result.error?.code,
            });
            if (response.status !== 200 || result.status !== "succeeded")
                throw new Error("Process 执行失败");
            const output = photoPosterImageSchema.parse(result.output.image);
            const stored = uploads.find((entry) => entry.url === output.url);
            if (
                storage
                    ? !stored
                    : new URL(output.url).origin !==
                      new URL(businessApi.url).origin
            )
                throw new Error("图片地址不属于本次存储结果");
            const downloaded = await fetch(output.url, {
                redirect: "error",
                signal: AbortSignal.timeout(30_000),
            });
            if (!downloaded.ok) throw new Error("结果下载失败");
            const bytes = Buffer.from(await downloaded.arrayBuffer());
            const local = await readFile(
                join(
                    directory,
                    "business",
                    "photo-posters",
                    `${result.runId}.png`,
                ),
            );
            const metadata = await sharp(bytes).metadata();
            const hash = sha256(bytes);
            const dimensionsMatch =
                metadata.width === output.width &&
                metadata.height === output.height &&
                output.width === 1_200 &&
                output.height === 1_600;
            const passed =
                metadata.format === "png" &&
                dimensionsMatch &&
                hash === sha256(local) &&
                (!stored || hash === stored.sha256) &&
                calls.length - before === 1;
            await writeFile(join(directory, `${style}.png`), bytes);
            Object.assign(item, {
                passed,
                width: metadata.width,
                height: metadata.height,
                bytes: bytes.length,
                sha256: hash,
            });
        } catch {
            item.passed = false;
        }
        Object.assign(item, {
            durationMs: Date.now() - started,
            imageCalls: calls.slice(before),
        });
        results.push(item);
        await writeReport();
        console.log(
            JSON.stringify({
                style,
                passed: item.passed,
                durationMs: item.durationMs,
                errorCode: item.errorCode,
            }),
        );
    }
} finally {
    await Promise.allSettled([application?.close(), businessApi.close()]);
    await writeReport();
}
if (results.length !== styles.length || results.some((item) => !item.passed))
    process.exitCode = 1;
console.log(
    JSON.stringify({
        directory,
        imageCalls: calls.length,
        stored: uploads.length,
    }),
);

async function writeReport() {
    await writeFile(
        join(directory, "report.json"),
        `${JSON.stringify({ sourceSha256: sha256(sourceImageUrl), sourceAttribution: process.env.PHOTO_POSTER_SOURCE_ATTRIBUTION, provider: generation.provider, model: "gpt-image-2", agentModel: process.env.PI_MODEL, storage: storage?.provider ?? "local-filesystem", calls: calls.length, results }, null, 2)}\n`,
    );
    await writeFile(
        join(directory, "report.md"),
        [
            "# 照片海报真实验收",
            "",
            `来源：${process.env.PHOTO_POSTER_SOURCE_ATTRIBUTION ?? "调用方提供的验收照片"}`,
            "",
            "本地正式 /execute → 固定 Runtime Skill → FAL GPT Image 2 → 配置存储。只返回独立风格化成品，原图仅作参考。每项一次图片调用，无自动重绘；结果仅代表本次样图。",
            "",
            "## 验收参考图（不属于产品输出）",
            "",
            `![参考照片](${join(directory, "source.png").replaceAll("\\", "/")})`,
            "",
            ...results.flatMap((item) => [
                `## ${photoPosterNames[item.style as keyof typeof photoPosterNames]}`,
                "",
                `技术验证：${item.passed ? "通过" : "失败"}；耗时 ${Number(item.durationMs) / 1000} 秒。`,
                "",
                ...(item.passed
                    ? [
                          `![${item.style}](${join(directory, `${item.style}.png`).replaceAll("\\", "/")})`,
                          "",
                      ]
                    : []),
            ]),
        ].join("\n"),
    );
}
function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
