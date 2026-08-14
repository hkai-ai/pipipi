import { spawnSync } from "node:child_process";

type ComposeService = Readonly<{
    image?: string;
    command?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    healthcheck?: Readonly<{ test?: readonly string[] }>;
    labels?: Readonly<Record<string, string>>;
}>;

type ComposeModel = Readonly<{
    services?: Readonly<Record<string, ComposeService>>;
}>;

const baseFile = "compose.production.yaml";
const asyncFile = "compose.production.async.yaml";
const validationImage = "pipipi:async-compose-validation";
const validationRevision = "async-compose-validation";

const requiredAsyncServices = Object.freeze([
    "api",
    "process-dispatcher",
    "process-worker",
    "webhook-worker",
    "retention-cleaner",
] as const);

const startupEntryByService = Object.freeze({
    api: "dist/bin/api.js",
    "process-dispatcher": "dist/bin/dispatcher.js",
    "process-worker": "dist/bin/process-worker.js",
    "webhook-worker": "dist/bin/webhook-worker.js",
    "retention-cleaner": "dist/bin/retention-cleaner.js",
});

const portByService = Object.freeze({
    api: "4300",
    "process-dispatcher": "4310",
    "process-worker": "4320",
    "webhook-worker": "4330",
    "retention-cleaner": "4340",
});

const validationEnvironment = Object.freeze({
    PIPIPI_IMAGE: validationImage,
    PIPIPI_REVISION: validationRevision,
    PIPIPI_ENV_FILE: "/dev/null",
    PIPIPI_ASYNC_RELEASE_STAGE: "internal",
    PIPIPI_ASYNC_API_ENV_FILE: "/dev/null",
    PIPIPI_ASYNC_CONTROL_DIRECTORY: "/tmp/pipipi-async-control",
    PIPIPI_PROCESS_DISPATCHER_ENV_FILE: "/dev/null",
    PIPIPI_PROCESS_WORKER_ENV_FILE: "/dev/null",
    PIPIPI_WEBHOOK_WORKER_ENV_FILE: "/dev/null",
    PIPIPI_RETENTION_CLEANER_ENV_FILE: "/dev/null",
    PIPIPI_PROCESS_QUEUE_NAME: "process-runs-validation",
    PIPIPI_PROCESS_QUEUE_PREFIX: "pipipi-validation",
    PIPIPI_WEBHOOK_QUEUE_NAME: "webhook-deliveries-validation",
    PIPIPI_WEBHOOK_QUEUE_PREFIX: "pipipi-validation",
});

export function checkAsyncProductionCompose(): void {
    checkComposeVersion();
    const base = renderCompose([baseFile], validationEnvironment);
    const baseServices = services(base);
    equal(
        Object.keys(baseServices).sort(),
        ["api", "business-api"],
        "The default production shape must contain only the API and Business API",
    );
    assert(
        baseServices.api?.environment?.ASYNC_PROCESS_RUNS_ENABLED === "false",
        "The default production API must keep ASYNC_PROCESS_RUNS_ENABLED=false",
    );

    const asyncShape = renderCompose(
        [baseFile, asyncFile],
        validationEnvironment,
    );
    const asyncServices = services(asyncShape);
    equal(
        Object.keys(asyncServices).sort(),
        [...requiredAsyncServices, "business-api"].sort(),
        "The explicit async shape has an unexpected service set",
    );
    for (const forbiddenService of ["postgres", "postgresql", "redis"]) {
        assert(
            asyncServices[forbiddenService] === undefined,
            `The async production shape must not embed ${forbiddenService}`,
        );
    }

    for (const serviceName of requiredAsyncServices) {
        const service = asyncServices[serviceName];
        assert(service, `Missing async production service: ${serviceName}`);
        assert(
            service.image === validationImage,
            `${serviceName} must use the release image`,
        );
        assert(
            service.labels?.["com.pipipi.revision"] === validationRevision,
            `${serviceName} must carry the release revision`,
        );
        const command = service.command?.join(" ") ?? "";
        assert(
            command.includes(
                `check-deployment-environment.js ${serviceName}`,
            ),
            `${serviceName} must run its deployment environment precheck`,
        );
        assert(
            command.includes(`exec node ${startupEntryByService[serviceName]}`),
            `${serviceName} must own its startup entrypoint`,
        );
        assert(
            service.environment?.PORT === portByService[serviceName],
            `${serviceName} must declare its expected unique port`,
        );
        assert(
            service.healthcheck?.test
                ?.join(" ")
                .includes(
                    `http://127.0.0.1:${portByService[serviceName]}/readyz`,
                ) === true,
            `${serviceName} readiness must probe its own declared port`,
        );
    }
    assert(
        new Set(Object.values(portByService)).size === requiredAsyncServices.length,
        "Every async production role must use a unique readiness port",
    );

    assert(
        asyncServices.api?.environment?.ASYNC_PROCESS_RUNS_ENABLED === "true",
        "The explicit async production API must enable Async Process Runs",
    );
    assert(
        asyncServices.api?.environment
            ?.ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE ===
            "/var/lib/pipipi-async-control/intake-disabled",
        "The explicit async production API must expose the intake control marker",
    );
    assert(
        asyncServices.api?.environment?.ASYNC_RELEASE_STAGE === "internal",
        "The explicit async production API must receive the selected release stage",
    );
    assertQueuePair(
        asyncServices,
        "process-dispatcher",
        "process-worker",
        "PROCESS_QUEUE_NAME",
        "PROCESS_QUEUE_PREFIX",
    );
    assert(
        asyncServices["webhook-worker"]?.environment?.WEBHOOK_QUEUE_NAME ===
            validationEnvironment.PIPIPI_WEBHOOK_QUEUE_NAME,
        "The Webhook Worker must receive the explicit Webhook queue name",
    );
    assert(
        asyncServices["webhook-worker"]?.environment?.WEBHOOK_QUEUE_PREFIX ===
            validationEnvironment.PIPIPI_WEBHOOK_QUEUE_PREFIX,
        "The Webhook Worker must receive the explicit Webhook queue prefix",
    );

    for (const variable of [
        "PIPIPI_IMAGE",
        "PIPIPI_REVISION",
        "PIPIPI_ASYNC_RELEASE_STAGE",
        "PIPIPI_ASYNC_API_ENV_FILE",
        "PIPIPI_PROCESS_DISPATCHER_ENV_FILE",
        "PIPIPI_PROCESS_WORKER_ENV_FILE",
        "PIPIPI_WEBHOOK_WORKER_ENV_FILE",
        "PIPIPI_RETENTION_CLEANER_ENV_FILE",
        "PIPIPI_PROCESS_QUEUE_NAME",
        "PIPIPI_PROCESS_QUEUE_PREFIX",
        "PIPIPI_WEBHOOK_QUEUE_NAME",
        "PIPIPI_WEBHOOK_QUEUE_PREFIX",
    ] as const) {
        expectRenderFailure(variable);
    }

    console.log(
        JSON.stringify({
            event: "async_production_compose_check_passed",
            services: Object.keys(asyncServices).sort(),
        }),
    );
}

function assertQueuePair(
    composeServices: Readonly<Record<string, ComposeService>>,
    firstName: string,
    secondName: string,
    queueNameKey: string,
    queuePrefixKey: string,
): void {
    const first = composeServices[firstName]?.environment;
    const second = composeServices[secondName]?.environment;
    assert(
        first?.[queueNameKey] === second?.[queueNameKey] &&
            first?.[queueNameKey] ===
                validationEnvironment.PIPIPI_PROCESS_QUEUE_NAME,
        `${firstName} and ${secondName} must share ${queueNameKey}`,
    );
    assert(
        first?.[queuePrefixKey] === second?.[queuePrefixKey] &&
            first?.[queuePrefixKey] ===
                validationEnvironment.PIPIPI_PROCESS_QUEUE_PREFIX,
        `${firstName} and ${secondName} must share ${queuePrefixKey}`,
    );
}

function expectRenderFailure(
    missingVariable: keyof typeof validationEnvironment,
): void {
    const environment = { ...validationEnvironment };
    delete environment[missingVariable];
    const result = runCompose([baseFile, asyncFile], environment);
    assert(
        result.status !== 0,
        `Async production shape must reject missing ${missingVariable}`,
    );
    assert(
        `${result.stderr}\n${result.stdout}`.includes(
            `${missingVariable} is required`,
        ),
        `Missing ${missingVariable} must produce a clear error`,
    );
}

function renderCompose(
    files: readonly string[],
    environment: Readonly<Record<string, string>>,
): ComposeModel {
    const result = runCompose(files, environment);
    if (result.status !== 0) {
        throw new Error(
            `Unable to render ${files.join(" + ")}: ${result.stderr || result.stdout}`,
        );
    }
    return JSON.parse(result.stdout) as ComposeModel;
}

function checkComposeVersion(): void {
    const result = spawnSync("docker", ["compose", "version", "--short"], {
        encoding: "utf8",
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(
            `Docker Compose 2.24.4 or newer is required: ${result.stderr || result.stdout}`,
        );
    }
    const match = result.stdout.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    assert(match, "Unable to parse the Docker Compose version");
    const version = match.slice(1).map(Number);
    const minimum = [2, 24, 4];
    const supported = version.some(
        (part, index) =>
            part > minimum[index] &&
            version.slice(0, index).every((value, i) => value === minimum[i]),
    ) || version.every((part, index) => part === minimum[index]);
    assert(supported, "Docker Compose 2.24.4 or newer is required");
}

function runCompose(
    files: readonly string[],
    environment: Readonly<Record<string, string>>,
): ReturnType<typeof spawnSync> {
    const arguments_ = [
        "compose",
        "--env-file",
        "/dev/null",
        ...files.flatMap((file) => ["--file", file]),
        "config",
        "--no-env-resolution",
        "--format",
        "json",
    ];
    const inheritedEnvironment = { ...process.env };
    for (const variable of Object.keys(inheritedEnvironment)) {
        if (
            variable.startsWith("PIPIPI_") ||
            variable.startsWith("COMPOSE_")
        ) {
            delete inheritedEnvironment[variable];
        }
    }
    return spawnSync("docker", arguments_, {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
            ...inheritedEnvironment,
            COMPOSE_DISABLE_ENV_FILE: "1",
            ...environment,
        },
        maxBuffer: 10 * 1024 * 1024,
    });
}

function services(model: ComposeModel): Readonly<Record<string, ComposeService>> {
    assert(model.services, "Rendered Compose model is missing services");
    return model.services;
}

function equal(
    actual: readonly string[],
    expected: readonly string[],
    message: string,
): void {
    assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

checkAsyncProductionCompose();
