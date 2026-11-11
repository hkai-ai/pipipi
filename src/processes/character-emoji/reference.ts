/** 校验来自 Memebuy 官方角色目录的不可变 OSS 原图地址。 */
import { z } from "zod";
import {
    type ExpectedProcessFailure,
    failProcess,
} from "../../process-runtime/registration.js";

// 匹配完整原文，拒绝端口、用户信息、转义路径、查询、片段及路径归一化。
const officialReference =
    /^https:\/\/assets\.memebuy\.cn\/maker\/characters\/(?:ai-fanworks|community\/scenes)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png(?![\s\S])/u;

export const characterReferenceUrl = z
    .string()
    .max(2048)
    .regex(officialReference);
export const immutableCharacterReferenceUrl = characterReferenceUrl.regex(
    /-[0-9a-f]{16,64}\.png$/u,
);

/** 在创作前逐一检查已通过 schema 的公开对象，跳转不得交给 URL 型绘图渠道。 */
export async function verifyCharacterReferences(
    urls: readonly string[],
    signal: AbortSignal,
    fetcher: typeof fetch,
): Promise<ExpectedProcessFailure | undefined> {
    const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(15_000),
    ]);
    try {
        const responses = await Promise.all(
            urls.map((url) =>
                fetcher(url, {
                    method: "HEAD",
                    credentials: "omit",
                    redirect: "manual",
                    signal: requestSignal,
                }),
            ),
        );
        if (
            responses.some(
                (response) => response.status >= 300 && response.status < 400,
            )
        )
            return failProcess(
                "INVALID_INPUT",
                "参考图地址必须直接指向官方原图",
            );
        if (responses.every((response) => response.ok)) return;
    } catch {
        signal.throwIfAborted();
    }
    return failProcess("DEPENDENCY_FAILURE", "官方角色参考图暂时不可读取");
}
