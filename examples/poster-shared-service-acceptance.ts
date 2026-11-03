/** 对已装配共享图片服务的主 API 执行单次付费海报验收，只输出脱敏证据。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import { posterImageSchema } from "../src/processes/poster/capability.js";

type AcceptanceEvidence = {
    acceptanceId: string;
    passed: boolean;
    submission: "not_submitted" | "unknown" | "succeeded";
    stage: "execute" | "image" | "complete";
    runId?: string;
    process: "minimal-zine-poster";
    version: "v1";
    cost: "not_reported_by_api";
    width?: number;
    height?: number;
    bytes?: number;
    sha256?: string;
};

class PosterAcceptanceFailure extends Error {
    constructor(readonly evidence: AcceptanceEvidence) {
        super("POSTER_ACCEPTANCE_FAILED");
        this.name = "PosterAcceptanceFailure";
    }
}

export async function acceptSharedPoster(options: {
    apiUrl: string;
    allowPaid: boolean;
    authorization?: string;
    reportDirectory?: string;
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
    let evidence: AcceptanceEvidence = {
        acceptanceId: randomUUID(),
        passed: false,
        submission: "not_submitted",
        stage: "execute",
        process: "minimal-zine-poster",
        version: "v1",
        cost: "not_reported_by_api",
    };
    const save = async () => {
        if (!options.reportDirectory) return;
        const directory = resolve(options.reportDirectory);
        await mkdir(directory, { recursive: true });
        await writeFile(
            resolve(directory, `${evidence.acceptanceId}.json`),
            `${JSON.stringify(evidence, null, 2)}\n`,
            { mode: 0o600 },
        );
    };
    // 先验证证据目录可写；付费请求发出前持久化不确定状态。
    await save();
    evidence = { ...evidence, submission: "unknown" };
    await save();
    try {
        const response = await fetch(
            `${api.href.replace(/\/$/u, "")}/execute`,
            {
                method: "POST",
                redirect: "manual",
                headers: {
                    "content-type": "application/json",
                    "x-request-id": evidence.acceptanceId,
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
            },
        );
        // 3xx 不跟随；不读取失败正文、不自动重投，受理状态保守记为未知。
        if (!response.ok) throw new Error("EXECUTE_FAILED");
        const body: unknown = await response.json();
        const identity = z
            .object({
                runId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/u),
                process: z.literal("minimal-zine-poster"),
                version: z.literal("v1"),
                status: z.literal("succeeded"),
            })
            .parse(body);
        evidence = {
            ...evidence,
            runId: identity.runId,
            submission: "succeeded",
            stage: "image",
        };
        // 已知成功 Run 必须在下载、解码或后续证据失败前留下关联。
        await save();
        const result = z
            .object({ output: z.object({ image: posterImageSchema }) })
            .parse(body);
        const download = await fetch(result.output.image.url, {
            signal: AbortSignal.timeout(30_000),
        });
        if (!download.ok) throw new Error("IMAGE_DOWNLOAD_FAILED");
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
        evidence = {
            ...evidence,
            passed: true,
            stage: "complete",
            width: metadata.width,
            height: metadata.height,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        await save();
        return evidence;
    } catch {
        evidence = { ...evidence, passed: false };
        // 报告写入失败不能丢掉内存中的关联信息，也不能导致重投。
        try {
            await save();
        } catch {
            /* CLI 仍输出固定字段证据。 */
        }
        throw new PosterAcceptanceFailure(evidence);
    }
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
            reportDirectory:
                process.env.POSTER_ACCEPTANCE_REPORT_DIRECTORY ??
                "artifacts/poster-shared-acceptance",
        });
        console.log(JSON.stringify(evidence));
    } catch (error) {
        if (error instanceof PosterAcceptanceFailure)
            console.error(JSON.stringify(error.evidence));
        console.error(
            "海报验收未通过；不要重新提交付费请求，请在受控环境核对本次运行。原始异常未输出。",
        );
        process.exitCode = 1;
    }
}
