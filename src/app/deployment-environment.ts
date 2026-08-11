import type { StartupEnvironment } from "./config.js";

export const deploymentRoles = Object.freeze([
    "api",
    "crt-business-api",
    "process-dispatcher",
    "process-worker",
    "webhook-worker",
    "retention-cleaner",
    "async-operations",
    "process-recovery",
] as const);

export type DeploymentRole = (typeof deploymentRoles)[number];

export type DeploymentEnvironmentCheck = Readonly<{
    role: DeploymentRole;
    requiredVariables: readonly string[];
    missingVariables: readonly string[];
}>;

export type DeploymentEnvironmentCheckOptions = Readonly<{
    includeProviderCredentials?: boolean;
}>;

const variablesByRole: Readonly<Record<DeploymentRole, readonly string[]>> =
    Object.freeze({
        api: Object.freeze(["BUSINESS_API_BASE_URL"]),
        "crt-business-api": Object.freeze([
            "IMAGE_PROVIDER",
            "FAL_KEY",
            "OBJECT_STORAGE_PROVIDER",
            "OSS_REGION",
            "OSS_BUCKET",
            "OSS_ACCESS_KEY_ID",
            "OSS_ACCESS_KEY_SECRET",
        ]),
        "process-dispatcher": Object.freeze(["DATABASE_URL", "REDIS_URL"]),
        "process-worker": Object.freeze([
            "BUSINESS_API_BASE_URL",
            "DATABASE_URL",
            "REDIS_URL",
            "PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS",
            "PROCESS_RUN_RESULT_RETENTION_MS",
            "PROCESS_RUN_METADATA_RETENTION_MS",
        ]),
        "webhook-worker": Object.freeze([
            "DATABASE_URL",
            "REDIS_URL",
            "WEBHOOK_SECRET_ENCRYPTION_KEY",
        ]),
        "retention-cleaner": Object.freeze(["DATABASE_URL"]),
        "async-operations": Object.freeze(["DATABASE_URL", "REDIS_URL"]),
        "process-recovery": Object.freeze(["DATABASE_URL", "REDIS_URL"]),
    });

const asyncApiVariables = Object.freeze([
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

/**
 * The console can only show what was recorded, and records only survive a
 * release when they are written to a directory outside the container.
 */
const consoleApiVariables = Object.freeze(["PROCESS_RUN_RECORD_DIRECTORY"]);

const agentRoles: readonly DeploymentRole[] = Object.freeze([
    "api",
    "process-worker",
]);

export function checkDeploymentEnvironment(
    environment: StartupEnvironment,
    role: DeploymentRole,
    options: DeploymentEnvironmentCheckOptions = {},
): DeploymentEnvironmentCheck {
    const requiredVariables = Object.freeze([
        ...variablesByRole[role],
        ...(role === "api" && environment.ASYNC_PROCESS_RUNS_ENABLED === "true"
            ? asyncApiVariables
            : []),
        ...(role === "api" && environment.CONSOLE_ENABLED === "true"
            ? consoleApiVariables
            : []),
        ...(options.includeProviderCredentials &&
        agentRoles.includes(role) &&
        environment.PI_PROVIDER === "openai"
            ? ["OPENAI_API_KEY"]
            : []),
    ]);
    const missingVariables = Object.freeze(
        requiredVariables.filter((name) => !environment[name]?.trim()),
    );

    return Object.freeze({ role, requiredVariables, missingVariables });
}

export function assertDeploymentEnvironment(
    environment: StartupEnvironment,
    role: DeploymentRole,
    options: DeploymentEnvironmentCheckOptions = {},
): void {
    const { missingVariables } = checkDeploymentEnvironment(
        environment,
        role,
        options,
    );
    if (missingVariables.length === 0) return;

    throw new Error(
        `Deployment environment for ${role} is missing required variables: ${missingVariables.join(", ")}`,
    );
}

export function parseDeploymentRole(value: string | undefined): DeploymentRole {
    const candidate = value?.trim();
    const role = deploymentRoles.find((entry) => entry === candidate);
    if (role) return role;

    throw new Error(
        `Deployment role must be one of: ${deploymentRoles.join(", ")}`,
    );
}
