/** 验收参考照片的受控下载。 */
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { createPublicHttpTargetPolicy } from "../network/public-http.js";

/** 锁定公网 DNS 结果，禁止重定向并限制下载体积，原图 URL 不进入诊断。 */
export async function downloadSourcePhoto(
    url: string,
    signal: AbortSignal,
): Promise<Buffer> {
    const target = await createPublicHttpTargetPolicy().resolve(url);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const lookup = ((_hostname, options, callback) => {
        if (typeof options === "object" && options?.all) {
            callback(null, [
                { address: target.address, family: target.family },
            ]);
        } else callback(null, target.address, target.family);
    }) as LookupFunction;
    return new Promise((resolve, reject) => {
        const req = request(
            target.url,
            {
                signal: combined,
                agent: false,
                family: target.family,
                lookup,
                headers: { accept: "image/png,image/jpeg,image/webp" },
            },
            (response) => {
                if (
                    response.statusCode !== 200 ||
                    Number(response.headers["content-length"] ?? 0) > 20_000_000
                ) {
                    response.destroy();
                    reject(new Error("参考图片下载失败"));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 20_000_000)
                        response.destroy(new Error("参考图片超过体积限制"));
                    else chunks.push(chunk);
                });
                response.on("end", () => resolve(Buffer.concat(chunks)));
                response.on("error", () =>
                    reject(new Error("参考图片下载失败")),
                );
            },
        );
        req.on("error", () => reject(new Error("参考图片下载失败")));
        req.end();
    });
}
