import { describe, expect, it } from "vitest";
import type { ProcessRunStore } from "../../src/process-runs/store/index.js";
import type { AcceptedProcessInput } from "../../src/processes/runtime/index.js";

export function processRunStoreContract(
    adapterName: string,
    createStore: () => ProcessRunStore,
): void {
    describe(`${adapterName} Process Run Store contract`, () => {
        it("atomically creates, replays, conflicts, and isolates accepted runs", async () => {
            const store = createStore();
            const original = acceptedRun({ runId: runId(1) });

            await expect(store.accept(original)).resolves.toMatchObject({
                outcome: "created",
                run: { runId: original.runId, status: "queued" },
            });
            await expect(
                store.accept({ ...original, runId: runId(2) }),
            ).resolves.toMatchObject({
                outcome: "replayed",
                run: { runId: original.runId, status: "queued" },
            });
            await expect(
                store.accept({
                    ...original,
                    runId: runId(3),
                    requestFingerprint: "b".repeat(64),
                }),
            ).resolves.toEqual({ outcome: "conflict" });

            const otherOwner = acceptedRun({
                runId: runId(4),
                ownerId: "caller-b",
            });
            await expect(store.accept(otherOwner)).resolves.toMatchObject({
                outcome: "created",
                run: { runId: otherOwner.runId },
            });
            expect(
                await store.findOwned(original.runId, "caller-b"),
            ).toBeUndefined();
            expect(
                await store.findOwned(otherOwner.runId, "caller-a"),
            ).toBeUndefined();
        });

        it("claims once and rejects stale or terminal updates", async () => {
            const store = createStore();
            const run = acceptedRun({ runId: runId(5) });
            await store.accept(run);

            const claim = await store.claim({
                runId: run.runId,
                claimToken: claimToken(1),
                claimedAt: "2026-08-09T10:00:01.000Z",
            });
            expect(claim).toMatchObject({
                runId: run.runId,
                claimToken: claimToken(1),
            });
            await expect(
                store.claim({
                    runId: run.runId,
                    claimToken: claimToken(2),
                    claimedAt: "2026-08-09T10:00:02.000Z",
                }),
            ).resolves.toBeUndefined();
            await expect(
                store.complete({
                    runId: run.runId,
                    claimToken: claimToken(3),
                    completedAt: "2026-08-09T10:00:03.000Z",
                    completion: {
                        status: "succeeded",
                        output: { value: "stale" },
                    },
                }),
            ).resolves.toBe(false);
            await expect(
                store.complete({
                    runId: run.runId,
                    claimToken: claimToken(1),
                    completedAt: "2026-08-09T10:00:04.000Z",
                    completion: {
                        status: "succeeded",
                        output: { value: "current" },
                    },
                }),
            ).resolves.toBe(true);
            await expect(
                store.complete({
                    runId: run.runId,
                    claimToken: claimToken(1),
                    completedAt: "2026-08-09T10:00:05.000Z",
                    completion: {
                        status: "failed",
                        error: { code: "INTERNAL_ERROR", message: "late" },
                    },
                }),
            ).resolves.toBe(false);

            expect(await store.findOwned(run.runId, run.ownerId)).toMatchObject(
                {
                    status: "succeeded",
                    output: { value: "current" },
                    revision: 2,
                    attemptCount: 1,
                },
            );
        });

        it("recovers an expired claim and fences the previous worker", async () => {
            const store = createStore();
            const run = acceptedRun({ runId: runId(7) });
            await store.accept(run);
            await store.claim({
                runId: run.runId,
                claimToken: claimToken(7),
                claimedAt: "2026-08-09T10:00:01.000Z",
            });

            const recovered = await store.claim({
                runId: run.runId,
                claimToken: claimToken(8),
                claimedAt: "2026-08-09T10:01:01.000Z",
            });
            expect(recovered).toMatchObject({ claimToken: claimToken(8) });
            await expect(
                store.complete({
                    runId: run.runId,
                    claimToken: claimToken(7),
                    completedAt: "2026-08-09T10:01:02.000Z",
                    completion: {
                        status: "succeeded",
                        output: { value: "stale" },
                    },
                }),
            ).resolves.toBe(false);
            await expect(
                store.complete({
                    runId: run.runId,
                    claimToken: claimToken(8),
                    completedAt: "2026-08-09T10:01:03.000Z",
                    completion: {
                        status: "succeeded",
                        output: { value: "recovered" },
                    },
                }),
            ).resolves.toBe(true);
            await expect(
                store.findOwned(run.runId, run.ownerId),
            ).resolves.toMatchObject({
                status: "succeeded",
                output: { value: "recovered" },
                attemptCount: 2,
                revision: 3,
            });
        });

        it("releases a current claim to queued and exposes it for reconciliation", async () => {
            const store = createStore();
            const run = acceptedRun({ runId: runId(8) });
            await store.accept(run);
            await store.claim({
                runId: run.runId,
                claimToken: claimToken(9),
                claimedAt: "2026-08-09T10:00:01.000Z",
            });

            await expect(
                store.releaseClaim({
                    runId: run.runId,
                    claimToken: claimToken(9),
                    releasedAt: "2026-08-09T10:00:02.000Z",
                }),
            ).resolves.toBe(true);
            await expect(
                store.releaseClaim({
                    runId: run.runId,
                    claimToken: claimToken(9),
                    releasedAt: "2026-08-09T10:00:03.000Z",
                }),
            ).resolves.toBe(false);
            await expect(
                store.findRecoverable({
                    asOf: "2026-08-09T10:00:03.000Z",
                    queuedBefore: "2026-08-09T10:00:02.000Z",
                    limit: 10,
                }),
            ).resolves.toEqual([{ runId: run.runId }]);
            await expect(
                store.findOwned(run.runId, run.ownerId),
            ).resolves.toMatchObject({
                status: "queued",
                startedAt: "2026-08-09T10:00:01.000Z",
                attemptCount: 1,
                revision: 2,
            });
        });

        it("records a retryable Attempt while keeping the public Run queued", async () => {
            const store = createStore();
            const run = acceptedRun({ runId: runId(9) });
            await store.accept(run);
            const first = await store.claim({
                runId: run.runId,
                claimToken: claimToken(10),
                claimedAt: "2026-08-09T10:00:01.000Z",
            });
            expect(first).toMatchObject({ attemptNumber: 1 });

            await expect(
                store.scheduleRetry({
                    runId: run.runId,
                    claimToken: claimToken(10),
                    scheduledAt: "2026-08-09T10:00:02.000Z",
                    failure: {
                        code: "DEPENDENCY_FAILURE",
                        message: "A required business service is unavailable",
                    },
                }),
            ).resolves.toBe(true);
            await expect(
                store.scheduleRetry({
                    runId: run.runId,
                    claimToken: claimToken(10),
                    scheduledAt: "2026-08-09T10:00:03.000Z",
                    failure: {
                        code: "DEPENDENCY_FAILURE",
                        message: "A required business service is unavailable",
                    },
                }),
            ).resolves.toBe(false);
            await expect(
                store.findOwned(run.runId, run.ownerId),
            ).resolves.toMatchObject({
                status: "queued",
                attemptCount: 1,
                revision: 2,
            });

            await expect(
                store.claim({
                    runId: run.runId,
                    claimToken: claimToken(11),
                    claimedAt: "2026-08-09T10:00:04.000Z",
                }),
            ).resolves.toMatchObject({ attemptNumber: 2 });
        });

        it("returns defensive snapshots from every read boundary", async () => {
            const store = createStore();
            const run = acceptedRun({ runId: runId(6) });
            await store.accept(run);

            const found = await store.findOwned(run.runId, run.ownerId);
            if (!found?.acceptedInput)
                throw new Error("Expected Process Run input");
            (found.acceptedInput.input as { value: string }).value =
                "mutated read";

            const claim = await store.claim({
                runId: run.runId,
                claimToken: claimToken(4),
                claimedAt: "2026-08-09T10:00:01.000Z",
            });
            if (!claim) throw new Error("Expected Process Run claim");
            (claim.acceptedInput.input as { value: string }).value =
                "mutated claim";
            const output = { value: "stored output" };
            await store.complete({
                runId: run.runId,
                claimToken: claim.claimToken,
                completedAt: "2026-08-09T10:00:02.000Z",
                completion: { status: "succeeded", output },
            });
            output.value = "mutated source";

            const completed = await store.findOwned(run.runId, run.ownerId);
            expect(completed).toMatchObject({
                acceptedInput: { input: { value: "request" } },
                output: { value: "stored output" },
            });
            if (completed?.status !== "succeeded") {
                throw new Error("Expected succeeded Process Run");
            }
            (completed.output as { value: string }).value =
                "mutated output read";
            expect(await store.findOwned(run.runId, run.ownerId)).toMatchObject(
                {
                    output: { value: "stored output" },
                },
            );
        });
    });
}

function acceptedRun(overrides: {
    runId: string;
    ownerId?: string;
}): Parameters<ProcessRunStore["accept"]>[0] {
    const process = "test-processing";
    const version = "v1";
    const acceptedInput: AcceptedProcessInput = {
        schemaVersion: 1,
        process,
        version,
        input: { value: "request" },
    };
    return {
        runId: overrides.runId,
        ownerId: overrides.ownerId ?? "caller-a",
        idempotencyKey: "shared-key",
        requestFingerprint: "a".repeat(64),
        process,
        version,
        acceptedInput,
        createdAt: "2026-08-09T10:00:00.000Z",
    };
}

function runId(index: number): string {
    return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function claimToken(index: number): string {
    return `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
