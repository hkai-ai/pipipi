import {
    createPinnedPublicHttpTransport,
    createPublicHttpTargetPolicy,
    type PublicHttpTargetPolicy,
} from "../network/public-http.js";
import type {
    AvailabilityProbe,
    AvailabilityProbeInspection,
} from "./monitor.js";

type HttpRequest = (input: string, init: RequestInit) => Promise<Response>;

export type PublicHttpAvailabilityClient = Readonly<{
    get: (request: {
        url: string;
        headers: Readonly<Record<string, string>>;
        signal: AbortSignal;
        maxResponseBytes: number;
    }) => Promise<Readonly<{ status: number; body: string }>>;
}>;

export function createHttpAvailabilityProbe(options: {
    name: string;
    url: string;
    expectedStatus: "ok" | "ready";
    expectedRole?: string;
    timeoutMs?: number;
    request?: HttpRequest;
    clock?: () => number;
}): AvailabilityProbe {
    const target = parseTarget(options.url);
    const request = options.request ?? fetch;
    const timeoutMs = positiveInteger(
        options.timeoutMs ?? 5_000,
        "HTTP Availability timeout",
    );
    const clock = options.clock ?? (() => performance.now());

    return Object.freeze({
        name: options.name,
        kind: "http" as const,
        inspect: async (): Promise<AvailabilityProbeInspection> => {
            const startedAt = clock();
            try {
                const response = await request(target, {
                    method: "GET",
                    headers: { accept: "application/json" },
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                });
                const latencyMs = elapsed(startedAt, clock());
                if (response.status !== 200) {
                    return Object.freeze({
                        status: "unavailable" as const,
                        latencyMs,
                        attributes: Object.freeze({
                            httpStatus: response.status,
                        }),
                        errorCode: "HTTP_UNAVAILABLE",
                    });
                }
                const body = await response.json();
                if (
                    !validBody(
                        body,
                        options.expectedStatus,
                        options.expectedRole,
                    )
                ) {
                    return Object.freeze({
                        status: "unavailable" as const,
                        latencyMs,
                        attributes: Object.freeze({
                            httpStatus: response.status,
                        }),
                        errorCode: "HTTP_RESPONSE_INVALID",
                    });
                }
                return Object.freeze({
                    status: "available" as const,
                    latencyMs,
                    attributes: Object.freeze({
                        httpStatus: response.status,
                        semanticStatus: options.expectedStatus,
                        ...(options.expectedRole
                            ? { role: options.expectedRole }
                            : {}),
                    }),
                });
            } catch {
                return Object.freeze({
                    status: "unavailable" as const,
                    latencyMs: elapsed(startedAt, clock()),
                    attributes: Object.freeze({}),
                    errorCode: "HTTP_UNAVAILABLE",
                });
            }
        },
    });
}

export function createPublicHttpAvailabilityProbe(options: {
    name: string;
    url: string;
    expectedStatus: "ok" | "ready";
    timeoutMs?: number;
    client?: PublicHttpAvailabilityClient;
    targetPolicy?: PublicHttpTargetPolicy;
    clock?: () => number;
}): AvailabilityProbe {
    const target = parseTarget(options.url);
    if (new URL(target).protocol !== "https:") {
        throw new Error("Public HTTP Availability target must use HTTPS");
    }
    const timeoutMs = positiveInteger(
        options.timeoutMs ?? 5_000,
        "Public HTTP Availability timeout",
    );
    const transport = createPinnedPublicHttpTransport({
        targetPolicy: options.targetPolicy ?? createPublicHttpTargetPolicy(),
    });
    const client =
        options.client ??
        Object.freeze({
            get: async (request) => {
                const response = await transport.request({
                    ...request,
                    method: "GET",
                });
                return Object.freeze({
                    status: response.status,
                    body: response.body,
                });
            },
        });
    const clock = options.clock ?? (() => performance.now());

    return Object.freeze({
        name: options.name,
        kind: "http" as const,
        inspect: async (): Promise<AvailabilityProbeInspection> => {
            const startedAt = clock();
            try {
                const response = await client.get({
                    url: target,
                    headers: { accept: "application/json" },
                    signal: AbortSignal.timeout(timeoutMs),
                    maxResponseBytes: 16_384,
                });
                const latencyMs = elapsed(startedAt, clock());
                if (response.status !== 200) {
                    return unavailableHttp(response.status, latencyMs);
                }
                let body: unknown;
                try {
                    body = JSON.parse(response.body);
                } catch {
                    return invalidHttp(response.status, latencyMs);
                }
                if (!validBody(body, options.expectedStatus, undefined)) {
                    return invalidHttp(response.status, latencyMs);
                }
                return Object.freeze({
                    status: "available" as const,
                    latencyMs,
                    attributes: Object.freeze({
                        httpStatus: response.status,
                        semanticStatus: options.expectedStatus,
                    }),
                });
            } catch {
                return Object.freeze({
                    status: "unavailable" as const,
                    latencyMs: elapsed(startedAt, clock()),
                    attributes: Object.freeze({}),
                    errorCode: "HTTP_UNAVAILABLE",
                });
            }
        },
    });
}

function unavailableHttp(
    httpStatus: number,
    latencyMs: number,
): AvailabilityProbeInspection {
    return Object.freeze({
        status: "unavailable" as const,
        latencyMs,
        attributes: Object.freeze({ httpStatus }),
        errorCode: "HTTP_UNAVAILABLE",
    });
}

function invalidHttp(
    httpStatus: number,
    latencyMs: number,
): AvailabilityProbeInspection {
    return Object.freeze({
        status: "unavailable" as const,
        latencyMs,
        attributes: Object.freeze({ httpStatus }),
        errorCode: "HTTP_RESPONSE_INVALID",
    });
}

function validBody(
    value: unknown,
    expectedStatus: "ok" | "ready",
    expectedRole: string | undefined,
): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const body = value as Record<string, unknown>;
    return (
        body.status === expectedStatus &&
        (expectedRole === undefined || body.role === expectedRole)
    );
}

function parseTarget(value: string): string {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
            throw new Error();
        }
        return url.toString();
    } catch {
        throw new Error("HTTP Availability target is invalid");
    }
}

function elapsed(startedAt: number, completedAt: number): number {
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
    return Math.max(0, Math.round(completedAt - startedAt));
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
        throw new Error(`${label} must be between 1 and 300000 milliseconds`);
    }
    return value;
}
