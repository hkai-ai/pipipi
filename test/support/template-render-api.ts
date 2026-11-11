/** 为异步角色与浏览器验收提供本地成图接口，支持失败、延迟及调用次数核对。 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import sharp from "sharp";
import { renderInputSchema } from "../../src/processes/template-from-source/capability.js";

export function renderApproval(reviewerRef: string) {
    return {
        productionId: randomUUID(),
        objectSha256: "a".repeat(64),
        reviewerRef,
    };
}

export async function startTemplateRenderApi() {
    const png = await sharp({
        create: { width: 64, height: 64, channels: 3, background: "white" },
    })
        .png()
        .toBuffer();
    const imageSha256 = createHash("sha256").update(png).digest("hex");
    const effects = new Map<string, number>();
    const holds = new Map<string, Promise<void>>();
    const server = createServer(async (request, response) => {
        if (
            request.method !== "POST" ||
            request.url !== "/template-productions/render"
        ) {
            response.writeHead(404).end();
            return;
        }
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const approval = renderInputSchema.parse(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            const { productionId, reviewerRef } = approval;
            effects.set(reviewerRef, (effects.get(reviewerRef) ?? 0) + 1);
            await holds.get(reviewerRef);
            if (reviewerRef === "fail-dependency") {
                response
                    .writeHead(503, { "content-type": "application/json" })
                    .end(JSON.stringify({ error: { reason: "incomplete" } }));
                return;
            }
            response.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                    productionId,
                    imageSha256,
                    reviewPackageSha256: "c".repeat(64),
                    width: 64,
                    height: 64,
                    imageDataUrl: `data:image/png;base64,${png.toString("base64")}`,
                }),
            );
        } catch {
            response.writeHead(400).end();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected a local HTTP address");
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            ),
        effectCount: (reviewerRef: string) => effects.get(reviewerRef) ?? 0,
        hold: (reviewerRef: string) => {
            let release!: () => void;
            holds.set(
                reviewerRef,
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
            );
            return release;
        },
    };
}
