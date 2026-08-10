import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    assertDeploymentEnvironment,
    checkDeploymentEnvironment,
    deploymentRoles,
    parseDeploymentRole,
} from "../src/app/deployment-environment.js";

describe("Deployment environment", () => {
    it("requires only the Business Capability URL for the synchronous API", () => {
        expect(checkDeploymentEnvironment({}, "api")).toEqual({
            role: "api",
            requiredVariables: ["BUSINESS_API_BASE_URL"],
            missingVariables: ["BUSINESS_API_BASE_URL"],
        });
        expect(
            checkDeploymentEnvironment(
                {
                    BUSINESS_API_BASE_URL: "https://business.example",
                    ASYNC_PROCESS_RUNS_ENABLED: "false",
                },
                "api",
            ).missingVariables,
        ).toEqual([]);
    });

    it("reports every missing variable when the API enables Async Process Runs", () => {
        const check = checkDeploymentEnvironment(
            {
                BUSINESS_API_BASE_URL: "https://business.example",
                ASYNC_PROCESS_RUNS_ENABLED: "true",
                DATABASE_URL: "   ",
            },
            "api",
        );

        expect(check.missingVariables).toEqual([
            "DATABASE_URL",
            "ASYNC_GATEWAY_SHARED_SECRET",
            "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
            "PROCESS_RUN_RESULT_RETENTION_MS",
            "PROCESS_RUN_METADATA_RETENTION_MS",
            "ASYNC_RELEASE_STAGE",
            "ASYNC_GLOBAL_BACKLOG_LIMIT",
            "ASYNC_CALLER_BACKLOG_LIMIT",
            "ASYNC_BACKLOG_RETRY_AFTER_SECONDS",
        ]);
    });

    it("requires the OpenAI credential for Agent deployment roles when selected", () => {
        const environment = {
            BUSINESS_API_BASE_URL: "https://business.example",
            PI_PROVIDER: "openai",
        };

        expect(
            checkDeploymentEnvironment(environment, "api").missingVariables,
        ).toEqual([]);
        expect(
            checkDeploymentEnvironment(environment, "api", {
                includeProviderCredentials: true,
            }),
        ).toEqual({
            role: "api",
            requiredVariables: ["BUSINESS_API_BASE_URL", "OPENAI_API_KEY"],
            missingVariables: ["OPENAI_API_KEY"],
        });
        expect(
            checkDeploymentEnvironment(environment, "process-dispatcher", {
                includeProviderCredentials: true,
            }).requiredVariables,
        ).toEqual(["DATABASE_URL", "REDIS_URL"]);
    });

    it.each([
        ["process-dispatcher", ["DATABASE_URL", "REDIS_URL"]],
        [
            "process-worker",
            [
                "BUSINESS_API_BASE_URL",
                "DATABASE_URL",
                "REDIS_URL",
                "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
                "PROCESS_RUN_RESULT_RETENTION_MS",
                "PROCESS_RUN_METADATA_RETENTION_MS",
            ],
        ],
        [
            "webhook-worker",
            ["DATABASE_URL", "REDIS_URL", "WEBHOOK_SECRET_ENCRYPTION_KEY"],
        ],
        ["retention-cleaner", ["DATABASE_URL"]],
        ["async-operations", ["DATABASE_URL", "REDIS_URL"]],
        ["process-recovery", ["DATABASE_URL", "REDIS_URL"]],
    ] as const)("defines the required variables for %s", (role, variables) => {
        expect(checkDeploymentEnvironment({}, role)).toEqual({
            role,
            requiredVariables: variables,
            missingVariables: variables,
        });
    });

    it("fails once with every missing name and no configured values", () => {
        const databaseUrl =
            "postgres://service:secret-value@database.example/pipipi";

        expect(() =>
            assertDeploymentEnvironment(
                { DATABASE_URL: databaseUrl },
                "process-worker",
            ),
        ).toThrow(
            "Deployment environment for process-worker is missing required variables: BUSINESS_API_BASE_URL, REDIS_URL, PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS, PROCESS_RUN_RESULT_RETENTION_MS, PROCESS_RUN_METADATA_RETENTION_MS",
        );

        try {
            assertDeploymentEnvironment(
                { DATABASE_URL: databaseUrl },
                "process-worker",
            );
        } catch (error) {
            expect((error as Error).message).not.toContain(databaseUrl);
            expect((error as Error).message).not.toContain("secret-value");
        }
    });

    it("parses only explicit supported roles", () => {
        for (const role of deploymentRoles) {
            expect(parseDeploymentRole(role)).toBe(role);
        }
        expect(() => parseDeploymentRole(undefined)).toThrow(
            "Deployment role must be one of",
        );
        expect(() => parseDeploymentRole("worker")).toThrow(
            "Deployment role must be one of",
        );
    });

    it("keeps every required variable in .env.example", () => {
        const example = readFileSync(
            new URL("../.env.example", import.meta.url),
            "utf8",
        );
        const documented = new Set(
            [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map(
                ([, name]) => name,
            ),
        );
        const required = new Set<string>();
        for (const role of deploymentRoles) {
            const environment = {
                ...(role === "api"
                    ? { ASYNC_PROCESS_RUNS_ENABLED: "true" }
                    : {}),
                ...(role === "api" || role === "process-worker"
                    ? { PI_PROVIDER: "openai" }
                    : {}),
            };
            for (const name of checkDeploymentEnvironment(environment, role, {
                includeProviderCredentials: true,
            }).requiredVariables) {
                required.add(name);
            }
        }

        expect([...required].filter((name) => !documented.has(name))).toEqual(
            [],
        );
    });
});
