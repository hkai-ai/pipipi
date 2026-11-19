import { describe, expect, it } from "vitest";
import { constructProcessingService } from "../src/app/api.js";
import { loadCallerAuth } from "../src/app/caller-auth.js";
import {
    assertDeploymentEnvironment,
    checkDeploymentEnvironment,
} from "../src/app/deployment-environment.js";

const base = { CRT_BUSINESS_API_BASE_URL: "http://127.0.0.1:4400" };
describe("caller authentication startup", () => {
    it.each([
        { EXECUTE_AUTH_MODE: "invalid" },
        { CALLER_AUTH_GATEWAY_FALLBACK: "yes" },
    ])("rejects malformed auth configuration %j", (environment) => {
        expect(() =>
            constructProcessingService({ ...base, ...environment }),
        ).toThrow();
        expect(() =>
            assertDeploymentEnvironment({ ...base, ...environment }, "api"),
        ).toThrow();
    });
    it("requires persistence when fallback is disabled or execute requires authentication", () => {
        for (const environment of [
            { CALLER_AUTH_GATEWAY_FALLBACK: "false" },
            { EXECUTE_AUTH_MODE: "required" },
        ])
            expect(() =>
                constructProcessingService({ ...base, ...environment }),
            ).toThrow("DATABASE_URL");
        expect(loadCallerAuth({})).toEqual({
            mode: "open",
            isGatewayFallbackEnabled: true,
        });
    });
    it.each(["ASYNC_PROCESS_RUNS_ENABLED", "AGENT_CONVERSATIONS_ENABLED"])(
        "requires the gateway secret only while fallback is enabled for %s",
        (flag) => {
            const secret =
                flag === "ASYNC_PROCESS_RUNS_ENABLED"
                    ? "ASYNC_GATEWAY_SHARED_SECRET"
                    : "AGENT_GATEWAY_SHARED_SECRET";
            const environment = {
                ...base,
                DATABASE_URL: "postgres://localhost/pipipi_test",
                [flag]: "true",
            };
            expect(
                checkDeploymentEnvironment(environment, "api")
                    .requiredVariables,
            ).toContain(secret);
            expect(
                checkDeploymentEnvironment(
                    { ...environment, CALLER_AUTH_GATEWAY_FALLBACK: "false" },
                    "api",
                ).requiredVariables,
            ).not.toContain(secret);
        },
    );
});
