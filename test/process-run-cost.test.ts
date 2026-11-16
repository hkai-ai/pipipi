/** 异步 Run 终态资源顶层 cost：与 /execute 同口径，累计各次 Attempt，重放不重复累计。 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAsyncProcessRuns } from "../src/process-runs/index.js";
import { createInMemoryProcessWorkQueue } from "../src/process-runs/queue/index.js";
import { createInMemoryProcessRunStore } from "../src/process-runs/store/index.js";
import { createProcessWorker } from "../src/process-runs/worker/index.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    currentCostLedger,
    defineProcessRegistration,
    failProcess,
    runCostFromSnapshot,
} from "../src/process-runtime/index.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const caller = { callerId: "caller-a" };

function fixture(
    execute: (attempt: number) => Promise<unknown>,
    retry = false,
) {
    let attempt = 0;
    const registration = defineProcessRegistration({
        id: "cost-test",
        version: "v1",
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({ ok: z.boolean() }),
        ...(retry
            ? {
                  retryPolicy: {
                      maximumAttempts: 3,
                      retryableErrorCodes: ["DEPENDENCY_FAILURE"],
                      backoff: { initialDelayMs: 1, maximumDelayMs: 1 },
                  },
              }
            : {}),
        execute: async () => (await execute(++attempt)) as { ok: boolean },
    });
    const registry = createProcessRegistry([registration]);
    const store = createInMemoryProcessRunStore({ maxRuns: 5 });
    const queue = createInMemoryProcessWorkQueue({ maxJobs: 5 });
    let tick = 0;
    const clock = () =>
        new Date(Date.UTC(2026, 7, 9, 10, 0, tick++)).toISOString();
    const runs = createAsyncProcessRuns({
        registry,
        store,
        queue,
        clock,
        createRunId: () => RUN_ID,
    });
    let claims = 0;
    const worker = createProcessWorker({
        registry,
        store,
        attemptRunner: createProcessAttemptRunner(),
        clock,
        createClaimToken: () => `claim-token-${++claims}`,
    });
    return { runs, worker, store };
}

const submit = (f: ReturnType<typeof fixture>) =>
    f.runs.submit(
        { process: "cost-test", version: "v1", input: {} },
        { ...caller, idempotencyKey: "k" },
    );
const job = { schemaVersion: 1 as const, runId: RUN_ID };

describe("异步 Run 的 cost", () => {
    it("成功终态带 cost，形状与 /execute 一致", async () => {
        const f = fixture(async () => {
            currentCostLedger()?.recordKnown(0.25, "provider");
            return { ok: true };
        });
        await submit(f);
        await f.worker.process(job);
        expect(await f.runs.find(RUN_ID, caller)).toMatchObject({
            status: "succeeded",
            cost: {
                currency: "USD",
                amount: 0.25,
                source: "provider",
                complete: true,
            },
        });
    });

    it("失败终态同样带 cost；无已知费用时省略，未知费用只体现在 complete", async () => {
        const failed = fixture(async () => {
            currentCostLedger()?.recordKnown(0.1, "estimate");
            currentCostLedger()?.recordUnknown();
            return failProcess("AGENT_FAILURE", "x");
        });
        await submit(failed);
        await failed.worker.process(job);
        expect(await failed.runs.find(RUN_ID, caller)).toMatchObject({
            status: "failed",
            cost: { amount: 0.1, source: "estimate", complete: false },
        });
        const free = fixture(async () => ({ ok: true }));
        await submit(free);
        await free.worker.process(job);
        expect(await free.runs.find(RUN_ID, caller)).not.toHaveProperty("cost");
    });

    it("重试的 Attempt 费用累计到终态，重放终态不再累计", async () => {
        const f = fixture(async (attempt) => {
            currentCostLedger()?.recordKnown(0.2, "provider");
            return attempt === 1
                ? failProcess("DEPENDENCY_FAILURE", "x")
                : { ok: true };
        }, true);
        await submit(f);
        expect(await f.worker.process(job)).toMatchObject({
            outcome: "retry-scheduled",
        });
        expect(await f.runs.find(RUN_ID, caller)).not.toHaveProperty("cost");
        expect(await f.worker.process(job)).toBe("processed");
        const first = await f.runs.find(RUN_ID, caller);
        expect(first).toMatchObject({
            status: "succeeded",
            cost: { amount: 0.4, complete: true },
        });
        // 已终态的重复投递不会领取，也不会改动已存费用。
        expect(await f.worker.process(job)).toBe("ignored");
        expect(await f.runs.find(RUN_ID, caller)).toEqual(first);
    });

    it("同一 claim 的重复 complete 被拒绝，不重复累计", async () => {
        const f = fixture(async () => ({ ok: true }));
        await submit(f);
        const claim = await f.store.claim({
            runId: RUN_ID,
            claimToken: "t",
            claimedAt: "2026-08-09T10:00:00.000Z",
        });
        expect(claim).toBeDefined();
        const request = {
            runId: RUN_ID,
            claimToken: "t",
            completedAt: "2026-08-09T10:00:01.000Z",
            completion: { status: "succeeded" as const, output: { ok: true } },
            costLedger: { usd: 1, provider: 1, estimate: 0, unknown: 0 },
        };
        expect(await f.store.complete(request)).toBe(true);
        expect(await f.store.complete(request)).toBe(false);
        expect(
            runCostFromSnapshot(
                (await f.store.findOwned(RUN_ID, "caller-a"))?.costLedger,
            )?.amount,
        ).toBe(1);
    });
});
