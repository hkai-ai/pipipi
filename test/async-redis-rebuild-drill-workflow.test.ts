import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async Redis rebuild drill workflow", () => {
    it("is manual, protected, revision-bound, gated, and evidence-safe", async () => {
        const [workflow, drill] = await Promise.all([
            readFile(".github/workflows/async-redis-rebuild-drill.yml", "utf8"),
            readFile(
                "test/redis-queue-rebuild-drill.integration.test.ts",
                "utf8",
            ),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain("name: async-staging");
        expect(workflow).toContain("pipipi-async-staging-fault-drill");
        expect(workflow).toContain(
            'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
        );
        expect(workflow).toContain(".dryRun[-1].nextCursor == null");
        expect(workflow).toContain(".totals.dryRun.failed == 0");
        expect(workflow).toContain(".totals.apply.enqueued == 4");
        expect(workflow).toContain(".activeLeaseDryRun[-1].nextCursor == null");
        expect(workflow).toContain(".orphanQueueJobIgnored == true");
        expect(workflow).toContain(".intakeClosure.runCountUnchanged == true");
        expect(workflow).toContain(".totals.verification.missingJobs == 0");
        expect(workflow).toContain("down --volumes --remove-orphans");
        expect(workflow).not.toContain("ASYNC_RELEASE_STAGE");
        expect(drill).toContain("createFileControlledAsyncIntake");
        expect(drill).toContain("runQueueRecoveryCommand");
        expect(drill).toContain('await controlRedis("stop")');
        expect(drill).toContain('action: "deferred"');
        expect(drill).toContain("orphanQueueJobIgnored: true");
        expect(drill).toContain("terminalRunExcludedFromRecovery: true");
    });
});
