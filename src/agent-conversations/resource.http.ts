/** 通过受信内部 HTTP 服务解析 owner-scoped Agent 图片资源且不记录正文或 URL */
import type { OwnedAgentResourceService } from "./resource.js";

export class HttpOwnedAgentResourceService
    implements OwnedAgentResourceService
{
    readonly #baseUrl: URL;
    readonly #sharedSecret: string;
    readonly #timeoutMs: number;

    constructor(options: {
        baseUrl: string;
        sharedSecret: string;
        timeoutMs?: number;
    }) {
        this.#baseUrl = parseBaseUrl(options.baseUrl);
        if (Buffer.byteLength(options.sharedSecret, "utf8") < 32) {
            throw new Error(
                "AGENT_RESOURCE_SERVICE_SHARED_SECRET must be at least 32 bytes",
            );
        }
        this.#sharedSecret = options.sharedSecret;
        this.#timeoutMs = positiveInteger(
            options.timeoutMs ?? 10_000,
            "Agent Resource Service timeout",
        );
    }

    async ready(): Promise<void> {
        await this.#request("/readyz", "GET");
    }

    inspect(request: {
        ownerId: string;
        resourceId: string;
        purpose: "input" | "output";
        turnId?: string;
    }): Promise<unknown> {
        return this.#request("/agent-resources/inspect", "POST", request);
    }

    readModelContent(request: {
        ownerId: string;
        resourceId: string;
        signal: AbortSignal;
    }): Promise<unknown> {
        return this.#request(
            "/agent-resources/model-content",
            "POST",
            {
                ownerId: request.ownerId,
                resourceId: request.resourceId,
            },
            request.signal,
            15_000_000,
        );
    }

    createReadProjection(request: {
        ownerId: string;
        resourceId: string;
    }): Promise<unknown> {
        return this.#request(
            "/agent-resources/read-projection",
            "POST",
            request,
        );
    }

    publishProcessOutput(request: {
        ownerId: string;
        turnId: string;
        toolName: string;
        result: unknown;
    }): Promise<unknown> {
        return this.#request(
            "/agent-resources/process-output",
            "POST",
            request,
            undefined,
            262_144,
        );
    }

    async #request(
        path: string,
        method: "GET" | "POST",
        body?: unknown,
        signal?: AbortSignal,
        maximumBytes = 65_536,
    ): Promise<unknown> {
        const requestBody =
            body === undefined ? undefined : JSON.stringify(body);
        if (
            requestBody !== undefined &&
            Buffer.byteLength(requestBody, "utf8") > 300_000
        ) {
            throw new Error("Agent Resource Service request is too large");
        }
        const response = await fetch(new URL(path, this.#baseUrl), {
            method,
            headers: {
                authorization: `Bearer ${this.#sharedSecret}`,
                ...(body === undefined
                    ? {}
                    : { "content-type": "application/json" }),
            },
            ...(requestBody === undefined ? {} : { body: requestBody }),
            signal: AbortSignal.any([
                ...(signal ? [signal] : []),
                AbortSignal.timeout(this.#timeoutMs),
            ]),
        });
        if (!response.ok) {
            throw new Error("Agent Resource Service returned an error");
        }
        const text = await boundedText(response, maximumBytes);
        return text.length === 0 ? {} : JSON.parse(text);
    }
}

async function boundedText(
    response: Response,
    maximumBytes: number,
): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            totalBytes += chunk.value.byteLength;
            if (totalBytes > maximumBytes) {
                await reader.cancel();
                throw new Error("Agent Resource Service response is too large");
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseBaseUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error("AGENT_RESOURCE_SERVICE_BASE_URL is invalid");
    }
    if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== "/" && url.pathname !== "")
    ) {
        throw new Error("AGENT_RESOURCE_SERVICE_BASE_URL is invalid");
    }
    return url;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}
