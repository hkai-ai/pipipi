/** 为绑定逻辑模型的照片海报装配单一编辑渠道，并保存多媒体网关的付费任务回执。 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageEditChannel } from "../image-edit-models.js";
import { MagikaruImageEditClient } from "./magikaru-image-edit.js";
import type {
    EditImageRequest,
    GeneratedImage,
} from "./openai-image-generation.js";

type Client = { edit(request: EditImageRequest): Promise<GeneratedImage> };

export function createPhotoPosterImageClient(
    channel: ImageEditChannel,
    fal: Client,
    environment: Readonly<Record<string, string | undefined>>,
    options: {
        directory: string;
        timeoutMs: number;
        fetch?: typeof globalThis.fetch;
    },
) {
    if (channel === "fal") return { channel, client: fal };
    const gateway = new MagikaruImageEditClient({
        apiKey: environment.MAGIKARU_API_KEY ?? "",
        baseUrl: environment.MAGIKARU_BASE_URL || "https://magikaru.memebuy.cn",
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
        onSubmitted: async (receipt) => {
            const directory = join(options.directory, "photo-poster-jobs");
            await mkdir(directory, { recursive: true });
            await writeFile(
                join(directory, `${receipt.idempotencyKey}.json`),
                JSON.stringify(receipt),
                { mode: 0o600, flag: "wx" },
            );
        },
    });
    return {
        channel,
        client: {
            edit: (request: EditImageRequest) =>
                gateway.editPhotoPoster(request),
        },
    };
}
