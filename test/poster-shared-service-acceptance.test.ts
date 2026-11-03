import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it.each([307, 308])(
    "does not repeat a paid POST after HTTP %s",
    async (status) => {
        let targets = 0;
        const server = createServer((request, response) => {
            if (request.url === "/execute") {
                response.writeHead(status, { location: "/redirect-target" });
                response.end();
            } else {
                targets += 1;
                response.writeHead(503);
                response.end();
            }
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Missing address");
        try {
            await expect(
                acceptSharedPoster({
                    apiUrl: `http://127.0.0.1:${address.port}`,
                    allowPaid: true,
                }),
            ).rejects.toMatchObject({
                evidence: {
                    passed: false,
                    submission: "unknown",
                    stage: "execute",
                },
            });
            expect(targets).toBe(0);
        } finally {
            await new Promise<void>((done) => server.close(() => done()));
        }
    },
);

it.each(["download", "decode"])(
    "retains known run identity when image %s fails",
    async (stage) => {
        const directory = await mkdtemp(join(tmpdir(), "poster-acceptance-"));
        let savedBeforeDownload = "";
        let url = "";
        let posts = 0;
        const server = createServer(async (request, response) => {
            if (request.url === "/execute") {
                posts += 1;
                response.setHeader("content-type", "application/json");
                response.end(
                    JSON.stringify({
                        runId: "paid-run-1",
                        process: "minimal-zine-poster",
                        version: "v1",
                        status: "succeeded",
                        output: {
                            image: {
                                url: `${url}/image?secret=sentinel`,
                                width: 120,
                                height: 200,
                                contentType: "image/png",
                            },
                        },
                    }),
                );
            } else {
                const files = await readdir(directory);
                savedBeforeDownload = await readFile(
                    join(directory, files[0]),
                    "utf8",
                );
                response.writeHead(stage === "download" ? 502 : 200);
                response.end("private-sentinel");
            }
        });
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Missing address");
        url = `http://127.0.0.1:${address.port}`;
        try {
            await expect(
                acceptSharedPoster({
                    apiUrl: url,
                    allowPaid: true,
                    reportDirectory: directory,
                }),
            ).rejects.toMatchObject({
                evidence: {
                    runId: "paid-run-1",
                    passed: false,
                    submission: "succeeded",
                    stage: "image",
                },
            });
            expect(posts).toBe(1);
            expect(JSON.parse(savedBeforeDownload)).toMatchObject({
                runId: "paid-run-1",
                submission: "succeeded",
                stage: "image",
                passed: false,
            });
            expect(savedBeforeDownload).not.toMatch(/sentinel|http|Bearer/);
        } finally {
            await new Promise<void>((done) => server.close(() => done()));
            await rm(directory, { recursive: true, force: true });
        }
    },
);
