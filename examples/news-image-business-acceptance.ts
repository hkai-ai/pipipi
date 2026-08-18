import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseOpenAIApiMode } from "../src/agent-runtime/pi.js";
import { constructProcessingService } from "../src/app/api.js";
import {
    createNewsImageAcceptance,
    type NewsImageAcceptanceRun,
} from "../src/app/news-image-acceptance.js";
import { startLocalCrtBusinessApi } from "../src/business-api/crt-server.js";
import { createImageGenerationClient } from "../src/business-api/image-generation-config.js";
import { createObjectStorageFromEnvironment } from "../src/business-api/object-storage-config.js";

const evidenceFile = resolve(
    process.env.NEWS_IMAGE_ACCEPTANCE_EVIDENCE_FILE ??
        "artifacts/news-image-acceptance/evidence.json",
);
const startedAt = new Date().toISOString();
const rawRevision = process.env.NEWS_IMAGE_ACCEPTANCE_REVISION?.trim() ?? "";
const revision = /^[0-9a-f]{40}$/u.test(rawRevision) ? rawRevision : "unknown";
const rawCostLimit =
    process.env.NEWS_IMAGE_ACCEPTANCE_COST_LIMIT_USD?.trim() ?? "";
const costLimit = /^\d{1,4}\.\d{2}$/u.test(rawCostLimit)
    ? rawCostLimit
    : "unknown";
const rawCostReference =
    process.env.NEWS_IMAGE_ACCEPTANCE_COST_APPROVAL_REFERENCE?.trim() ?? "";
const costReference = /^[A-Za-z0-9._:/-]{1,128}$/u.test(rawCostReference)
    ? rawCostReference
    : "unknown";
let imageGenerationAttempts = 0;
let completedProcessRuns: readonly NewsImageAcceptanceRun[] = [];
let application:
    | ReturnType<typeof constructProcessingService>["application"]
    | undefined;
let businessApi:
    | Awaited<ReturnType<typeof startLocalCrtBusinessApi>>
    | undefined;
let temporaryDirectory: string | undefined;

let evidence: SuccessEvidence | FailureEvidence;
try {
    const approval = parseApproval();
    if (process.env.IMAGE_PROVIDER?.trim() !== "fal") {
        throw new Error("News image acceptance requires FAL");
    }
    if (process.env.OBJECT_STORAGE_PROVIDER?.trim() !== "aliyun-oss") {
        throw new Error("News image acceptance requires Aliyun OSS");
    }
    const agentProvider = required("PI_PROVIDER");
    const agentModel = required("PI_MODEL");
    const imageModel = process.env.CRT_IMAGE_MODEL?.trim() || "gpt-image-2";
    if (imageModel !== "gpt-image-2") {
        throw new Error("News image acceptance requires gpt-image-2");
    }
    const agentTimeoutMs = positiveInteger(
        process.env.NEWS_IMAGE_ACCEPTANCE_AGENT_TIMEOUT_MS ?? "120000",
        "NEWS_IMAGE_ACCEPTANCE_AGENT_TIMEOUT_MS",
    );
    const imageTimeoutMs = positiveInteger(
        process.env.NEWS_IMAGE_ACCEPTANCE_IMAGE_TIMEOUT_MS ?? "240000",
        "NEWS_IMAGE_ACCEPTANCE_IMAGE_TIMEOUT_MS",
    );
    const processTimeoutMs = positiveInteger(
        process.env.NEWS_IMAGE_ACCEPTANCE_PROCESS_TIMEOUT_MS ??
            String(agentTimeoutMs + imageTimeoutMs + 30_000),
        "NEWS_IMAGE_ACCEPTANCE_PROCESS_TIMEOUT_MS",
    );
    const imageGeneration = createImageGenerationClient(process.env, {
        timeoutMs: imageTimeoutMs,
    });
    if (imageGeneration.provider !== "fal") {
        throw new Error("News image acceptance image provider is invalid");
    }
    const storage = createObjectStorageFromEnvironment(process.env);
    if (!storage) {
        throw new Error("News image acceptance storage is unavailable");
    }
    const generationClient = Object.freeze({
        generate: async (
            request: Parameters<typeof imageGeneration.client.generate>[0],
        ) => {
            imageGenerationAttempts += 1;
            if (imageGenerationAttempts > 3) {
                throw new Error(
                    "News image acceptance exceeded its generation budget",
                );
            }
            return imageGeneration.client.generate(request);
        },
        edit: (request: Parameters<typeof imageGeneration.client.edit>[0]) =>
            imageGeneration.client.edit(request),
    });
    temporaryDirectory = await mkdtemp(
        join(tmpdir(), "pipipi-news-image-acceptance-"),
    );
    businessApi = await startLocalCrtBusinessApi({
        directory: temporaryDirectory,
        imageClient: generationClient,
        generationClient,
        provider: imageGeneration.provider,
        model: imageModel,
        quality: "low",
        storage,
    });
    const constructed = constructProcessingService({
        ...process.env,
        BUSINESS_API_BASE_URL: businessApi.url,
        CRT_BUSINESS_API_BASE_URL: businessApi.url,
        PI_PROVIDER: agentProvider,
        PI_MODEL: agentModel,
        OPENAI_API_MODE: parseOpenAIApiMode(process.env.OPENAI_API_MODE),
        NEWS_IMAGE_API_TIMEOUT_MS: String(imageTimeoutMs + 20_000),
        PROCESS_TIMEOUT_MS: String(processTimeoutMs),
        PROCESS_RUN_LOG_LEVEL: "silent",
        ASYNC_PROCESS_RUNS_ENABLED: "false",
    });
    application = constructed.application;
    const { url } = await application.listen();
    const result = await createNewsImageAcceptance({
        baseUrl: url,
        expectedOssHost: required("NEWS_IMAGE_ACCEPTANCE_EXPECTED_OSS_HOST"),
        expectedOssPathPrefix: required(
            "NEWS_IMAGE_ACCEPTANCE_EXPECTED_OSS_PATH_PREFIX",
        ),
        timeoutMs: processTimeoutMs + 30_000,
    }).run();
    completedProcessRuns = result.processRuns;
    if (imageGenerationAttempts !== 3) {
        throw new Error(
            "News image acceptance did not use exactly three generations",
        );
    }
    evidence = Object.freeze({
        schemaVersion: 1,
        event: "news_image_business_acceptance_completed",
        revision: approval.revision,
        status: "succeeded",
        startedAt,
        completedAt: new Date().toISOString(),
        providers: Object.freeze({
            agent: agentProvider,
            image: imageGeneration.provider,
            storage: "aliyun-oss",
        }),
        processRuns: result.processRuns,
        totals: Object.freeze({
            processRuns: result.processRuns.length,
            imageGenerationAttempts,
        }),
        costApproval: approval.costApproval,
    });
} catch {
    evidence = Object.freeze({
        schemaVersion: 1,
        event: "news_image_business_acceptance_completed",
        revision,
        status: "failed",
        failedGate: "preflight_or_acceptance",
        startedAt,
        completedAt: new Date().toISOString(),
        completedProcessRuns,
        imageGenerationAttempts,
        publicErrorCode: "NEWS_IMAGE_ACCEPTANCE_FAILED",
        costApproval: Object.freeze({
            currency: "USD",
            limit: costLimit,
            reference: costReference,
        }),
    });
} finally {
    await Promise.allSettled([
        application?.close() ?? Promise.resolve(),
        businessApi?.close() ?? Promise.resolve(),
    ]);
    if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
}

await writeEvidence(evidenceFile, evidence);
console.log(
    JSON.stringify({
        event: evidence.event,
        revision: evidence.revision,
        status: evidence.status,
        ...(evidence.status === "succeeded"
            ? { totals: evidence.totals, processRuns: evidence.processRuns }
            : {
                  failedGate: evidence.failedGate,
                  publicErrorCode: evidence.publicErrorCode,
                  imageGenerationAttempts: evidence.imageGenerationAttempts,
              }),
    }),
);
if (evidence.status !== "succeeded") process.exitCode = 1;

function parseApproval(): Readonly<{
    revision: string;
    costApproval: CostApproval;
}> {
    if (
        process.env.NEWS_IMAGE_ACCEPTANCE_COST_CONFIRMATION !==
        "APPROVE_THREE_NEWS_IMAGE_PROCESS_RUNS"
    ) {
        throw new Error("News image acceptance cost approval is required");
    }
    const checkedRevision = required("NEWS_IMAGE_ACCEPTANCE_REVISION");
    if (!/^[0-9a-f]{40}$/u.test(checkedRevision)) {
        throw new Error("News image acceptance revision is invalid");
    }
    const checkedCostLimit = required("NEWS_IMAGE_ACCEPTANCE_COST_LIMIT_USD");
    if (
        !/^(?:0|[1-9][0-9]{0,3})\.\d{2}$/u.test(checkedCostLimit) ||
        Number(checkedCostLimit) <= 0
    ) {
        throw new Error("News image acceptance cost limit is invalid");
    }
    const checkedReference = required(
        "NEWS_IMAGE_ACCEPTANCE_COST_APPROVAL_REFERENCE",
    );
    if (!/^[A-Za-z0-9._:/-]{1,128}$/u.test(checkedReference)) {
        throw new Error("News image acceptance cost reference is invalid");
    }
    return Object.freeze({
        revision: checkedRevision,
        costApproval: Object.freeze({
            currency: "USD",
            limit: checkedCostLimit,
            reference: checkedReference,
        }),
    });
}

async function writeEvidence(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, file);
}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function positiveInteger(value: string, name: string): number {
    if (!/^[1-9][0-9]*$/u.test(value)) {
        throw new Error(`${name} must be a positive integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${name} must be a safe integer`);
    }
    return parsed;
}

type CostApproval = Readonly<{
    currency: "USD";
    limit: string;
    reference: string;
}>;

type SuccessEvidence = Readonly<{
    schemaVersion: 1;
    event: "news_image_business_acceptance_completed";
    revision: string;
    status: "succeeded";
    startedAt: string;
    completedAt: string;
    providers: Readonly<{
        agent: string;
        image: "fal";
        storage: "aliyun-oss";
    }>;
    processRuns: readonly NewsImageAcceptanceRun[];
    totals: Readonly<{
        processRuns: number;
        imageGenerationAttempts: number;
    }>;
    costApproval: CostApproval;
}>;

type FailureEvidence = Readonly<{
    schemaVersion: 1;
    event: "news_image_business_acceptance_completed";
    revision: string;
    status: "failed";
    failedGate: "preflight_or_acceptance";
    startedAt: string;
    completedAt: string;
    completedProcessRuns: readonly NewsImageAcceptanceRun[];
    imageGenerationAttempts: number;
    publicErrorCode: "NEWS_IMAGE_ACCEPTANCE_FAILED";
    costApproval: CostApproval;
}>;
