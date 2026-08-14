import type { ProxyOptions } from "vite";
import {
    callerIdentityHeader,
    gatewayAuthenticationHeader,
} from "../src/api/identity.js";

export const developmentGatewayCallerId = "console:development";

type Environment = Readonly<Record<string, string | undefined>>;

export function createDevelopmentGateway(
    options: Readonly<{
        command: "build" | "serve";
        mode: string;
        environment: Environment;
    }>,
): ProxyOptions | undefined {
    const enabled = options.environment.CONSOLE_DEVELOPMENT_GATEWAY_ENABLED;
    if (enabled === undefined || enabled === "false") return undefined;
    if (enabled !== "true") {
        throw new Error(
            "CONSOLE_DEVELOPMENT_GATEWAY_ENABLED must be true or false",
        );
    }
    if (
        options.command !== "serve" ||
        options.mode !== "development" ||
        options.environment.NODE_ENV === "production"
    ) {
        throw new Error(
            "The Console development Gateway is only available from the development server",
        );
    }

    const target = readTarget(
        options.environment.CONSOLE_DEVELOPMENT_GATEWAY_TARGET,
    );
    const sharedSecret = options.environment.ASYNC_GATEWAY_SHARED_SECRET;
    if (
        sharedSecret === undefined ||
        new TextEncoder().encode(sharedSecret).byteLength < 32
    ) {
        throw new Error(
            "ASYNC_GATEWAY_SHARED_SECRET must be at least 32 bytes for the Console development Gateway",
        );
    }

    return {
        target: target.origin,
        configure: (proxy) => {
            proxy.on("proxyReq", (request) => {
                request.removeHeader(callerIdentityHeader);
                request.removeHeader(gatewayAuthenticationHeader);
                request.setHeader(
                    callerIdentityHeader,
                    developmentGatewayCallerId,
                );
                request.setHeader(gatewayAuthenticationHeader, sharedSecret);
            });
        },
    };
}

function readTarget(value: string | undefined): URL {
    let target: URL;
    try {
        target = new URL(value ?? "http://127.0.0.1:4300");
    } catch {
        throw new Error(
            "CONSOLE_DEVELOPMENT_GATEWAY_TARGET must be a loopback HTTP origin",
        );
    }
    if (
        target.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
        target.username !== "" ||
        target.password !== "" ||
        target.pathname !== "/" ||
        target.search !== "" ||
        target.hash !== ""
    ) {
        throw new Error(
            "CONSOLE_DEVELOPMENT_GATEWAY_TARGET must be a loopback HTTP origin",
        );
    }
    return target;
}
