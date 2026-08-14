import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async staged promotion workflow", () => {
    it("is manual, protected, same-revision, sequential, and reversible", async () => {
        const [workflow, script, compose] = await Promise.all([
            readFile(".github/workflows/async-promote-release.yml", "utf8"),
            readFile("ops/promote-async-release.sh", "utf8"),
            readFile("compose.production.async.yaml", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain(
            "name: async-$" + "{{ inputs.target_stage }}",
        );
        expect(workflow).toContain("group: pipipi-production-release");
        for (const source of [
            "async-internal-release.yml",
            "async-internal-smoke.yml",
            "async-dispatcher-worker-drill.yml",
            "async-redis-rebuild-drill.yml",
            "async-webhook-observability-drill.yml",
        ]) {
            expect(workflow).toContain(source);
        }
        expect(workflow).toContain(".head_sha == $revision");
        expect(workflow).toContain("allEvidenceSameRevision: true");
        expect(workflow).toContain("capacityWithinBudget: true");
        expect(workflow).toContain("costWithinBudget: true");
        expect(workflow).toContain("OBSERVATION_WINDOW_SECONDS >= 3600");
        expect(workflow).toContain("Change exactly one async release variable");
        expect(workflow).toContain("< ops/promote-async-release.sh");
        expect(workflow).not.toMatch(/\n {2}push:/);

        expect(script).toContain("valid \"$variable\" '^(stage|traffic)$'");
        expect(script).toContain("internal:canary:0");
        expect(script).toContain("canary:production:25");
        expect(script).toContain("canary:0:1 canary:1:5 canary:5:25");
        expect(script).toContain("production:25:50 production:50:100");
        expect(script).toContain("observation_window_seconds");
        expect(script).toContain("at least 3600 seconds");
        expect(script).toContain("capture_critical_gate");
        expect(script).toContain("capture_roles");
        expect(script).toContain("verify_roles");
        expect(script).toContain("rollback_change");
        expect(script).toContain("ownerQueriesPreserved");
        expect(script).toContain("postgresStateDeleted");
        expect(compose).toContain(
            "ASYNC_RELEASE_STAGE: $" +
                "{PIPIPI_ASYNC_RELEASE_STAGE:?PIPIPI_ASYNC_RELEASE_STAGE is required}",
        );
    });
});
