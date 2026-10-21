/** 将固定角色素材地址映射为同桶 OSS 读取请求，保持原图字节与取消边界。 */
import OSS from "ali-oss";
import { readAliyunOssOptions } from "./object-storage-config.js";
import type { ReferenceImageReader } from "./openai-image-generation.js";

export function createCharacterReferenceReader(
    environment: Record<string, string | undefined>,
    fetcher: typeof fetch = globalThis.fetch,
): ReferenceImageReader | undefined {
    const options = readAliyunOssOptions(environment);
    if (!options) return undefined;
    if (
        options.publicBaseUrl?.replace(/\/+$/u, "") !==
        "https://assets.memebuy.cn"
    ) {
        throw new Error("角色参考图 OSS 必须对应 assets.memebuy.cn");
    }
    const client = new OSS({
        region: options.region,
        bucket: options.bucket,
        accessKeyId: options.accessKeyId,
        accessKeySecret: options.accessKeySecret,
        authorizationV4: true,
        secure: true,
        ...(options.stsToken ? { stsToken: options.stsToken } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.cname === undefined ? {} : { cname: options.cname }),
    });
    return async (url, signal) => {
        signal.throwIfAborted();
        const source = new URL(url);
        if (
            source.origin !== "https://assets.memebuy.cn" ||
            !(
                source.pathname.startsWith("/maker/characters/ai-fanworks/") ||
                source.pathname ===
                    "/maker/characters/community/scenes/doubao/chibi-5e7e8f7823faaa50.png"
            ) ||
            source.search ||
            source.hash ||
            source.username ||
            source.password
        ) {
            throw new Error("角色参考图不属于固定素材目录");
        }
        // 签名只在请求内使用，不进入模型、运行记录或公开输出。
        const signed = await client.signatureUrlV4(
            "GET",
            60,
            undefined,
            source.pathname.slice(1),
        );
        signal.throwIfAborted();
        return fetcher(signed, { signal, redirect: "error" });
    };
}
