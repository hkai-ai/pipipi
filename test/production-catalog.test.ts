import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    createProcessAttemptRunner,
    defineProcessRegistration,
    type ProcessRegistration,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import {
    buildProductionRegistrations,
    defineProductionProcess,
    type ProductionBuildOptions,
    type ProductionContext,
    type ProductionProcess,
} from "../src/processes/production.js";

function defineEchoRegistration(
    id: string,
    options: { version?: string; timeoutMs?: number } = {},
): ProcessRegistration {
    return defineProcessRegistration({
        id,
        version: options.version ?? "v1",
        inputSchema: z.strictObject({ value: z.string() }),
        outputSchema: z.strictObject({ value: z.string() }),
        activities: ["echo"],
        ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        execute: async (input, context) =>
            context.runActivity("echo", () => ({
                value: `${id}:${input.value}`,
            })),
    });
}

function buildOptions(
    catalog: readonly ProductionProcess[],
    overrides: Partial<ProductionBuildOptions> = {},
): ProductionBuildOptions {
    return {
        catalog,
        environment: {},
        pi: {},
        skills: {},
        positiveInteger: (_name, fallback) => fallback,
        attemptRunner: createProcessAttemptRunner(),
        ...overrides,
    };
}

describe("production catalog assembly", () => {
    it("builds standalone Processes with an empty Member set", () => {
        const contexts: ProductionContext[] = [];
        const catalog = [
            defineProductionProcess({
                id: "alpha",
                build: (context) => {
                    contexts.push(context);
                    return defineEchoRegistration("alpha");
                },
            }),
        ];

        const registrations = buildProductionRegistrations(
            buildOptions(catalog, { skills: { alpha: [] } }),
        );

        expect(registrations.map((r) => r.identity.id)).toEqual(["alpha"]);
        expect(contexts[0]?.members.registry.list()).toEqual([]);
        expect(contexts[0]?.skills).toEqual([]);
    });

    it("skips a disabled Process and everything it would install", () => {
        let built = 0;
        const catalog = [
            defineProductionProcess({
                id: "alpha",
                build: () => defineEchoRegistration("alpha"),
            }),
            defineProductionProcess({
                id: "beta",
                enabled: (environment) => environment.BETA_ENABLED === "true",
                build: () => {
                    built += 1;
                    return defineEchoRegistration("beta");
                },
            }),
        ];

        const off = buildProductionRegistrations(buildOptions(catalog));
        const on = buildProductionRegistrations(
            buildOptions(catalog, { environment: { BETA_ENABLED: "true" } }),
        );

        expect(off.map((r) => r.identity.id)).toEqual(["alpha"]);
        expect(on.map((r) => r.identity.id)).toEqual(["alpha", "beta"]);
        expect(built).toBe(1);
    });

    it("hands a composing Process exactly its declared Members, already built", async () => {
        const records: ProcessRunLogRecord[] = [];
        let members: ProductionContext["members"] | undefined;
        const catalog = [
            defineProductionProcess({
                id: "alpha",
                build: () => defineEchoRegistration("alpha"),
            }),
            defineProductionProcess({
                id: "beta",
                build: () => defineEchoRegistration("beta"),
            }),
            defineProductionProcess({
                id: "composer",
                members: [{ id: "alpha", version: "v1" }],
                build: (context) => {
                    members = context.members;
                    return defineEchoRegistration("composer");
                },
            }),
        ];

        const registrations = buildProductionRegistrations(
            buildOptions(catalog, {
                attemptRunner: createProcessAttemptRunner({
                    logSink: (record) => {
                        records.push(record);
                    },
                }),
            }),
        );

        expect(registrations.map((r) => r.identity.id)).toEqual([
            "alpha",
            "beta",
            "composer",
        ]);
        expect(members?.registry.list().map((r) => r.identity.id)).toEqual([
            "alpha",
        ]);
        expect(
            members?.registry.find({ id: "beta", version: "v1" }),
        ).toBeUndefined();

        const alpha = members?.registry.find({ id: "alpha", version: "v1" });
        const acceptance = alpha?.accept({ value: "step" });
        if (!alpha || !acceptance?.accepted) throw new Error("unexpected");
        const result = await members?.attemptRunner.run({
            runId: "parent.1",
            registration: alpha,
            acceptedInput: acceptance.acceptedInput,
        });

        expect(result).toMatchObject({
            runId: "parent.1",
            status: "succeeded",
            output: { value: "alpha:step" },
        });
        expect(records.map((record) => record.event)).toEqual([
            "process_run_attempt_started",
            "process_run_activity_started",
            "process_run_activity_finished",
            "process_run_attempt_finished",
        ]);
        expect(records.every((record) => record.runId === "parent.1")).toBe(
            true,
        );
    });

    it.each([
        {
            reason: "is not in the catalog",
            catalog: [
                defineProductionProcess({
                    id: "composer",
                    members: [{ id: "missing", version: "v1" }],
                    build: () => defineEchoRegistration("composer"),
                }),
            ],
            member: "missing/v1",
        },
        {
            reason: "has a different version",
            catalog: [
                defineProductionProcess({
                    id: "alpha",
                    build: () => defineEchoRegistration("alpha"),
                }),
                defineProductionProcess({
                    id: "composer",
                    members: [{ id: "alpha", version: "v2" }],
                    build: () => defineEchoRegistration("composer"),
                }),
            ],
            member: "alpha/v2",
        },
        {
            reason: "is disabled",
            catalog: [
                defineProductionProcess({
                    id: "alpha",
                    enabled: () => false,
                    build: () => defineEchoRegistration("alpha"),
                }),
                defineProductionProcess({
                    id: "composer",
                    members: [{ id: "alpha", version: "v1" }],
                    build: () => defineEchoRegistration("composer"),
                }),
            ],
            member: "alpha/v1",
        },
        {
            reason: "composes Members itself",
            catalog: [
                defineProductionProcess({
                    id: "alpha",
                    build: () => defineEchoRegistration("alpha"),
                }),
                defineProductionProcess({
                    id: "inner",
                    members: [{ id: "alpha", version: "v1" }],
                    build: () => defineEchoRegistration("inner"),
                }),
                defineProductionProcess({
                    id: "outer",
                    members: [{ id: "inner", version: "v1" }],
                    build: () => defineEchoRegistration("outer"),
                }),
            ],
            member: "inner/v1",
        },
    ])("rejects a Member that $reason at startup", ({ catalog, member }) => {
        expect(() =>
            buildProductionRegistrations(buildOptions(catalog)),
        ).toThrow(
            `declares Member "${member}" which is not an enabled standalone Process`,
        );
    });

    it("rejects a Process that names itself or the same Member twice", () => {
        expect(() =>
            defineProductionProcess({
                id: "composer",
                members: [{ id: "composer", version: "v1" }],
                build: () => defineEchoRegistration("composer"),
            }),
        ).toThrow('Production Process "composer" cannot be its own Member');
        expect(() =>
            defineProductionProcess({
                id: "composer",
                members: [
                    { id: "alpha", version: "v1" },
                    { id: "alpha", version: "v1" },
                ],
                build: () => defineEchoRegistration("composer"),
            }),
        ).toThrow(
            'Production Process "composer" declares Member "alpha/v1" twice',
        );
    });

    it("rejects a build whose Registration id differs from the declaration", () => {
        const catalog = [
            defineProductionProcess({
                id: "alpha",
                build: () => defineEchoRegistration("beta"),
            }),
        ];

        expect(() =>
            buildProductionRegistrations(buildOptions(catalog)),
        ).toThrow('Production Process "alpha" built Registration "beta"');
    });
});
