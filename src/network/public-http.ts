import { lookup as defaultLookup } from "node:dns/promises";
import { type IncomingMessage, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export type PublicHttpTargetRejectionCode =
    | "PUBLIC_HTTP_TARGET_INVALID_URL"
    | "PUBLIC_HTTP_TARGET_INSECURE_SCHEME"
    | "PUBLIC_HTTP_TARGET_FORBIDDEN_ADDRESS"
    | "PUBLIC_HTTP_TARGET_DNS_FAILED";

export class PublicHttpTargetPolicyError extends Error {
    readonly code: PublicHttpTargetRejectionCode;

    constructor(code: PublicHttpTargetRejectionCode) {
        super(code);
        this.name = "PublicHttpTargetPolicyError";
        this.code = code;
    }
}

export type ResolvedPublicHttpTarget = Readonly<{
    url: string;
    address: string;
    family: 4 | 6;
}>;

export type PublicHttpTargetPolicy = Readonly<{
    resolve: (url: string) => Promise<ResolvedPublicHttpTarget>;
}>;

export type PublicHttpTransport = Readonly<{
    request: (request: {
        url: string;
        method: "GET" | "POST";
        headers: Readonly<Record<string, string>>;
        body?: string;
        signal: AbortSignal;
        maxResponseBytes: number;
    }) => Promise<
        Readonly<{
            status: number;
            retryAfter: string | null;
            body: string;
        }>
    >;
}>;

export type ResolvedPublicAddress = Readonly<{
    address: string;
    family: 4 | 6;
}>;

export function createPublicHttpTargetPolicy(
    options: {
        allowInsecureHttp?: boolean;
        allowUnsafeAddresses?: boolean;
        resolveHostname?: (
            hostname: string,
        ) => Promise<readonly ResolvedPublicAddress[]>;
    } = {},
): PublicHttpTargetPolicy {
    const resolveHostname = options.resolveHostname ?? resolveAllAddresses;
    const allowInsecureHttp = options.allowInsecureHttp === true;
    const allowUnsafeAddresses = options.allowUnsafeAddresses === true;

    return Object.freeze({
        resolve: async (value) => {
            const url = parseTargetUrl(value, allowInsecureHttp);
            const hostname = stripIpv6Brackets(url.hostname);
            const literalFamily = isIP(hostname);
            let addresses: readonly ResolvedPublicAddress[];
            if (literalFamily === 4 || literalFamily === 6) {
                addresses = [{ address: hostname, family: literalFamily }];
            } else {
                try {
                    addresses = await resolveHostname(hostname);
                } catch {
                    throw new PublicHttpTargetPolicyError(
                        "PUBLIC_HTTP_TARGET_DNS_FAILED",
                    );
                }
            }
            if (addresses.length < 1 || addresses.length > 16) {
                throw new PublicHttpTargetPolicyError(
                    "PUBLIC_HTTP_TARGET_DNS_FAILED",
                );
            }
            const normalized = addresses.map(validateResolvedAddress);
            if (
                !allowUnsafeAddresses &&
                normalized.some((address) => isForbiddenAddress(address))
            ) {
                throw new PublicHttpTargetPolicyError(
                    "PUBLIC_HTTP_TARGET_FORBIDDEN_ADDRESS",
                );
            }
            const selected = normalized[0];
            if (!selected) {
                throw new PublicHttpTargetPolicyError(
                    "PUBLIC_HTTP_TARGET_DNS_FAILED",
                );
            }
            return Object.freeze({
                url: url.toString(),
                address: selected.address,
                family: selected.family,
            });
        },
    });
}

export function createPinnedPublicHttpTransport(options: {
    targetPolicy: PublicHttpTargetPolicy;
}): PublicHttpTransport {
    return Object.freeze({
        request: async (request) => {
            if (
                !Number.isSafeInteger(request.maxResponseBytes) ||
                request.maxResponseBytes < 0 ||
                request.maxResponseBytes > 1_048_576
            ) {
                throw new Error(
                    "Public HTTP response limit must be between 0 and 1048576 bytes",
                );
            }
            const target = await options.targetPolicy.resolve(request.url);
            return sendPinnedTarget(target, request);
        },
    });
}

export function isPublicHttpTargetPolicyError(
    error: unknown,
): error is PublicHttpTargetPolicyError {
    return error instanceof PublicHttpTargetPolicyError;
}

async function resolveAllAddresses(
    hostname: string,
): Promise<readonly ResolvedPublicAddress[]> {
    const addresses = await defaultLookup(hostname, {
        all: true,
        order: "verbatim",
    });
    return addresses.map((entry) => {
        if (entry.family !== 4 && entry.family !== 6) {
            throw new PublicHttpTargetPolicyError(
                "PUBLIC_HTTP_TARGET_DNS_FAILED",
            );
        }
        return { address: entry.address, family: entry.family };
    });
}

function parseTargetUrl(value: string, allowInsecureHttp: boolean): URL {
    if (
        Buffer.byteLength(value, "utf8") < 1 ||
        Buffer.byteLength(value, "utf8") > 4_096
    ) {
        throw new PublicHttpTargetPolicyError("PUBLIC_HTTP_TARGET_INVALID_URL");
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new PublicHttpTargetPolicyError("PUBLIC_HTTP_TARGET_INVALID_URL");
    }
    if (
        url.protocol !== "https:" &&
        !(allowInsecureHttp && url.protocol === "http:")
    ) {
        throw new PublicHttpTargetPolicyError(
            "PUBLIC_HTTP_TARGET_INSECURE_SCHEME",
        );
    }
    if (
        url.username ||
        url.password ||
        url.hash ||
        !url.hostname ||
        url.hostname.endsWith(".") ||
        (url.port && (!/^\d+$/.test(url.port) || Number(url.port) > 65_535))
    ) {
        throw new PublicHttpTargetPolicyError("PUBLIC_HTTP_TARGET_INVALID_URL");
    }
    return url;
}

function validateResolvedAddress(
    address: ResolvedPublicAddress,
): ResolvedPublicAddress {
    if (
        (address.family !== 4 && address.family !== 6) ||
        isIP(address.address) !== address.family
    ) {
        throw new PublicHttpTargetPolicyError("PUBLIC_HTTP_TARGET_DNS_FAILED");
    }
    return Object.freeze({ address: address.address, family: address.family });
}

function isForbiddenAddress(address: ResolvedPublicAddress): boolean {
    return forbiddenAddresses.check(
        address.address,
        address.family === 4 ? "ipv4" : "ipv6",
    );
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1)
        : hostname;
}

function sendPinnedTarget(
    target: ResolvedPublicHttpTarget,
    request: {
        method: "GET" | "POST";
        headers: Readonly<Record<string, string>>;
        body?: string;
        signal: AbortSignal;
        maxResponseBytes: number;
    },
): Promise<
    Readonly<{ status: number; retryAfter: string | null; body: string }>
> {
    return new Promise((resolve, reject) => {
        const url = new URL(target.url);
        const send = url.protocol === "https:" ? requestHttps : requestHttp;
        let settled = false;
        const lookup = ((_hostname, lookupOptions, callback) => {
            if (
                typeof lookupOptions === "object" &&
                lookupOptions !== null &&
                lookupOptions.all === true
            ) {
                callback(null, [
                    { address: target.address, family: target.family },
                ]);
                return;
            }
            callback(null, target.address, target.family);
        }) as LookupFunction;
        const succeed = (result: {
            status: number;
            retryAfter: string | null;
            body: string;
        }) => {
            if (settled) return;
            settled = true;
            resolve(Object.freeze(result));
        };
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const clientRequest = send(
            url,
            {
                method: request.method,
                headers: request.headers,
                lookup,
                agent: false,
                maxHeaderSize: 16_384,
                signal: request.signal,
            },
            (response) =>
                receiveResponse(
                    response,
                    request.maxResponseBytes,
                    succeed,
                    fail,
                ),
        );
        clientRequest.once("error", fail);
        clientRequest.end(request.body);
    });
}

function receiveResponse(
    response: IncomingMessage,
    maxResponseBytes: number,
    resolve: (result: {
        status: number;
        retryAfter: string | null;
        body: string;
    }) => void,
    reject: (error: unknown) => void,
): void {
    if (maxResponseBytes === 0) {
        const result = {
            status: response.statusCode ?? 0,
            retryAfter: response.headers["retry-after"] ?? null,
            body: "",
        };
        response.destroy();
        resolve(result);
        return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
            response.destroy(new Error("Public HTTP response is too large"));
            return;
        }
        chunks.push(chunk);
    });
    response.once("end", () => {
        resolve({
            status: response.statusCode ?? 0,
            retryAfter: response.headers["retry-after"] ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
        });
    });
    response.once("error", reject);
}

const forbiddenAddresses = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    forbiddenAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
] as const) {
    forbiddenAddresses.addSubnet(network, prefix, "ipv6");
}
