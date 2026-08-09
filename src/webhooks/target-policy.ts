import { lookup as defaultLookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export type WebhookTargetRejectionCode =
    | "WEBHOOK_TARGET_INVALID_URL"
    | "WEBHOOK_TARGET_INSECURE_SCHEME"
    | "WEBHOOK_TARGET_FORBIDDEN_ADDRESS"
    | "WEBHOOK_TARGET_DNS_FAILED";

export class WebhookTargetPolicyError extends Error {
    readonly code: WebhookTargetRejectionCode;

    constructor(code: WebhookTargetRejectionCode) {
        super(code);
        this.name = "WebhookTargetPolicyError";
        this.code = code;
    }
}

export type ResolvedWebhookTarget = Readonly<{
    url: string;
    address: string;
    family: 4 | 6;
}>;

export type WebhookTargetPolicy = Readonly<{
    resolve: (url: string) => Promise<ResolvedWebhookTarget>;
}>;

export type WebhookHttpClient = Readonly<{
    post: (request: {
        url: string;
        headers: Readonly<Record<string, string>>;
        body: string;
        signal: AbortSignal;
    }) => Promise<Readonly<{ status: number; retryAfter: string | null }>>;
}>;

type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

export function createWebhookTargetPolicy(
    options: {
        allowInsecureHttp?: boolean;
        allowUnsafeAddresses?: boolean;
        resolveHostname?: (
            hostname: string,
        ) => Promise<readonly ResolvedAddress[]>;
    } = {},
): WebhookTargetPolicy {
    const resolveHostname = options.resolveHostname ?? resolveAllAddresses;
    const allowInsecureHttp = options.allowInsecureHttp === true;
    const allowUnsafeAddresses = options.allowUnsafeAddresses === true;

    return Object.freeze({
        resolve: async (value) => {
            const url = parseWebhookTargetUrl(value, allowInsecureHttp);
            const hostname = stripIpv6Brackets(url.hostname);
            const literalFamily = isIP(hostname);
            let addresses: readonly ResolvedAddress[];
            if (literalFamily === 4 || literalFamily === 6) {
                addresses = [{ address: hostname, family: literalFamily }];
            } else {
                try {
                    addresses = await resolveHostname(hostname);
                } catch {
                    throw new WebhookTargetPolicyError(
                        "WEBHOOK_TARGET_DNS_FAILED",
                    );
                }
            }
            if (addresses.length < 1 || addresses.length > 16) {
                throw new WebhookTargetPolicyError("WEBHOOK_TARGET_DNS_FAILED");
            }
            const normalized = addresses.map(validateResolvedAddress);
            if (
                !allowUnsafeAddresses &&
                normalized.some((address) => isForbiddenAddress(address))
            ) {
                throw new WebhookTargetPolicyError(
                    "WEBHOOK_TARGET_FORBIDDEN_ADDRESS",
                );
            }
            const selected = normalized[0];
            if (!selected) {
                throw new WebhookTargetPolicyError("WEBHOOK_TARGET_DNS_FAILED");
            }
            return Object.freeze({
                url: url.toString(),
                address: selected.address,
                family: selected.family,
            });
        },
    });
}

export function createPinnedWebhookHttpClient(options: {
    targetPolicy: WebhookTargetPolicy;
}): WebhookHttpClient {
    return Object.freeze({
        post: async (request) => {
            const target = await options.targetPolicy.resolve(request.url);
            return postPinnedTarget(target, request);
        },
    });
}

export function isWebhookTargetPolicyError(
    error: unknown,
): error is WebhookTargetPolicyError {
    return error instanceof WebhookTargetPolicyError;
}

async function resolveAllAddresses(
    hostname: string,
): Promise<readonly ResolvedAddress[]> {
    const addresses = await defaultLookup(hostname, {
        all: true,
        order: "verbatim",
    });
    return addresses.map((entry) => {
        if (entry.family !== 4 && entry.family !== 6) {
            throw new WebhookTargetPolicyError("WEBHOOK_TARGET_DNS_FAILED");
        }
        return { address: entry.address, family: entry.family };
    });
}

function parseWebhookTargetUrl(value: string, allowInsecureHttp: boolean): URL {
    if (
        Buffer.byteLength(value, "utf8") < 1 ||
        Buffer.byteLength(value, "utf8") > 4096
    ) {
        throw new WebhookTargetPolicyError("WEBHOOK_TARGET_INVALID_URL");
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new WebhookTargetPolicyError("WEBHOOK_TARGET_INVALID_URL");
    }
    if (
        url.protocol !== "https:" &&
        !(allowInsecureHttp && url.protocol === "http:")
    ) {
        throw new WebhookTargetPolicyError("WEBHOOK_TARGET_INSECURE_SCHEME");
    }
    if (
        url.username ||
        url.password ||
        url.hash ||
        !url.hostname ||
        url.hostname.endsWith(".") ||
        (url.port && (!/^\d+$/.test(url.port) || Number(url.port) > 65_535))
    ) {
        throw new WebhookTargetPolicyError("WEBHOOK_TARGET_INVALID_URL");
    }
    return url;
}

function validateResolvedAddress(address: ResolvedAddress): ResolvedAddress {
    if (
        (address.family !== 4 && address.family !== 6) ||
        isIP(address.address) !== address.family
    ) {
        throw new WebhookTargetPolicyError("WEBHOOK_TARGET_DNS_FAILED");
    }
    return Object.freeze({ address: address.address, family: address.family });
}

function isForbiddenAddress(address: ResolvedAddress): boolean {
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

function postPinnedTarget(
    target: ResolvedWebhookTarget,
    request: {
        headers: Readonly<Record<string, string>>;
        body: string;
        signal: AbortSignal;
    },
): Promise<Readonly<{ status: number; retryAfter: string | null }>> {
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
        const clientRequest = send(
            url,
            {
                method: "POST",
                headers: request.headers,
                lookup,
                agent: false,
                maxHeaderSize: 16_384,
                signal: request.signal,
            },
            (response) => {
                const result = Object.freeze({
                    status: response.statusCode ?? 0,
                    retryAfter: response.headers["retry-after"] ?? null,
                });
                settled = true;
                response.destroy();
                resolve(result);
            },
        );
        clientRequest.once("error", (error) => {
            if (!settled) reject(error);
        });
        clientRequest.end(request.body);
    });
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
