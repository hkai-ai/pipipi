import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async internal smoke workflow", () => {
    it("is protected, manual, revision-bound, and always restores intake", async () => {
        const [workflow, smoke, intake, lease, collector, releaseEvidence] =
            await Promise.all([
                readFile(".github/workflows/async-internal-smoke.yml", "utf8"),
                readFile("src/app/async-internal-smoke.ts", "utf8"),
                readFile("ops/set-async-internal-intake.sh", "utf8"),
                readFile("ops/set-async-internal-smoke-lease.sh", "utf8"),
                readFile(
                    "ops/collect-async-internal-smoke-evidence.sh",
                    "utf8",
                ),
                readFile(
                    "ops/verify-async-internal-release-evidence.sh",
                    "utf8",
                ),
            ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain("name: async-internal");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("ASYNC_INTERNAL_CALLER_A_AUTHORIZATION");
        expect(workflow).toContain("ASYNC_INTERNAL_CALLER_B_AUTHORIZATION");
        expect(workflow).toContain("ASYNC_INTERNAL_SUCCESS_REQUEST");
        expect(workflow).toContain("ASYNC_INTERNAL_FAILURE_REQUEST");
        expect(workflow).toContain(
            "< ops/verify-async-internal-release-evidence.sh",
        );
        expect(workflow).toContain(
            "Close async intake with automatic restoration",
        );
        expect(workflow).toContain("Acquire server smoke lease");
        expect(workflow).toContain("Release server smoke lease");
        expect(workflow).toContain(".[0].state.deliveryCount > 0");
        expect(workflow).toContain(".[0].state.deliveryRunCount == 2");
        expect(workflow).toMatch(
            /- name: Restore async intake\n {8}if: \$\{\{ always\(\) && steps\.close_intake\.outcome == 'success' \}\}/,
        );
        expect(workflow).not.toContain("ASYNC_RELEASE_STAGE: canary");
        expect(workflow).not.toContain("ASYNC_RELEASE_STAGE: production");
        expect(smoke).toContain("forged-by-smoke-must-be-removed");
        expect(smoke).not.toContain("console.log");
        expect(intake).toContain("auto_restore_seconds");
        expect(intake).toContain("control_id");
        expect(intake).toContain("nohup bash -c");
        expect(intake).toContain("9>&-");
        expect(intake.indexOf("nohup bash -c")).toBeLessThan(
            intake.indexOf('mv "$temporary" "$marker"'),
        );
        expect(releaseEvidence).toContain('record.status !== "succeeded"');
        expect(releaseEvidence).toContain(
            "record.candidateCommit !== revision",
        );
        expect(releaseEvidence).toContain(
            "record.releaseRunId !== Number(releaseRunId)",
        );
        expect(lease).toContain("Async smoke lease revision mismatch");
        expect(lease).toContain("9>&-");
        expect(releaseEvidence).toContain('record.releaseStage !== "internal"');
        for (const signal of [
            "async_operations_snapshot",
            "process_run_submission_accepted",
            "process_run_observed",
            "outbox_message_published",
            "process_run_work_finished",
        ]) {
            expect(collector).toContain(signal);
        }
        expect(collector).toContain('if [ "$phase" = "baseline" ]');
        expect(collector).toContain("--wait-for-deliveries");
        expect(collector).toContain("state.deliveryRunCount !== 2");
        expect(collector).toContain("state.runs.deliveriesPresent !== true");
    });
});
