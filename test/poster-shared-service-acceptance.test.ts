import { createServer } from "node:http";
import sharp from "sharp";
import { expect, it } from "vitest";
import { acceptSharedPoster } from "../examples/poster-shared-service-acceptance.js";

it("requires paid approval before contacting an API", async () => {
    await expect(
        acceptSharedPoster({ apiUrl: "http://127.0.0.1:1", allowPaid: false }),
    ).rejects.toThrow("PAID_ACCEPTANCE_NOT_APPROVED");
});
it("uses one real HTTP execute request and downloads the returned image without exposing its URL", async () => {
    const bytes = await sharp({
        create: { width: 120, height: 200, channels: 3, background: "white" },
    })
        .png()
        .toBuffer();
    let calls = 0;
    let url = "";
    const server = createServer(async (request, response) => {
        if (request.url === "/execute") {
            calls += 1;
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
                process: "minimal-zine-poster",
                version: "v1",
            });
            response.setHeader("content-type", "application/json");
            response.end(
                JSON.stringify({
                    runId: "acceptance-1",
                    process: "minimal-zine-poster",
                    version: "v1",
                    status: "succeeded",
                    output: {
                        image: {
                            url: `${url}/image?private=sentinel`,
                            width: 120,
                            height: 200,
                            contentType: "image/png",
                        },
                    },
                }),
            );
        } else {
            expect(request.headers.authorization).toBeUndefined();
            response.end(bytes);
        }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Missing address");
    url = `http://127.0.0.1:${address.port}`;
    try {
        const report = await acceptSharedPoster({
            apiUrl: url,
            allowPaid: true,
            authorization: "Bearer test-only",
        });
        expect(calls).toBe(1);
        expect(report).toMatchObject({
            passed: true,
            runId: "acceptance-1",
            width: 120,
            height: 200,
        });
        expect(JSON.stringify(report)).not.toMatch(/sentinel|Bearer|http/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
    }
});
