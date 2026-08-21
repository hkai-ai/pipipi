/** 按 Role 声明并校验部署所需的环境变量，缺失或生产环境不合规时报错 */
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
    "availability-monitor",
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
            "PROCESS_RUN_RECORD_STORE",
            "PROCESS_RUN_RECORD_CONTENT",
        ]),
        "webhook-worker": Object.freeze([
            "DATABASE_URL",
            "REDIS_URL",
            "WEBHOOK_SECRET_ENCRYPTION_KEY",
        ]),
        "retention-cleaner": Object.freeze(["DATABASE_URL"]),
        "async-operations": Object.freeze(["DATABASE_URL", "REDIS_URL"]),
        "process-recovery": Object.freeze(["DATABASE_URL", "REDIS_URL"]),
        "availability-monitor": Object.freeze([
            "PIPIPI_REVISION",
            "AVAILABILITY_PUBLIC_BASE_URL",
            "AVAILABILITY_WEBHOOK_URL",
        ]),
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
 * release when they are written outside the container: a host volume for the
 * file store, a database for the PostgreSQL store.
 */
function consoleApiVariables(
    environment: StartupEnvironment,
): readonly string[] {
    return environment.PROCESS_RUN_RECORD_STORE === "postgres"
        ? Object.freeze(["DATABASE_URL"])
        : Object.freeze(["PROCESS_RUN_RECORD_DIRECTORY"]);
}

function processWorkerObservationVariables(
    environment: StartupEnvironment,
): readonly string[] {
    return environment.PROCESS_RUN_RECORD_STORE === "postgres"
        ? Object.freeze([])
        : Object.freeze(["PROCESS_RUN_RECORD_DIRECTORY"]);
}

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
            ? consoleApiVariables(environment)
            : []),
        ...(role === "api" &&
        environment.PROCESS_RUN_RECORD_STORE === "postgres"
            ? ["DATABASE_URL"]
            : []),
        ...(role === "process-worker"
            ? processWorkerObservationVariables(environment)
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
    if (missingVariables.length > 0) {
        throw new Error(
            `Deployment environment for ${role} is missing required variables: ${missingVariables.join(", ")}`,
        );
    }
    if (role === "process-worker" && environment.NODE_ENV === "production") {
        if (environment.PROCESS_RUN_RECORD_STORE !== "postgres") {
            throw new Error(
                "Production Process Worker requires PROCESS_RUN_RECORD_STORE=postgres",
            );
        }
        if (
            environment.PROCESS_RUN_RECORD_CONTENT !==
            "accepted-input-and-output"
        ) {
            throw new Error(
                "Production Process Worker requires PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output",
            );
        }
    }
}

export function parseDeploymentRole(value: string | undefined): DeploymentRole {
    const candidate = value?.trim();
    const role = deploymentRoles.find((entry) => entry === candidate);
    if (role) return role;

    throw new Error(
        `Deployment role must be one of: ${deploymentRoles.join(", ")}`,
    );
}
