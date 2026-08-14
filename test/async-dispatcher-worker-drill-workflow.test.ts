import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async Dispatcher and Worker fault drill workflow", () => {
    it("is manual, protected, isolated, revision-bound, and evidence-safe", async () => {
        const [workflow, drill, worker, compose] = await Promise.all([
            readFile(
                ".github/workflows/async-dispatcher-worker-drill.yml",
                "utf8",
            ),
            readFile(
                "test/dispatcher-worker-fault-drill.integration.test.ts",
                "utf8",
            ),
            readFile("src/process-runs/queue/bullmq.ts", "utf8"),
            readFile("compose.production.async.yaml", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain("name: async-staging");
        expect(workflow).toContain("pipipi-async-staging-fault-drill");
        expect(workflow).toContain(
            'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
        );
        expect(workflow).toContain(
            "npm run test:drill:dispatcher-worker:local",
        );
        expect(workflow).toContain("productionTrafficAffected == false");
        expect(workflow).toContain("authoritativeRunCount == 1");
        expect(workflow).toContain("terminalEventCount == 1");
        expect(workflow).toContain("idempotentEffectCount == 1");
        expect(workflow).toContain("CLAIM_EXPIRED");
        expect(workflow).toContain("CLAIM_RELEASED");
        expect(workflow).toContain("firstDispatcherFaultObserved");
        expect(workflow).toContain("capabilityEffectAttemptCount == 2");
        expect(workflow).toContain(
            "shutdownElapsedMs >= .observations.shutdownGraceMs",
        );
        expect(workflow).toContain("down --volumes --remove-orphans");
        expect(workflow).not.toContain("ASYNC_RELEASE_STAGE");
        expect(drill).toContain("staleCompletionRejected: true");
        expect(drill).toContain("terminalDuplicateIgnored: true");
        expect(drill).toContain("newWorkerReadyBeforeOldStop: true");
        expect(drill).toContain("createProcessDispatcherRuntime");
        expect(worker).toContain("worker.cancelAllJobs");
        expect(worker).toContain("Math.min(shutdownGraceMs, 1_000)");
        expect(compose).toContain("stop_grace_period: 2m");
    });
});
