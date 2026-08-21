/** 从环境变量装配 AliyunOssStorage：解析 OSS_* 配置并按 OBJECT_STORAGE_PROVIDER 决定是否启用 */
import {
    AliyunOssStorage,
    type AliyunOssStorageDependencies,
} from "./aliyun-oss-storage.js";
import type {
    ObjectStorageCapability,
    ObjectUrlAccess,
} from "./object-storage.js";

export type ObjectStorageEnvironment = Record<string, string | undefined>;

export function createObjectStorageFromEnvironment(
    environment: ObjectStorageEnvironment = process.env,
    dependencies: AliyunOssStorageDependencies = {},
): ObjectStorageCapability | undefined {
    const provider = environment.OBJECT_STORAGE_PROVIDER?.trim() || "none";
    if (provider === "none") return undefined;
    if (provider !== "aliyun-oss") {
        throw new Error("OBJECT_STORAGE_PROVIDER must be none or aliyun-oss");
    }

    const stsToken = optional(environment, "OSS_STS_TOKEN");
    const endpoint = optional(environment, "OSS_ENDPOINT");
    const publicBaseUrl = optional(environment, "OSS_PUBLIC_BASE_URL");

    return new AliyunOssStorage(
        {
            region: required(environment, "OSS_REGION"),
            bucket: required(environment, "OSS_BUCKET"),
            accessKeyId: required(environment, "OSS_ACCESS_KEY_ID"),
            accessKeySecret: required(environment, "OSS_ACCESS_KEY_SECRET"),
            urlAccess: parseUrlAccess(environment.OSS_URL_ACCESS),
            ...(stsToken ? { stsToken } : {}),
            ...(endpoint ? { endpoint } : {}),
            ...(environment.OSS_CNAME === undefined
                ? {}
                : { cname: parseBoolean(environment.OSS_CNAME, "OSS_CNAME") }),
            ...(publicBaseUrl ? { publicBaseUrl } : {}),
            ...(environment.OSS_TIMEOUT_MS === undefined
                ? {}
                : {
                      timeoutMs: parsePositiveInteger(
                          environment.OSS_TIMEOUT_MS,
                          "OSS_TIMEOUT_MS",
                      ),
                  }),
            ...(environment.OSS_SIGNED_URL_TTL_SECONDS === undefined
                ? {}
                : {
                      signedUrlTtlSeconds: parsePositiveInteger(
                          environment.OSS_SIGNED_URL_TTL_SECONDS,
                          "OSS_SIGNED_URL_TTL_SECONDS",
                      ),
                  }),
        },
        dependencies,
    );
}

function required(environment: ObjectStorageEnvironment, name: string): string {
    const value = optional(environment, name);
    if (!value) throw new Error(`${name} is required for aliyun-oss`);
    return value;
}

function optional(
    environment: ObjectStorageEnvironment,
    name: string,
): string | undefined {
    const raw = environment[name];
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (value && raw !== value) {
        throw new Error(`${name} must not contain surrounding whitespace`);
    }
    return value || undefined;
}

function parseUrlAccess(value: string | undefined): ObjectUrlAccess {
    const normalized = value?.trim();
    if (normalized === undefined || normalized === "signed") return "signed";
    if (normalized === "public") return "public";
    throw new Error("OSS_URL_ACCESS must be signed or public");
}

function parseBoolean(value: string, name: string): boolean {
    const normalized = value.trim();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}
