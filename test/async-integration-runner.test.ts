import { describe, expect, it, vi } from "vitest";
import {
    type AsyncIntegrationCommand,
    type AsyncIntegrationCommandRunner,
    type AsyncIntegrationSignals,
    runAsyncIntegration,
} from "../tools/run-async-integration.js";

describe("Async integration runner", () => {
    it("uses an isolated project and discovered host ports, then cleans up", async () => {
        const commands: string[] = [];
        let testEnvironment: NodeJS.ProcessEnv | undefined;
        const runner = commandRunner((command, args, environment) => {
            const invocation = [command, ...args].join(" ");
            commands.push(invocation);
            if (invocation.endsWith("port postgres 5432")) {
                return completed("0.0.0.0:61001\n");
            }
            if (invocation.endsWith("port redis 6379")) {
                return completed("0.0.0.0:61002\n");
            }
            if (command === "npm") testEnvironment = environment;
            return completed();
        });

        await runAsyncIntegration({
            projectName: "pipipi-async-test-isolated",
            runner,
            signals: inertSignals(),
            environment: {},
        });

        expect(commands[0]).toContain(
            "--project-name pipipi-async-test-isolated",
        );
        expect(testEnvironment).toMatchObject({
            POSTGRES_TEST_DATABASE_URL:
                "postgres://pipipi:pipipi-test-only@127.0.0.1:61001/pipipi_test",
            REDIS_TEST_URL: "redis://127.0.0.1:61002/15",
        });
        expect(commands.at(-1)).toContain("down --volumes --remove-orphans");
    });

    it("runs cleanup after a failed test command", async () => {
        const commands: string[] = [];
        const runner = commandRunner((command, args) => {
            const invocation = [command, ...args].join(" ");
            commands.push(invocation);
            if (invocation.endsWith("port postgres 5432")) {
                return completed("0.0.0.0:61001\n");
            }
            if (invocation.endsWith("port redis 6379")) {
                return completed("0.0.0.0:61002\n");
            }
            if (command === "npm") return failed("test failed");
            return completed();
        });

        await expect(
            runAsyncIntegration({
                projectName: "pipipi-async-test-failure",
                runner,
                signals: inertSignals(),
                environment: {},
            }),
        ).rejects.toThrow("test failed");
        expect(commands.at(-1)).toContain("down --volumes --remove-orphans");
    });

    it("reports workload and cleanup failures together", async () => {
        const runner = commandRunner((command, args) => {
            const invocation = [command, ...args].join(" ");
            if (invocation.endsWith("port postgres 5432")) {
                return completed("0.0.0.0:61001\n");
            }
            if (invocation.endsWith("port redis 6379")) {
                return completed("0.0.0.0:61002\n");
            }
            if (command === "npm") return failed("test failed");
            if (invocation.includes(" down ")) {
                return failed("cleanup failed");
            }
            return completed();
        });

        const outcome = runAsyncIntegration({
            projectName: "pipipi-async-test-combined-failure",
            runner,
            signals: inertSignals(),
            environment: {},
        });

        await expect(outcome).rejects.toMatchObject({
            name: "AggregateError",
            message:
                "Async integration cleanup failed; Docker resources may remain",
            errors: [
                expect.objectContaining({ message: "test failed" }),
                expect.objectContaining({ message: "cleanup failed" }),
            ],
        });
    });

    it("terminates interrupted work but never terminates cleanup", async () => {
        const signals = controlledSignals();
        const workloadTerminate = vi.fn();
        const cleanupTerminate = vi.fn();
        const runner = commandRunner((command, args) => {
            const invocation = [command, ...args].join(" ");
            if (invocation.endsWith("port postgres 5432")) {
                return completed("0.0.0.0:61001\n");
            }
            if (invocation.endsWith("port redis 6379")) {
                return completed("0.0.0.0:61002\n");
            }
            if (command === "npm") {
                let rejectWorkload: (error: Error) => void = () => undefined;
                const operation = {
                    completed: new Promise<string>((_resolve, reject) => {
                        rejectWorkload = reject;
                    }),
                    terminate: workloadTerminate.mockImplementation(() =>
                        rejectWorkload(new Error("terminated")),
                    ),
                };
                queueMicrotask(() => signals.emit("SIGINT"));
                return operation;
            }
            if (invocation.includes(" down ")) {
                return {
                    completed: Promise.resolve(""),
                    terminate: cleanupTerminate,
                };
            }
            return completed();
        });

        await expect(
            runAsyncIntegration({
                projectName: "pipipi-async-test-signal",
                runner,
                signals,
                environment: {},
            }),
        ).rejects.toThrow("interrupted by SIGINT");
        expect(workloadTerminate).toHaveBeenCalledWith("SIGINT");
        expect(cleanupTerminate).not.toHaveBeenCalled();
    });

    it("finishes cleanup when the first signal arrives during cleanup", async () => {
        const signals = controlledSignals();
        const cleanupTerminate = vi.fn();
        const runner = commandRunner((command, args) => {
            const invocation = [command, ...args].join(" ");
            if (invocation.endsWith("port postgres 5432")) {
                return completed("0.0.0.0:61001\n");
            }
            if (invocation.endsWith("port redis 6379")) {
                return completed("0.0.0.0:61002\n");
            }
            if (invocation.includes(" down ")) {
                queueMicrotask(() => signals.emit("SIGTERM"));
                return {
                    completed: new Promise((resolve) =>
                        queueMicrotask(() => resolve("")),
                    ),
                    terminate: cleanupTerminate,
                };
            }
            return completed();
        });

        await expect(
            runAsyncIntegration({
                projectName: "pipipi-async-test-cleanup-signal",
                runner,
                signals,
                environment: {},
            }),
        ).rejects.toThrow("interrupted by SIGTERM");
        expect(cleanupTerminate).not.toHaveBeenCalled();
    });
});

function commandRunner(
    start: AsyncIntegrationCommandRunner["start"],
): AsyncIntegrationCommandRunner {
    return { start };
}

function completed(output = ""): AsyncIntegrationCommand {
    return { completed: Promise.resolve(output), terminate: vi.fn() };
}

function failed(message: string): AsyncIntegrationCommand {
    return {
        completed: Promise.reject(new Error(message)),
        terminate: vi.fn(),
    };
}

function inertSignals(): AsyncIntegrationSignals {
    return { subscribe: () => () => undefined };
}

function controlledSignals(): AsyncIntegrationSignals & {
    emit: (signal: NodeJS.Signals) => void;
} {
    let listener: (signal: NodeJS.Signals) => void = () => undefined;
    return {
        subscribe: (operation) => {
            listener = operation;
            return () => {
                listener = () => undefined;
            };
        },
        emit: (signal) => listener(signal),
    };
}
