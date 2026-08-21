/** 校验部署环境后装配 CRT 图像生成、对象存储与证据策略，启动 CRT Business API */
import { assertDeploymentEnvironment } from "../app/deployment-environment.js";
import { resolveCrtEvidencePolicy } from "../business-api/crt-evidence.js";
import { startCrtBusinessApi } from "../business-api/crt-server.js";
import { createImageGenerationClient } from "../business-api/image-generation-config.js";
import { createObjectStorageFromEnvironment } from "../business-api/object-storage-config.js";
import type { GptImageQuality } from "../business-api/openai-image-generation.js";

assertDeploymentEnvironment(process.env, "crt-business-api");

const port = portNumber(process.env.CRT_BUSINESS_API_PORT);
const host = process.env.CRT_BUSINESS_API_HOST?.trim() || "127.0.0.1";
const timeoutMs = positiveInteger(process.env.CRT_IMAGE_TIMEOUT_MS, 180_000);
const imageGeneration = createImageGenerationClient(process.env, { timeoutMs });
if (imageGeneration.provider !== "fal") {
    throw new Error(
        "The production CRT Business API requires IMAGE_PROVIDER=fal",
    );
}
const storage = createObjectStorageFromEnvironment(process.env);
if (!storage) {
    throw new Error(
        "The production CRT Business API requires OBJECT_STORAGE_PROVIDER=aliyun-oss",
    );
}

const application = await startCrtBusinessApi(
    {
        directory:
            process.env.CRT_IMAGE_WORK_DIRECTORY?.trim() ||
            "/tmp/pipipi-crt-business",
        imageClient: imageGeneration.client,
        generationClient: imageGeneration.client,
        provider: imageGeneration.provider,
        model: process.env.CRT_IMAGE_MODEL?.trim() || "gpt-image-2",
        quality: quality(process.env.CRT_IMAGE_QUALITY),
        evidencePolicy: resolveCrtEvidencePolicy(process.env, {
            defaultMode: "off",
            defaultDirectory: "/tmp/pipipi-crt-evidence",
        }),
        storage,
        objectPrefix: process.env.CRT_IMAGE_OBJECT_PREFIX,
    },
    { host, port },
);

console.log(`CRT Business API listening at ${application.url}`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        if (closing) return;
        closing = true;
        void application.close().finally(() => process.exit(0));
    });
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("CRT Business API numeric configuration is invalid");
    }
    return parsed;
}

function portNumber(value: string | undefined): number {
    const port = positiveInteger(value, 4400);
    if (port > 65_535) throw new Error("CRT_BUSINESS_API_PORT is invalid");
    return port;
}

function quality(value: string | undefined): GptImageQuality {
    const candidate = value?.trim() || "low";
    if (["low", "medium", "high", "auto"].includes(candidate)) {
        return candidate as GptImageQuality;
    }
    throw new Error("CRT_IMAGE_QUALITY must be low, medium, high, or auto");
}
