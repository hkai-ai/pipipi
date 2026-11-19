/** 校验调用方认证配置并为各业务入口组装同一身份解析接缝。 */
import {
    createCompositeCallerIdentityResolver,
    createGatewayCallerIdentityResolver,
} from "../api/identity.js";
import type { CallerApiKeyStore } from "../caller-api-keys/index.js";
import {
    parseBoolean,
    parseConnectionUrl,
    type StartupEnvironment,
} from "./config.js";
export function loadCallerAuth(environment: StartupEnvironment) {
    const mode = environment.EXECUTE_AUTH_MODE ?? "open";
    if (mode !== "open" && mode !== "audit" && mode !== "required")
        throw new Error("EXECUTE_AUTH_MODE must be open, audit, or required");
    const isGatewayFallbackEnabled = parseBoolean(
        environment.CALLER_AUTH_GATEWAY_FALLBACK,
        true,
        "CALLER_AUTH_GATEWAY_FALLBACK",
    );
    if (!isGatewayFallbackEnabled || mode === "required") {
        parseConnectionUrl(environment.DATABASE_URL, {
            protocols: ["postgres:", "postgresql:"],
            requirePath: true,
            missingMessage:
                "DATABASE_URL is required for persistent caller authentication",
            invalidMessage: "DATABASE_URL must be a PostgreSQL connection URL",
        });
    }
    return { mode, isGatewayFallbackEnabled } as const;
}
export function createCallerIdentity(
    environment: StartupEnvironment,
    store: CallerApiKeyStore,
    secretName: "ASYNC_GATEWAY_SHARED_SECRET" | "AGENT_GATEWAY_SHARED_SECRET",
) {
    const { isGatewayFallbackEnabled } = loadCallerAuth(environment);
    const secret = environment[secretName];
    const gateway =
        isGatewayFallbackEnabled && secret
            ? createGatewayCallerIdentityResolver({
                  sharedSecret: secret,
                  secretName,
              })
            : undefined;
    if (
        isGatewayFallbackEnabled &&
        !secret &&
        (secretName === "ASYNC_GATEWAY_SHARED_SECRET"
            ? environment.ASYNC_PROCESS_RUNS_ENABLED === "true"
            : environment.AGENT_CONVERSATIONS_ENABLED === "true")
    )
        throw new Error(
            `${secretName} is required when gateway fallback is enabled`,
        );
    return createCompositeCallerIdentityResolver({ store, gateway });
}
