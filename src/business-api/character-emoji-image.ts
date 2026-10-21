/** 装配角色表情包图片渠道，主用报错后在剩余预算内调用一次备用并保留两路结果。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createCharacterReferenceReader } from "./character-reference.js";
import {
    characterEmojiImageModel,
    MagikaruImageEditClient,
    MagikaruImageEditError,
} from "./magikaru-image-edit.js";
import {
    type EditImageRequest,
    OpenAIImageGenerationClient,
    OpenAIImageGenerationError,
} from "./openai-image-generation.js";

const flareModel = "gpt-image-2.5-flare";
const timeoutMs = 300_000;
const primaryTimeoutMs = 180_000;
type Attempt = Readonly<{
    model: string;
    outcome: "succeeded" | "rejected" | "failed_or_unknown";
    elapsedMs: number;
    status?: number;
}>;

export class CharacterEmojiImageError extends Error {
    constructor(readonly modelAttempts: readonly Attempt[]) {
        super("角色表情包图片调用未完成");
        this.name = "CharacterEmojiImageError";
    }
}

export function createCharacterEmojiImageClient(
    environment: Readonly<Record<string, string | undefined>>,
    options: {
        directory: string;
        fetch?: typeof globalThis.fetch;
        onAttempts?: (event: {
            idempotencyKey: string;
            modelAttempts: readonly Attempt[];
        }) => void | Promise<void>;
    },
) {
    const apiKey = environment.CHARACTER_EMOJI_IMAGE_API_KEY?.trim();
    const baseUrl = environment.CHARACTER_EMOJI_IMAGE_BASE_URL?.trim();
    const backupKey = environment.MAGIKARU_API_KEY?.trim();
    if (baseUrl && !apiKey) {
        throw new Error(
            "配置图片主用地址时必须配置 CHARACTER_EMOJI_IMAGE_API_KEY",
        );
    }
    if (baseUrl) {
        const url = new URL(baseUrl);
        if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {
            throw new Error(
                "CHARACTER_EMOJI_IMAGE_BASE_URL 必须是无凭证的 HTTPS 地址",
            );
        }
    }
    const primary = apiKey
        ? new OpenAIImageGenerationClient({
              apiKey,
              baseUrl: baseUrl || "https://llmapi.memene.cn/openai/v1",
              timeoutMs: backupKey ? primaryTimeoutMs : timeoutMs,
              fetch: options.fetch,
              referenceReader: createCharacterReferenceReader(
                  environment,
                  options.fetch,
              ),
              // 对齐 Memebuy 已核验的 Flare 请求，不继承 CRT 的质量与输出参数。
              editDefaults: {},
          })
        : undefined;
    const backup = backupKey
        ? new MagikaruImageEditClient({
              apiKey: backupKey,
              baseUrl:
                  environment.MAGIKARU_BASE_URL?.trim() ||
                  "https://magikaru.memebuy.cn",
              timeoutMs,
              fetch: options.fetch,
              onSubmitted: async (receipt) => {
                  const jobs = join(options.directory, "character-emoji-jobs");
                  await mkdir(jobs, { recursive: true });
                  await writeFile(
                      join(jobs, `${receipt.idempotencyKey}.json`),
                      JSON.stringify(receipt),
                      { mode: 0o600 },
                  );
              },
          })
        : undefined;
    if (!primary && !backup) return undefined;

    return {
        async edit(request: EditImageRequest) {
            const key = request.idempotencyKey;
            if (!key || !/^[A-Za-z0-9_-]{1,128}$/u.test(key)) {
                throw new Error("角色图片调用需要有效幂等键");
            }
            const signal = AbortSignal.any([
                AbortSignal.timeout(timeoutMs),
                ...(request.signal ? [request.signal] : []),
            ]);
            const attempts: Attempt[] = [];
            const routes = [
                ...(primary ? [{ client: primary, model: flareModel }] : []),
                ...(backup
                    ? [{ client: backup, model: characterEmojiImageModel }]
                    : []),
            ];
            try {
                for (const route of routes) {
                    signal.throwIfAborted();
                    const started = Date.now();
                    try {
                        const image = await route.client.edit({
                            ...request,
                            model: route.model,
                            signal,
                            ...(route.client === primary
                                ? {
                                      quality: undefined,
                                      outputFormat: undefined,
                                  }
                                : {}),
                        });
                        const metadata = await sharp(image.bytes).metadata();
                        if (
                            image.mimeType !== "image/png" ||
                            metadata.format !== "png" ||
                            !metadata.width ||
                            !metadata.height ||
                            metadata.width > 4_096 ||
                            metadata.height > 4_096
                        ) {
                            throw new Error("表情包图片尺寸或格式不正确");
                        }
                        attempts.push({
                            model: route.model,
                            outcome: "succeeded",
                            elapsedMs: Date.now() - started,
                        });
                        return image;
                    } catch (error) {
                        const rejected = isKnownRejection(error);
                        const status =
                            error instanceof OpenAIImageGenerationError ||
                            error instanceof MagikaruImageEditError
                                ? error.status
                                : undefined;
                        attempts.push({
                            model: route.model,
                            outcome: rejected
                                ? "rejected"
                                : "failed_or_unknown",
                            elapsedMs: Date.now() - started,
                            ...(status === undefined ? {} : { status }),
                        });
                        // 主用任意错误均切换一次；主动取消或整体截止仍停止，备用不重投。
                        if (
                            signal.aborted ||
                            route.client !== primary ||
                            !backup
                        ) {
                            throw new CharacterEmojiImageError(attempts);
                        }
                    }
                }
                throw new CharacterEmojiImageError(attempts);
            } finally {
                try {
                    await options.onAttempts?.({
                        idempotencyKey: key,
                        modelAttempts: attempts,
                    });
                } catch {
                    // 观测失败不改变生成结果，也不增加供应商调用。
                }
            }
        },
    };
}

function isKnownRejection(error: unknown): boolean {
    // 只用于保留原有观测分类，不再决定是否允许切换备用。
    return (
        error instanceof OpenAIImageGenerationError &&
        error.status !== undefined &&
        [401, 402, 404, 429].includes(error.status)
    );
}
