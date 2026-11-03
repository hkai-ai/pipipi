/** 对已装配共享图片服务的主 API 执行单次付费海报验收，只输出脱敏证据。 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import { posterImageSchema } from "../src/processes/poster/capability.js";

export async function acceptSharedPoster(options: {
    apiUrl: string;
    allowPaid: boolean;
    authorization?: string;
}) {
    if (!options.allowPaid) throw new Error("PAID_ACCEPTANCE_NOT_APPROVED");
    const api = new URL(options.apiUrl);
    if (
        api.username ||
        api.password ||
        api.search ||
        api.hash ||
        (api.protocol !== "https:" &&
            !(
                api.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname)
            ))
    )
        throw new Error("INVALID_ACCEPTANCE_API_URL");
    const response = await fetch(`${api.href.replace(/\/$/u, "")}/execute`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(options.authorization
                ? { authorization: options.authorization }
                : {}),
        },
        body: JSON.stringify({
            process: "minimal-zine-poster",
            version: "v1",
            input: {
                brief: "A quiet minimal zine poster about a rainy used bookstore.",
                text: "PIPIPI ZINE",
            },
        }),
        signal: AbortSignal.timeout(360_000),
    });
    // 不解析或记录失败正文，不重投同步请求；同步重投会创建另一个付费 Run。
    if (!response.ok) throw new Error(`EXECUTE_HTTP_${response.status}`);
    const result = z
        .object({
            runId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/u),
            process: z.literal("minimal-zine-poster"),
            version: z.literal("v1"),
            status: z.literal("succeeded"),
            output: z.object({ image: posterImageSchema }),
        })
        .parse(await response.json());
    const download = await fetch(result.output.image.url, {
        signal: AbortSignal.timeout(30_000),
    });
    if (!download.ok) throw new Error(`IMAGE_HTTP_${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    if (
        metadata.format !== "png" ||
        metadata.width !== result.output.image.width ||
        metadata.height !== result.output.image.height ||
        Math.abs(metadata.width / metadata.height - 3 / 5) > 0.01
    ) {
        throw new Error("IMAGE_CONTRACT_FAILED");
    }
    return {
        passed: true,
        runId: result.runId,
        process: result.process,
        version: result.version,
        executeCalls: 1,
        width: metadata.width,
        height: metadata.height,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        // 不记录 Prompt、完整 URL、签名、凭证或供应商原文；费用需由供应商账单按 Run 对账。
        cost: "not_reported_by_api",
    };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    try {
        const evidence = await acceptSharedPoster({
            apiUrl: process.env.POSTER_ACCEPTANCE_API_URL ?? "",
            allowPaid: process.env.POSTER_ACCEPTANCE_ALLOW_PAID === "1",
            authorization: process.env.POSTER_ACCEPTANCE_AUTHORIZATION,
        });
        const directory = resolve(
            process.env.POSTER_ACCEPTANCE_REPORT_DIRECTORY ??
                "artifacts/poster-shared-acceptance",
        );
        await mkdir(directory, { recursive: true });
        await writeFile(
            resolve(directory, `${evidence.runId}.json`),
            `${JSON.stringify(evidence, null, 2)}\n`,
            { mode: 0o600 },
        );
        console.log(JSON.stringify(evidence));
    } catch {
        console.error(
            "海报验收未通过；不要重新提交付费请求，请在受控环境核对本次运行。原始异常未输出。",
        );
        process.exitCode = 1;
    }
}
