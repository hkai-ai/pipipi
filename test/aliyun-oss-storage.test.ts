import { describe, expect, it, vi } from "vitest";
import {
    type AliyunOssClient,
    AliyunOssStorage,
} from "../examples/support/aliyun-oss-storage.js";
import { createObjectStorageFromEnvironment } from "../examples/support/object-storage-config.js";

describe("AliyunOssStorage", () => {
    it("uploads bytes with V4 signing and returns a public CDN URL", async () => {
        const client = fakeClient({
            uploadUrl: "https://bucket.oss-cn-hangzhou.aliyuncs.com/original",
            headers: {
                ETag: '"asset-etag"',
                "x-oss-request-id": "oss-request-1",
            },
        });
        const clientFactory = vi.fn(() => client);
        const storage = new AliyunOssStorage(
            {
                region: "oss-cn-hangzhou",
                bucket: "pipipi-assets",
                accessKeyId: "test-access-key-id",
                accessKeySecret: "test-access-key-secret",
                endpoint: "https://upload.example.com",
                cname: true,
                timeoutMs: 12_000,
                urlAccess: "public",
                publicBaseUrl: "https://cdn.example.com/assets/",
            },
            { clientFactory },
        );
        const bytes = Uint8Array.from([1, 2, 3, 4]);

        const result = await storage.upload({
            objectKey: "posters/雨 天.png",
            bytes,
            contentType: "image/png",
            cacheControl: "public, max-age=31536000, immutable",
        });

        expect(clientFactory).toHaveBeenCalledWith({
            region: "oss-cn-hangzhou",
            bucket: "pipipi-assets",
            accessKeyId: "test-access-key-id",
            accessKeySecret: "test-access-key-secret",
            authorizationV4: true,
            secure: true,
            timeout: 12_000,
            endpoint: "https://upload.example.com",
            cname: true,
        });
        expect(client.put).toHaveBeenCalledOnce();
        const [objectKey, uploadedBytes, putOptions] =
            vi.mocked(client.put).mock.calls[0] ?? [];
        expect(objectKey).toBe("posters/雨 天.png");
        expect(uploadedBytes).toEqual(Buffer.from(bytes));
        expect(putOptions).toEqual({
            mime: "image/png",
            timeout: 12_000,
            headers: {
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        });
        expect(client.signatureUrlV4).not.toHaveBeenCalled();
        expect(result).toEqual({
            provider: "aliyun-oss",
            bucket: "pipipi-assets",
            objectKey: "posters/雨 天.png",
            url: "https://cdn.example.com/assets/posters/%E9%9B%A8%20%E5%A4%A9.png",
            urlAccess: "public",
            contentType: "image/png",
            size: 4,
            etag: '"asset-etag"',
            requestId: "oss-request-1",
        });
    });

    it("returns a V4 signed URL and its expiry for a private object", async () => {
        const signedUrl =
            "https://private.example.com/posters/test.png?x-oss-signature=temporary";
        const client = fakeClient({ signedUrl });
        const storage = new AliyunOssStorage(
            baseOptions({ signedUrlTtlSeconds: 900 }),
            {
                clientFactory: () => client,
                now: () => new Date("2026-08-07T04:00:00.000Z"),
            },
        );

        const result = await storage.upload({
            objectKey: "posters/test.png",
            bytes: Uint8Array.from([9, 8, 7]),
            contentType: "image/png",
        });

        expect(client.signatureUrlV4).toHaveBeenCalledWith(
            "GET",
            900,
            undefined,
            "posters/test.png",
        );
        expect(result).toMatchObject({
            url: signedUrl,
            urlAccess: "signed",
            urlExpiresAt: "2026-08-07T04:15:00.000Z",
        });
    });

    it.each(["/absolute.png", "posters\\image.png", "posters/../image.png"])(
        "rejects unsafe object key %s before calling OSS",
        async (objectKey) => {
            const client = fakeClient();
            const storage = new AliyunOssStorage(baseOptions(), {
                clientFactory: () => client,
            });

            await expect(
                storage.upload({
                    objectKey,
                    bytes: Uint8Array.from([1]),
                    contentType: "image/png",
                }),
            ).rejects.toThrow(/Object key/u);
            expect(client.put).not.toHaveBeenCalled();
        },
    );

    it("preserves safe OSS diagnostics without exposing the SDK error message", async () => {
        const leakedSecret = "do-not-leak-this-secret";
        const client = fakeClient();
        vi.mocked(client.put).mockRejectedValueOnce(
            Object.assign(new Error(`request contained ${leakedSecret}`), {
                status: 403,
                code: "AccessDenied",
                requestId: "oss-request-denied",
            }),
        );
        const storage = new AliyunOssStorage(baseOptions(), {
            clientFactory: () => client,
        });

        const promise = storage.upload({
            objectKey: "posters/test.png",
            bytes: Uint8Array.from([1]),
            contentType: "image/png",
        });

        await expect(promise).rejects.toMatchObject({
            name: "ObjectStorageError",
            provider: "aliyun-oss",
            status: 403,
            code: "AccessDenied",
            requestId: "oss-request-denied",
        });
        await expect(promise).rejects.not.toThrow(leakedSecret);
    });

    it("honors an already-aborted business operation", async () => {
        const client = fakeClient();
        const storage = new AliyunOssStorage(baseOptions(), {
            clientFactory: () => client,
        });
        const controller = new AbortController();
        controller.abort(new Error("business operation stopped"));

        await expect(
            storage.upload(
                {
                    objectKey: "posters/test.png",
                    bytes: Uint8Array.from([1]),
                    contentType: "image/png",
                },
                { signal: controller.signal },
            ),
        ).rejects.toThrow("business operation stopped");
        expect(client.put).not.toHaveBeenCalled();
    });
});

describe("object storage environment configuration", () => {
    it("keeps object storage disabled unless a provider is selected", () => {
        expect(createObjectStorageFromEnvironment({})).toBeUndefined();
        expect(
            createObjectStorageFromEnvironment({
                OBJECT_STORAGE_PROVIDER: "none",
            }),
        ).toBeUndefined();
    });

    it("constructs the OSS Adapter from environment variables", () => {
        const client = fakeClient();
        const clientFactory = vi.fn(() => client);

        const storage = createObjectStorageFromEnvironment(
            {
                OBJECT_STORAGE_PROVIDER: "aliyun-oss",
                OSS_REGION: "oss-cn-shanghai",
                OSS_BUCKET: "pipipi-assets",
                OSS_ACCESS_KEY_ID: "test-access-key-id",
                OSS_ACCESS_KEY_SECRET: "test-access-key-secret",
                OSS_STS_TOKEN: "test-sts-token",
                OSS_URL_ACCESS: "public",
                OSS_PUBLIC_BASE_URL: "https://assets.example.com",
                OSS_TIMEOUT_MS: "15000",
            },
            { clientFactory },
        );

        expect(storage?.provider).toBe("aliyun-oss");
        expect(clientFactory).toHaveBeenCalledWith(
            expect.objectContaining({
                region: "oss-cn-shanghai",
                bucket: "pipipi-assets",
                stsToken: "test-sts-token",
                authorizationV4: true,
                timeout: 15_000,
            }),
        );
    });

    it("rejects an incomplete OSS configuration before any upload", () => {
        expect(() =>
            createObjectStorageFromEnvironment({
                OBJECT_STORAGE_PROVIDER: "aliyun-oss",
            }),
        ).toThrow("OSS_REGION is required for aliyun-oss");
    });
});

function baseOptions(
    overrides: Partial<ConstructorParameters<typeof AliyunOssStorage>[0]> = {},
): ConstructorParameters<typeof AliyunOssStorage>[0] {
    return {
        region: "oss-cn-hangzhou",
        bucket: "pipipi-assets",
        accessKeyId: "test-access-key-id",
        accessKeySecret: "test-access-key-secret",
        ...overrides,
    };
}

function fakeClient(
    options: {
        uploadUrl?: string;
        signedUrl?: string;
        headers?: Record<string, string>;
    } = {},
): AliyunOssClient {
    return {
        put: vi.fn(async (name: string) => ({
            name,
            url:
                options.uploadUrl ??
                `https://pipipi-assets.oss-cn-hangzhou.aliyuncs.com/${name}`,
            data: {},
            res: {
                status: 200,
                headers: options.headers ?? {},
                size: 0,
                rt: 1,
            },
        })),
        signatureUrlV4: vi.fn(
            async () =>
                options.signedUrl ??
                "https://private.example.com/object?x-oss-signature=temporary",
        ),
    };
}
