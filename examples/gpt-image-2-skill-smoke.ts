import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    getAgentDir,
    loadSkillsFromDir,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
    configureOpenAIProvider,
    type OpenAIApiMode,
    parseOpenAIApiMode,
} from "../src/processes/content/agent.js";
import type { StoredObject } from "./support/object-storage.js";
import { createObjectStorageFromEnvironment } from "./support/object-storage-config.js";
import {
    type GeneratedImage,
    type GptImageOutputFormat,
    type GptImageQuality,
    OpenAIImageGenerationClient,
} from "./support/openai-image-generation.js";

const posterSkillName = "gc-minimal-zine-poster-v0-1";
const posterSkillDirectory = resolve(
    process.env.GPT_IMAGE_SKILL_DIRECTORY ??
        ".agents/skills/gc-minimal-zine-poster-v0-1",
);
const reportDirectory = resolve(
    process.env.GPT_IMAGE_REPORT_DIRECTORY ?? "artifacts/gpt-image-2",
);
const theme =
    process.env.GPT_IMAGE_THEME?.trim() ||
    "Create a quiet minimal zine poster about a rainy used bookstore. Include the exact text PIPIPI ZINE.";
const requiredText =
    process.env.GPT_IMAGE_REQUIRED_TEXT?.trim() || "PIPIPI ZINE";
const provider = process.env.PI_PROVIDER ?? "openai";
const agentModel = process.env.PI_MODEL ?? "gpt-5.6-terra";
const imageModel = process.env.GPT_IMAGE_MODEL ?? "gpt-image-2";
const imageSize = process.env.GPT_IMAGE_SIZE ?? "1024x1696";
const imageQuality = parseQuality(process.env.GPT_IMAGE_QUALITY);
const imageOutputFormat = parseOutputFormat(
    process.env.GPT_IMAGE_OUTPUT_FORMAT,
);
const imageTimeoutMs = parsePositiveInteger(
    process.env.GPT_IMAGE_TIMEOUT_MS,
    180_000,
    "GPT_IMAGE_TIMEOUT_MS",
);
const agentTimeoutMs = parsePositiveInteger(
    process.env.GPT_IMAGE_AGENT_TIMEOUT_MS,
    120_000,
    "GPT_IMAGE_AGENT_TIMEOUT_MS",
);
const openAIApiMode = parseOpenAIApiMode(process.env.OPENAI_API_MODE);
const imageObjectPrefix =
    process.env.GPT_IMAGE_OBJECT_PREFIX?.trim() || "gpt-image-2";
const objectStorage = createObjectStorageFromEnvironment(process.env);

const compiledPosterSchema = z
    .object({
        prompt: z.string().trim().min(80),
        recipe: z.string().trim().min(3),
        interpretation: z.string().trim().min(1),
    })
    .strict();

type CompiledPoster = z.infer<typeof compiledPosterSchema>;

type SmokeCheck = {
    criterion: string;
    passed: boolean;
};

type SmokeReport = {
    generatedAt: string;
    passed: boolean;
    theme: string;
    requiredText: string;
    skill: {
        name: string;
        directory: string;
        file: string;
        sha256: string;
        source: string;
    };
    agent: {
        provider: string;
        model: string;
        apiMode: OpenAIApiMode;
        durationMs?: number;
        error?: string;
    };
    compiled: CompiledPoster & {
        source: "skill-agent" | "code-fallback";
    };
    image: {
        model: string;
        requestedSize: string;
        quality: GptImageQuality;
        requestedOutputFormat: GptImageOutputFormat;
        durationMs?: number;
        file?: string;
        bytes?: number;
        sha256?: string;
        mimeType?: string;
        outputFormat?: GptImageOutputFormat;
        width?: number;
        height?: number;
        requestId?: string;
        usage?: GeneratedImage["usage"];
        error?: string;
    };
    storage?: {
        provider: string;
        durationMs?: number;
        bucket?: string;
        objectKey?: string;
        url?: string;
        urlAccess?: StoredObject["urlAccess"];
        urlExpiresAt?: string;
        etag?: string;
        requestId?: string;
        error?: string;
    };
    checks: SmokeCheck[];
};

const skillLoad = loadSkillsFromDir({
    dir: posterSkillDirectory,
    source: "gpt-image-2-smoke-test",
});
const posterSkills = skillLoad.skills.filter(
    (skill) => skill.name === posterSkillName,
);
if (posterSkills.length !== 1) {
    throw new Error("The minimal zine poster Skill is unavailable");
}
const posterSkill = posterSkills[0];
if (!posterSkill)
    throw new Error("The minimal zine poster Skill is unavailable");
const skillSource = await readFile(posterSkill.filePath, "utf8");
const skillSha256 = sha256(skillSource);

let compiled: CompiledPoster;
let compiledSource: SmokeReport["compiled"]["source"] = "skill-agent";
let agentDurationMs: number | undefined;
let agentError: string | undefined;
const agentStartedAt = performance.now();
try {
    compiled = await compilePosterWithSkill({
        theme,
        requiredText,
        posterSkill,
        apiMode: openAIApiMode,
    });
    agentDurationMs = Math.round(performance.now() - agentStartedAt);
} catch (error) {
    agentDurationMs = Math.round(performance.now() - agentStartedAt);
    agentError = formatErrorChain(error);
    compiledSource = "code-fallback";
    compiled = fallbackPoster(theme, requiredText);
}

let image: GeneratedImage | undefined;
let imagePath: string | undefined;
let imageDurationMs: number | undefined;
let imageError: string | undefined;
const imageStartedAt = performance.now();
try {
    const imageClient = new OpenAIImageGenerationClient({
        apiKey: requiredEnvironmentVariable("OPENAI_API_KEY"),
        baseUrl: process.env.OPENAI_BASE_URL,
        timeoutMs: imageTimeoutMs,
    });
    image = await imageClient.generate({
        prompt: compiled.prompt,
        model: imageModel,
        size: imageSize,
        quality: imageQuality,
        outputFormat: imageOutputFormat,
    });
    imageDurationMs = Math.round(performance.now() - imageStartedAt);
    await mkdir(reportDirectory, { recursive: true });
    imagePath = join(reportDirectory, `latest.${image.outputFormat}`);
    await writeFile(imagePath, image.bytes);
} catch (error) {
    imageDurationMs = Math.round(performance.now() - imageStartedAt);
    imageError = formatErrorChain(error);
}

let storedObject: StoredObject | undefined;
let storageObjectKey: string | undefined;
let storageDurationMs: number | undefined;
let storageError: string | undefined;
if (objectStorage) {
    if (image) {
        storageObjectKey = `${imageObjectPrefix}/${sha256(image.bytes)}.${image.outputFormat}`;
        const storageStartedAt = performance.now();
        try {
            storedObject = await objectStorage.upload({
                objectKey: storageObjectKey,
                bytes: image.bytes,
                contentType: image.mimeType,
            });
        } catch (error) {
            storageError = formatErrorChain(error);
        } finally {
            storageDurationMs = Math.round(
                performance.now() - storageStartedAt,
            );
        }
    } else {
        storageError = "No generated image was available to upload";
    }
}

const checks = evaluateSmoke({
    compiled,
    compiledSource,
    requiredText,
    image,
    imageError,
    storageExpected: objectStorage !== undefined,
    storedObject,
    storageError,
});
const report: SmokeReport = {
    generatedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    theme,
    requiredText,
    skill: {
        name: posterSkill.name,
        directory: posterSkillDirectory,
        file: posterSkill.filePath,
        sha256: skillSha256,
        source: "https://github.com/LiamGvchi/gc-minimal-zine-poster",
    },
    agent: {
        provider,
        model: agentModel,
        apiMode: openAIApiMode,
        ...(agentDurationMs === undefined
            ? {}
            : { durationMs: agentDurationMs }),
        ...(agentError ? { error: agentError } : {}),
    },
    compiled: { ...compiled, source: compiledSource },
    image: {
        model: imageModel,
        requestedSize: imageSize,
        quality: imageQuality,
        requestedOutputFormat: imageOutputFormat,
        ...(imageDurationMs === undefined
            ? {}
            : { durationMs: imageDurationMs }),
        ...(imagePath ? { file: imagePath } : {}),
        ...(image
            ? {
                  bytes: image.bytes.length,
                  sha256: sha256(image.bytes),
                  mimeType: image.mimeType,
                  outputFormat: image.outputFormat,
                  ...(image.width === undefined ? {} : { width: image.width }),
                  ...(image.height === undefined
                      ? {}
                      : { height: image.height }),
                  ...(image.requestId ? { requestId: image.requestId } : {}),
                  ...(image.usage ? { usage: image.usage } : {}),
              }
            : {}),
        ...(imageError ? { error: imageError } : {}),
    },
    ...(objectStorage
        ? {
              storage: {
                  provider: objectStorage.provider,
                  ...(storageDurationMs === undefined
                      ? {}
                      : { durationMs: storageDurationMs }),
                  ...(storageObjectKey ? { objectKey: storageObjectKey } : {}),
                  ...(storedObject
                      ? {
                            bucket: storedObject.bucket,
                            objectKey: storedObject.objectKey,
                            url: storedObject.url,
                            urlAccess: storedObject.urlAccess,
                            ...(storedObject.urlExpiresAt
                                ? { urlExpiresAt: storedObject.urlExpiresAt }
                                : {}),
                            ...(storedObject.etag
                                ? { etag: storedObject.etag }
                                : {}),
                            ...(storedObject.requestId
                                ? { requestId: storedObject.requestId }
                                : {}),
                        }
                      : {}),
                  ...(storageError ? { error: storageError } : {}),
              },
          }
        : {}),
    checks,
};
const reportFiles = await writeSmokeReport(report);

console.log(
    JSON.stringify(
        {
            passed: report.passed,
            promptSource: report.compiled.source,
            skillSha256: report.skill.sha256,
            image: {
                model: report.image.model,
                file: report.image.file,
                bytes: report.image.bytes,
                dimensions:
                    report.image.width && report.image.height
                        ? `${report.image.width}x${report.image.height}`
                        : undefined,
                requestId: report.image.requestId,
                error: report.image.error,
            },
            storage: report.storage,
            checks: report.checks,
            reportFiles,
        },
        null,
        2,
    ),
);
if (!report.passed) process.exitCode = 1;

async function compilePosterWithSkill(options: {
    theme: string;
    requiredText: string;
    posterSkill: (typeof posterSkills)[number];
    apiMode: OpenAIApiMode;
}): Promise<CompiledPoster> {
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    if (process.env.OPENAI_BASE_URL) {
        configureOpenAIProvider(modelRuntime, {
            baseUrl: process.env.OPENAI_BASE_URL,
            apiMode: options.apiMode,
            modelId: agentModel,
        });
    }
    const selectedModel = modelRuntime.getModel(provider, agentModel);
    if (!selectedModel) {
        throw new Error(
            `Model ${provider}/${agentModel} is not present in the Pi model catalog`,
        );
    }
    if (!(await modelRuntime.checkAuth(provider))) {
        throw new Error(`Credentials for ${provider} are not configured`);
    }

    const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt:
            "You compile a business brief into an image prompt. Follow the loaded Skill. Return only the requested strict JSON.",
        skillsOverride: () => ({
            skills: [options.posterSkill],
            diagnostics: skillLoad.diagnostics,
        }),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        modelRuntime,
        model: selectedModel,
        ...(selectedModel.api === "openai-completions"
            ? { thinkingLevel: "off" as const }
            : {}),
        resourceLoader,
        sessionManager: SessionManager.inMemory(process.cwd()),
        customTools: [],
        tools: [],
    });
    const timeoutSignal = AbortSignal.timeout(agentTimeoutMs);
    const abortSession = () => {
        void session.abort();
    };
    timeoutSignal.addEventListener("abort", abortSession, { once: true });

    try {
        await session.prompt(
            `/skill:${posterSkillName} Compile this business brief: ${JSON.stringify(options.theme)}\n` +
                "This is the prompt-compilation stage of a code-defined process. The next stage calls the Images API directly, so do not generate an image here. " +
                `The final image prompt must preserve the exact text ${JSON.stringify(options.requiredText)}. ` +
                "Use the Skill's four-paragraph Standard Mode prompt shape. " +
                "Return only strict JSON matching " +
                '{"prompt":"four paragraphs separated by blank lines","recipe":"layout / anchor / typography / accent / texture / mood","interpretation":"one short sentence"}.',
        );
        if (timeoutSignal.aborted) throw new Error("Poster Agent timed out");
        return compiledPosterSchema.parse(
            parseLastAssistantJson(session.messages),
        );
    } finally {
        timeoutSignal.removeEventListener("abort", abortSession);
        session.dispose();
    }
}

function fallbackPoster(
    sourceTheme: string,
    exactText: string,
): CompiledPoster {
    return {
        prompt:
            `Create a tall vertical 3:5 poster on full-frame warm aged paper with no border or mockup. Keep 80% negative space and place one small visual cluster in the lower-left quadrant, occupying about 15% of the canvas.\n\n` +
            `Translate this brief into one imageable object: ${sourceTheme} Use a torn grayscale bookstore-window clipping softened by halftone wear and rough paper edges.\n\n` +
            `Set the exact short text ${JSON.stringify(exactText)} in small typewriter lettering beside the clipping. Add one fully saturated cobalt-blue risograph block covering about 2% of the canvas, with light ink bleed and misregistration.\n\n` +
            "Render a flat orthographic paper scan with matte fibers, diffuse light, quiet archival nostalgia, and no commercial headline, logo, CTA, glossy mockup, 3D depth, cinematic lighting, neon, cartoon styling, or dense scrapbook decoration.",
        recipe: "lower-left-float / torn-paper clipping / short phrase pressed against image edge / cobalt-blue block / halftone degradation / memory",
        interpretation:
            "A worn bookstore fragment turns the rainy brief into a quiet archival memory.",
    };
}

function evaluateSmoke(options: {
    compiled: CompiledPoster;
    compiledSource: SmokeReport["compiled"]["source"];
    requiredText: string;
    image: GeneratedImage | undefined;
    imageError: string | undefined;
    storageExpected: boolean;
    storedObject: StoredObject | undefined;
    storageError: string | undefined;
}): SmokeCheck[] {
    const prompt = options.compiled.prompt;
    const paragraphCount = prompt
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean).length;
    const ratio =
        options.image?.width && options.image.height
            ? options.image.width / options.image.height
            : undefined;

    const checks: SmokeCheck[] = [
        {
            criterion: "Pi Agent compiled the prompt from the installed Skill",
            passed: options.compiledSource === "skill-agent",
        },
        {
            criterion: "compiled prompt preserves the required test text",
            passed: prompt.includes(options.requiredText),
        },
        {
            criterion: "compiled prompt uses the Skill's four-paragraph shape",
            passed: paragraphCount === 4,
        },
        {
            criterion: "recipe records all six variation axes",
            passed: options.compiled.recipe.split("/").length >= 6,
        },
        {
            criterion: "prompt specifies a vertical 3:5 paper canvas",
            passed: /(?:vertical[^.\n]{0,30}3:5|3:5[^.\n]{0,30}vertical)/i.test(
                prompt,
            ),
        },
        {
            criterion: "prompt specifies large negative space",
            passed:
                /negative space/i.test(prompt) && /(?:7|8|9)\d%/.test(prompt),
        },
        {
            criterion: "prompt carries aged-paper and print-process details",
            passed:
                /aged paper|old paper|paper canvas/i.test(prompt) &&
                /xerox|risograph|halftone|letterpress|scan|ink bleed|misregistration/i.test(
                    prompt,
                ),
        },
        {
            criterion: "prompt names one saturated color anchor",
            passed:
                /saturated|high-chroma/i.test(prompt) &&
                /cobalt|ultramarine|cyan|violet|magenta|yellow|green|orange|red/i.test(
                    prompt,
                ),
        },
        {
            criterion: "GPT Image 2 API returned a raster image",
            passed:
                !options.imageError &&
                options.image !== undefined &&
                options.image.bytes.length > 10_000,
        },
        {
            criterion: "returned image keeps the requested 3:5 aspect ratio",
            passed: ratio !== undefined && Math.abs(ratio - 3 / 5) < 0.03,
        },
    ];
    if (options.storageExpected) {
        checks.push({
            criterion: "configured object storage returned an HTTPS object URL",
            passed:
                !options.storageError &&
                options.storedObject !== undefined &&
                options.storedObject.url.startsWith("https://"),
        });
    }
    return checks;
}

async function writeSmokeReport(report: SmokeReport): Promise<{
    json: string;
    markdown: string;
}> {
    await mkdir(reportDirectory, { recursive: true });
    const json = join(reportDirectory, "latest.json");
    const markdown = join(reportDirectory, "latest.md");
    await Promise.all([
        writeFile(json, `${JSON.stringify(report, null, 2)}\n`),
        writeFile(markdown, renderSmokeReport(report)),
    ]);
    return { json, markdown };
}

function renderSmokeReport(report: SmokeReport): string {
    const lines = [
        "# GPT Image 2 + Poster Skill Smoke Test",
        "",
        `- Result: **${report.passed ? "PASS" : "FAIL"}**`,
        `- Generated at: ${report.generatedAt}`,
        `- Agent: \`${report.agent.provider}/${report.agent.model}\` via \`${report.agent.apiMode}\``,
        `- Image model: \`${report.image.model}\``,
        `- Skill SHA-256: \`${report.skill.sha256}\``,
        "- Credentials and Base URL: omitted",
        "",
        "## Flow",
        "",
        report.storage
            ? "The code-defined test loads the poster Skill, asks Pi Agent to compile the business brief, calls the Images API directly, saves the raster image, uploads it through the configured object-storage capability, and checks observable evidence from each stage."
            : "The code-defined test loads the poster Skill, asks Pi Agent to compile the business brief, calls the Images API directly, saves the raster image, and checks observable evidence from each stage.",
        "",
        "## Business brief",
        "",
        fencedText(report.theme),
        "",
        "## Compiled prompt",
        "",
        `- Source: \`${report.compiled.source}\``,
        `- Recipe: ${report.compiled.recipe}`,
        `- Interpretation: ${report.compiled.interpretation}`,
        "",
        fencedText(report.compiled.prompt),
        "",
        "## Image API evidence",
        "",
        `- Requested: \`${report.image.model}\`, \`${report.image.requestedSize}\`, \`${report.image.quality}\`, \`${report.image.requestedOutputFormat}\``,
        `- Request ID: \`${report.image.requestId ?? "not returned"}\``,
        `- Bytes: ${report.image.bytes ?? "no image"}`,
        `- SHA-256: \`${report.image.sha256 ?? "no image"}\``,
        `- Detected: \`${report.image.mimeType ?? "no image"}\`, ${report.image.width ?? "?"}x${report.image.height ?? "?"}`,
        "",
    ];
    if (report.image.file) {
        lines.push(
            `![Generated minimal zine poster](${report.image.file})`,
            "",
        );
    }
    if (report.agent.error) {
        lines.push("## Agent error", "", fencedText(report.agent.error), "");
    }
    if (report.image.error) {
        lines.push(
            "## Image API error",
            "",
            fencedText(report.image.error),
            "",
        );
    }
    if (report.storage) {
        lines.push(
            "## Object storage evidence",
            "",
            `- Provider: \`${report.storage.provider}\``,
            `- Bucket: \`${report.storage.bucket ?? "upload failed"}\``,
            `- Object key: \`${report.storage.objectKey ?? "upload failed"}\``,
            `- URL access: \`${report.storage.urlAccess ?? "upload failed"}\``,
            `- URL expires at: \`${report.storage.urlExpiresAt ?? "does not expire"}\``,
            `- ETag: \`${report.storage.etag ?? "not returned"}\``,
            `- Request ID: \`${report.storage.requestId ?? "not returned"}\``,
            `- URL: ${report.storage.url ?? "upload failed"}`,
            "",
        );
    }
    if (report.storage?.error) {
        lines.push(
            "## Object storage error",
            "",
            fencedText(report.storage.error),
            "",
        );
    }
    lines.push("## Checks", "");
    for (const check of report.checks) {
        lines.push(`- [${check.passed ? "x" : " "}] ${check.criterion}`);
    }
    lines.push("", `Final verdict: **${report.passed ? "PASS" : "FAIL"}**`, "");
    return `${lines.join("\n")}\n`;
}

function parseLastAssistantJson(messages: readonly unknown[]): unknown {
    const message = messages.findLast(isAssistantMessage);
    if (
        !message ||
        message.stopReason === "error" ||
        message.stopReason === "aborted"
    ) {
        throw new Error(
            "The poster Agent did not produce a successful response",
            {
                ...(message?.errorMessage
                    ? { cause: new Error(message.errorMessage) }
                    : {}),
            },
        );
    }
    const text = message.content
        .filter(isTextContent)
        .map((part) => part.text)
        .join("")
        .trim();
    if (!text) throw new Error("The poster Agent response was empty");
    return JSON.parse(text);
}

function isAssistantMessage(value: unknown): value is {
    role: "assistant";
    content: unknown[];
    stopReason?: string;
    errorMessage?: string;
} {
    return (
        typeof value === "object" &&
        value !== null &&
        "role" in value &&
        value.role === "assistant" &&
        "content" in value &&
        Array.isArray(value.content)
    );
}

function isTextContent(value: unknown): value is {
    type: "text";
    text: string;
} {
    return (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "text" &&
        "text" in value &&
        typeof value.text === "string"
    );
}

function parseQuality(value: string | undefined): GptImageQuality {
    if (
        value === undefined ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "auto"
    ) {
        return value ?? "low";
    }
    throw new Error("GPT_IMAGE_QUALITY must be low, medium, high, or auto");
}

function parseOutputFormat(value: string | undefined): GptImageOutputFormat {
    if (
        value === undefined ||
        value === "png" ||
        value === "jpeg" ||
        value === "webp"
    ) {
        return value ?? "png";
    }
    throw new Error("GPT_IMAGE_OUTPUT_FORMAT must be png, jpeg, or webp");
}

function parsePositiveInteger(
    value: string | undefined,
    fallback: number,
    name: string,
): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function formatErrorChain(error: unknown): string {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && !seen.has(current)) {
        seen.add(current);
        messages.push(
            current instanceof Error ? current.message : String(current),
        );
        current = current instanceof Error ? current.cause : undefined;
    }
    const chain = messages.join(" <- caused by: ");
    return chain.length <= 1_000 ? chain : `${chain.slice(0, 1_000)}…`;
}

function fencedText(value: string): string {
    const fence = value.includes("```") ? "````" : "```";
    return `${fence}text\n${value}\n${fence}`;
}
