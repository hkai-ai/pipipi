import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type AsyncIntegrationCommand = Readonly<{
    completed: Promise<string>;
    terminate: (signal: NodeJS.Signals) => void;
}>;

export type AsyncIntegrationCommandRunner = Readonly<{
    start: (
        command: string,
        args: readonly string[],
        environment: NodeJS.ProcessEnv,
        shouldCaptureOutput?: boolean,
    ) => AsyncIntegrationCommand;
}>;

export type AsyncIntegrationSignals = Readonly<{
    subscribe: (
        operation: (signal: NodeJS.Signals) => void,
    ) => () => void;
}>;

export async function runAsyncIntegration(options: Readonly<{
    projectName: string;
    runner: AsyncIntegrationCommandRunner;
    signals: AsyncIntegrationSignals;
    environment: NodeJS.ProcessEnv;
    testScript?: string;
}>): Promise<void> {
    const compose = [
        "compose",
        "--project-name",
        options.projectName,
        "--file",
        "compose.integration.yaml",
    ];
    const composeEnvironment = {
        ...options.environment,
        PIPIPI_POSTGRES_PORT: "0",
        PIPIPI_REDIS_PORT: "0",
    };
    let active: AsyncIntegrationCommand | undefined;
    let interrupted: NodeJS.Signals | undefined;
    let isCleaning = false;
    const unsubscribe = options.signals.subscribe((signal) => {
        if (interrupted) return;
        interrupted = signal;
        if (!isCleaning) active?.terminate(signal);
    });
    const execute = async (
        command: string,
        args: readonly string[],
        environment: NodeJS.ProcessEnv,
        shouldCaptureOutput = false,
    ): Promise<string> => {
        if (interrupted) throw new AsyncIntegrationInterrupted(interrupted);
        const started = options.runner.start(
            command,
            args,
            environment,
            shouldCaptureOutput,
        );
        active = started;
        try {
            return await started.completed;
        } finally {
            if (active === started) active = undefined;
        }
    };

    let failure: unknown;
    let hasFailed = false;
    let cleanupFailure: unknown;
    let hasCleanupFailed = false;
    try {
        await execute(
            "docker",
            [...compose, "up", "--detach", "--wait"],
            composeEnvironment,
        );
        const postgresPort = readPort(
            await execute(
                "docker",
                [...compose, "port", "postgres", "5432"],
                composeEnvironment,
                true,
            ),
        );
        const redisPort = readPort(
            await execute(
                "docker",
                [...compose, "port", "redis", "6379"],
                composeEnvironment,
                true,
            ),
        );
        await execute(
            "npm",
            ["run", options.testScript ?? "test:integration:async"],
            {
                ...options.environment,
                POSTGRES_TEST_DATABASE_URL: `postgres://pipipi:pipipi-test-only@127.0.0.1:${postgresPort}/pipipi_test`,
                REDIS_TEST_URL: `redis://127.0.0.1:${redisPort}/15`,
            },
        );
    } catch (error) {
        hasFailed = true;
        failure = error;
    } finally {
        isCleaning = true;
        active = undefined;
        try {
            await options.runner.start(
                "docker",
                [...compose, "down", "--volumes", "--remove-orphans"],
                composeEnvironment,
            ).completed;
        } catch (error) {
            hasCleanupFailed = true;
            cleanupFailure = error;
        } finally {
            unsubscribe();
        }
    }

    if (hasCleanupFailed) {
        throw new AggregateError(
            [
                ...(interrupted
                    ? [new AsyncIntegrationInterrupted(interrupted)]
                    : []),
                ...(hasFailed ? [failure] : []),
                cleanupFailure,
            ],
            "Async integration cleanup failed; Docker resources may remain",
        );
    }
    if (interrupted) throw new AsyncIntegrationInterrupted(interrupted);
    if (hasFailed) throw failure;
}

class AsyncIntegrationInterrupted extends Error {
    constructor(readonly signal: NodeJS.Signals) {
        super(`Async integration interrupted by ${signal}`);
        this.name = "AsyncIntegrationInterrupted";
    }
}

function readPort(output: string): number {
    const match = /:(\d+)\s*$/.exec(output);
    const port = Number(match?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Docker Compose did not return a published test port");
    }
    return port;
}

function createCommandRunner(): AsyncIntegrationCommandRunner {
    return {
        start: (command, args, environment, shouldCaptureOutput = false) => {
            const child = spawn(command, args, {
                cwd: process.cwd(),
                env: environment,
                stdio: shouldCaptureOutput
                    ? ["ignore", "pipe", "inherit"]
                    : "inherit",
            });
            let output = "";
            child.stdout?.setEncoding("utf8");
            child.stdout?.on("data", (chunk: string) => {
                output += chunk;
            });
            return {
                completed: new Promise((resolveCompletion, reject) => {
                    child.once("error", reject);
                    child.once("exit", (code, signal) => {
                        if (code === 0) resolveCompletion(output);
                        else {
                            reject(
                                new Error(
                                    `${command} exited with ${signal ?? `status ${code ?? "unknown"}`}`,
                                ),
                            );
                        }
                    });
                }),
                terminate: (signal) => {
                    child.kill(signal);
                },
            };
        },
    };
}

function processSignals(): AsyncIntegrationSignals {
    return {
        subscribe: (operation) => {
            const onInterrupt = () => operation("SIGINT");
            const onTerminate = () => operation("SIGTERM");
            process.on("SIGINT", onInterrupt);
            process.on("SIGTERM", onTerminate);
            return () => {
                process.off("SIGINT", onInterrupt);
                process.off("SIGTERM", onTerminate);
            };
        },
    };
}

async function main(): Promise<void> {
    try {
        await runAsyncIntegration({
            projectName: parseProjectName(
                process.env.ASYNC_INTEGRATION_PROJECT_NAME ??
                    createProjectName(),
            ),
            runner: createCommandRunner(),
            signals: processSignals(),
            environment: process.env,
            testScript: process.env.ASYNC_INTEGRATION_TEST_SCRIPT,
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode =
            error instanceof AsyncIntegrationInterrupted ? 130 : 1;
    }
}

function createProjectName(): string {
    return `pipipi-async-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export function parseProjectName(value: string): string {
    if (value.length > 63 || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
        throw new Error(
            "ASYNC_INTEGRATION_PROJECT_NAME must be a lowercase Docker Compose project name of at most 63 characters",
        );
    }
    return value;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    await main();
}
