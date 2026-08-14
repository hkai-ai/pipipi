import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createPaidAsyncImageSmoke } from "../src/app/paid-async-image-smoke.js";

const REVISION = "a".repeat(40);
const RUN_ID = "7f6ec44d-2870-42e8-b5c5-512fee086e70";
const SOURCE_URL =
    "https://source.example.com/private/source.png?signature=secret";
const OBJECT_URL =
    "https://assets.example.com/crt/result/7f6ec44d.png?signature=object-secret";
const AUTHORIZATION = "Bearer paid-smoke-secret";

describe("Paid async image smoke", () => {
    it("recovers one paid operation through the same Run and verifies its OSS PNG", async () => {
        const png = await sharp({
            create: {
                width: 4,
                height: 3,
                channels: 3,
                background: { r: 222, g: 228, b: 224 },
            },
        })
            .png()
            .toBuffer();
        const requests: Array<{
            url: string;
            method: string;
            authorization: string | null;
            idempotencyKey: string | null;
            body: unknown;
        }> = [];
        const interruptedAcceptance = accepted("queued");
        const gatewayResponses = [
            interruptedAcceptance,
            accepted("queued"),
            run("running"),
            run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
                rawImage: {
                    url: "https://assets.example.com/crt/raw/7f6ec44d.png?signature=raw-secret",
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            }),
        ];
        const request: typeof fetch = async (input, init) => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            requests.push({
                url,
                method: init?.method ?? "GET",
                authorization: headers.get("authorization"),
                idempotencyKey: headers.get("idempotency-key"),
                body:
                    typeof init?.body === "string"
                        ? JSON.parse(init.body)
                        : undefined,
            });
            if (url === OBJECT_URL) {
                return new Response(png, {
                    status: 200,
                    headers: { "content-type": "image/png" },
                });
            }
            const response = gatewayResponses.shift();
            if (!response) throw new Error("Unexpected gateway request");
            return response;
        };

        const smoke = createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
            clock: () => "2026-08-14T12:00:00.000Z",
        });

        const evidence = await smoke.run();

        expect(evidence).toMatchObject({
            schemaVersion: 1,
            event: "paid_async_image_smoke_completed",
            revision: REVISION,
            status: "succeeded",
            processRunStatus: "succeeded",
            process: { id: "crt-interface-image", version: "v1" },
            runId: RUN_ID,
            recovery: {
                submissionAttempts: 2,
                uniqueRuns: 1,
                initialAcceptanceInterrupted: true,
                acceptanceResponseRecoveryVerified: true,
                querySessions: 2,
                queryRecoveryVerified: true,
            },
            object: {
                contentType: "image/png",
                bytes: png.length,
                width: 4,
                height: 3,
                expectedOssLocationVerified: true,
                accessible: true,
                opaque: true,
                paletteVerified: true,
            },
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
        });
        expect(requests.filter((item) => item.method === "POST")).toHaveLength(
            2,
        );
        expect(interruptedAcceptance.bodyUsed).toBe(true);
        expect(
            new Set(
                requests
                    .filter((item) => item.method === "POST")
                    .map((item) => item.idempotencyKey),
            ),
        ).toEqual(new Set(["paid-operation-key"]));
        expect(requests[0]?.body).toEqual({
            process: "crt-interface-image",
            version: "v1",
            input: {
                sourceImageUrl: SOURCE_URL,
                palette: "经典",
                aspectRatio: "4:3",
                grain: "normal",
            },
        });
        const serialized = JSON.stringify(evidence);
        for (const forbidden of [
            SOURCE_URL,
            OBJECT_URL,
            AUTHORIZATION,
            "object-secret",
            "raw-secret",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it("keeps the Run ID and stable public error when the paid Process fails", async () => {
        const responses = [
            accepted("queued"),
            accepted("queued"),
            run("running"),
            json(200, {
                runId: RUN_ID,
                process: "crt-interface-image",
                version: "v1",
                status: "failed",
                createdAt: "2026-08-14T12:00:00.000Z",
                startedAt: "2026-08-14T12:00:01.000Z",
                finishedAt: "2026-08-14T12:00:10.000Z",
                error: {
                    code: "DEPENDENCY_FAILURE",
                    message: "The CRT rendering service is unavailable",
                },
            }),
        ];
        const request: typeof fetch = async () => {
            const response = responses.shift();
            if (!response) throw new Error("Unexpected request");
            return response;
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "terminal",
            processRunStatus: "failed",
            runId: RUN_ID,
            publicErrorCode: "DEPENDENCY_FAILURE",
            process: { id: "crt-interface-image", version: "v1" },
        });
        expect(evidence).not.toHaveProperty("object");
        expect(responses).toHaveLength(0);
        expect(JSON.stringify(evidence)).not.toContain(
            "The CRT rendering service is unavailable",
        );
    });

    it("recovers owner queries after the first query session loses transport", async () => {
        const png = await sharp({
            create: {
                width: 4,
                height: 3,
                channels: 3,
                background: { r: 222, g: 228, b: 224 },
            },
        })
            .png()
            .toBuffer();
        let gatewayCall = 0;
        const request: typeof fetch = async (input, init) => {
            if (String(input) === OBJECT_URL) {
                return new Response(png, {
                    status: 200,
                    headers: { "content-type": "image/png" },
                });
            }
            gatewayCall += 1;
            if (gatewayCall <= 2) return accepted("queued");
            if (gatewayCall === 3) {
                throw new Error("transport failed with a sensitive URL");
            }
            if (gatewayCall === 4) return run("running");
            expect(init?.method).toBe("GET");
            return run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            });
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "succeeded",
            runId: RUN_ID,
            recovery: {
                querySessions: 2,
                queryRecoveryVerified: true,
                initialQueryInterrupted: true,
            },
        });
        expect(JSON.stringify(evidence)).not.toContain("sensitive URL");
    });

    it("fails safely with the accepted Run ID when replay resolves another Run", async () => {
        const request: typeof fetch = async () => {
            if (calls++ === 0) return accepted("queued");
            return json(202, {
                runId: "6148e086-89c2-426c-a380-213934275a1c",
                process: "crt-interface-image",
                version: "v1",
                status: "queued",
                createdAt: "2026-08-14T12:00:00.000Z",
            });
        };
        let calls = 0;
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "acceptance_recovery",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_IDEMPOTENCY_FAILURE",
            recovery: {
                submissionAttempts: 2,
                uniqueRuns: 2,
                acceptanceResponseRecoveryVerified: false,
                querySessions: 0,
                queryRecoveryVerified: false,
            },
        });
        expect(calls).toBe(2);
    });

    it("fails safely with the Run ID when the result is outside approved OSS", async () => {
        const responses = [
            accepted("queued"),
            accepted("queued"),
            run("running"),
            run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: "https://wrong.example.com/crt/result/run.png?credential=secret",
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            }),
        ];
        const request: typeof fetch = async () => {
            const response = responses.shift();
            if (!response) throw new Error("Object URL must not be requested");
            return response;
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "object_verification",
            processRunStatus: "succeeded",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_OBJECT_VERIFICATION_FAILED",
        });
        expect(JSON.stringify(evidence)).not.toContain("wrong.example.com");
        expect(JSON.stringify(evidence)).not.toContain("credential");
    });

    it("refuses to follow an approved OSS URL to another origin", async () => {
        const responses = [
            accepted("queued"),
            accepted("queued"),
            run("running"),
            run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            }),
        ];
        let redirectMode: RequestRedirect | undefined;
        const request: typeof fetch = async (input, init) => {
            if (String(input) === OBJECT_URL) {
                redirectMode = init?.redirect;
                return new Response(null, {
                    status: 302,
                    headers: {
                        location:
                            "https://unapproved.example.com/result.png?secret=value",
                    },
                });
            }
            const response = responses.shift();
            if (!response) throw new Error("Unexpected gateway request");
            return response;
        };

        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "object_verification",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_OBJECT_VERIFICATION_FAILED",
        });
        expect(redirectMode).toBe("manual");
        expect(JSON.stringify(evidence)).not.toContain(
            "unapproved.example.com",
        );
    });

    it("starts the owner-query deadline only after durable acceptance recovery", async () => {
        const png = await sharp({
            create: {
                width: 4,
                height: 3,
                channels: 3,
                background: { r: 222, g: 228, b: 224 },
            },
        })
            .png()
            .toBuffer();
        let time = 0;
        let gatewayCall = 0;
        const request: typeof fetch = async (input) => {
            if (String(input) === OBJECT_URL) {
                return new Response(png, {
                    status: 200,
                    headers: { "content-type": "image/png" },
                });
            }
            gatewayCall += 1;
            if (gatewayCall === 1) {
                time = 70;
                return accepted("queued");
            }
            if (gatewayCall === 2) {
                time = 140;
                return accepted("queued");
            }
            if (gatewayCall === 3) return run("running");
            return run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            });
        };

        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            timeoutMs: 100,
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
            now: () => time,
        }).run();

        expect(evidence).toMatchObject({
            status: "succeeded",
            processRunStatus: "succeeded",
            runId: RUN_ID,
        });
    });

    it("keeps the accepted Run ID when owner query recovery cannot continue", async () => {
        let calls = 0;
        const request: typeof fetch = async () => {
            calls += 1;
            if (calls <= 2) return accepted("queued");
            if (calls === 3) return run("running");
            throw new Error("gateway transport included a signed URL");
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "query_recovery",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_QUERY_RECOVERY_FAILED",
        });
        expect(JSON.stringify(evidence)).not.toContain("signed URL");
    });

    it("keeps the accepted Run ID when the acceptance replay loses transport", async () => {
        let calls = 0;
        const request: typeof fetch = async () => {
            calls += 1;
            if (calls === 1) return accepted("queued");
            throw new Error("replay transport exposed a sensitive endpoint");
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "acceptance_recovery",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_ACCEPTANCE_RECOVERY_FAILED",
            recovery: {
                submissionAttempts: 2,
                uniqueRuns: 1,
                acceptanceResponseRecoveryVerified: false,
            },
        });
        expect(JSON.stringify(evidence)).not.toContain("sensitive endpoint");
    });

    it("completes the same operation after the first acceptance response is lost", async () => {
        const png = await sharp({
            create: {
                width: 4,
                height: 3,
                channels: 3,
                background: { r: 222, g: 228, b: 224 },
            },
        })
            .png()
            .toBuffer();
        const idempotencyKeys: Array<string | null> = [];
        const acceptedOperations = new Set<string>();
        let calls = 0;
        const request: typeof fetch = async (input, init) => {
            if (String(input) === OBJECT_URL) {
                return new Response(png, {
                    status: 200,
                    headers: { "content-type": "image/png" },
                });
            }
            calls += 1;
            const key = new Headers(init?.headers).get("idempotency-key");
            if (calls === 1) {
                idempotencyKeys.push(key);
                if (key !== null) acceptedOperations.add(key);
                throw new Error("first response exposed a sensitive endpoint");
            }
            if (calls === 2) {
                idempotencyKeys.push(key);
                if (key !== null) acceptedOperations.add(key);
                return accepted("queued");
            }
            if (calls === 3) return run("running");
            return run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            });
        };

        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
        }).run();

        expect(evidence).toMatchObject({
            status: "succeeded",
            runId: RUN_ID,
            processRunStatus: "succeeded",
            recovery: {
                submissionAttempts: 2,
                uniqueRuns: 1,
                initialAcceptanceInterrupted: true,
                acceptanceResponseRecoveryVerified: true,
            },
        });
        expect(idempotencyKeys).toEqual([
            "paid-operation-key",
            "paid-operation-key",
        ]);
        expect(acceptedOperations).toEqual(new Set(["paid-operation-key"]));
        expect(JSON.stringify(evidence)).not.toContain("sensitive endpoint");
    });

    it("rejects an OSS PNG that did not pass the fixed CRT finalizer palette", async () => {
        const png = await sharp({
            create: {
                width: 4,
                height: 3,
                channels: 3,
                background: { r: 255, g: 0, b: 0 },
            },
        })
            .png()
            .toBuffer();
        const responses = [
            accepted("queued"),
            accepted("queued"),
            run("running"),
            run("succeeded", {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            }),
        ];
        const request: typeof fetch = async (input) => {
            if (String(input) === OBJECT_URL) {
                return new Response(png, {
                    status: 200,
                    headers: { "content-type": "image/png" },
                });
            }
            const response = responses.shift();
            if (!response) throw new Error("Unexpected gateway request");
            return response;
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "object_verification",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_OBJECT_VERIFICATION_FAILED",
        });
    });

    it("rejects an owner query body that switches to another Run", async () => {
        const otherRun = {
            runId: "6148e086-89c2-426c-a380-213934275a1c",
            process: "crt-interface-image",
            version: "v1",
            status: "succeeded",
            createdAt: "2026-08-14T12:00:00.000Z",
            startedAt: "2026-08-14T12:00:01.000Z",
            finishedAt: "2026-08-14T12:00:02.000Z",
            output: {
                aspectRatio: "4:3",
                image: {
                    url: OBJECT_URL,
                    contentType: "image/png",
                    width: 4,
                    height: 3,
                },
            },
        };
        let calls = 0;
        const request: typeof fetch = async () => {
            calls += 1;
            if (calls <= 2) return accepted("queued");
            return json(200, otherRun);
        };
        const evidence = await createPaidAsyncImageSmoke({
            baseUrl: "https://gateway.example.com",
            revision: REVISION,
            authorization: AUTHORIZATION,
            sourceImageUrl: SOURCE_URL,
            expectedOssHost: "assets.example.com",
            expectedOssPathPrefix: "/crt/result/",
            costApproval: {
                currency: "USD",
                limit: "2.50",
                reference: "FIN-2026-0814",
            },
            fetch: request,
            createId: () => "paid-operation-key",
            wait: async () => undefined,
        }).run();

        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "query_recovery",
            runId: RUN_ID,
            publicErrorCode: "PAID_SMOKE_QUERY_RECOVERY_FAILED",
        });
    });
});

function accepted(status: "queued" | "running" | "succeeded" | "failed") {
    return json(
        202,
        {
            runId: RUN_ID,
            process: "crt-interface-image",
            version: "v1",
            status,
            createdAt: "2026-08-14T12:00:00.000Z",
        },
        { location: `/process-runs/${RUN_ID}` },
    );
}

function run(status: "running" | "succeeded", output?: unknown) {
    return json(200, {
        runId: RUN_ID,
        process: "crt-interface-image",
        version: "v1",
        status,
        createdAt: "2026-08-14T12:00:00.000Z",
        ...(status === "running"
            ? { startedAt: "2026-08-14T12:00:01.000Z" }
            : {
                  startedAt: "2026-08-14T12:00:01.000Z",
                  finishedAt: "2026-08-14T12:00:10.000Z",
                  output,
              }),
    });
}

function json(
    status: number,
    value: unknown,
    extraHeaders: Record<string, string> = {},
) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            "content-type": "application/json",
            "retry-after": "1",
            ...extraHeaders,
        },
    });
}
