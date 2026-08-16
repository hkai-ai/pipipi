import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async internal release workflow", () => {
    it("is explicit, protected, and consumes only a CI-verified candidate", async () => {
        const [workflow, defaultWorkflow] = await Promise.all([
            readFile(".github/workflows/async-internal-release.yml", "utf8"),
            readFile(".github/workflows/production-ci-cd.yml", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain("name: async-internal");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(defaultWorkflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("cancel-in-progress: false");
        expect(workflow).toContain("SSH_KNOWN_HOSTS");
        expect(defaultWorkflow).toContain("SSH_KNOWN_HOSTS");
        expect(workflow).not.toContain("StrictHostKeyChecking=no");
        expect(defaultWorkflow).not.toContain("StrictHostKeyChecking=no");
        expect(workflow).toContain('"Check and build"');
        expect(workflow).toContain('"Async durable acceptance"');
        expect(workflow).toContain(
            'test "$(jq -r \'.head_sha\' <<< "$run_json")" = "$CANDIDATE_SHA"',
        );
        expect(workflow).toContain(
            'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
        );
        expect(workflow).toContain(
            'test "$(jq -r \'.path\' <<< "$run_json")" = ".github/workflows/production-ci-cd.yml"',
        );
        expect(workflow).toContain('--name "pipipi-$CANDIDATE_SHA"');
        expect(workflow).toContain("jobs?filter=latest&per_page=100");
        expect(workflow).toContain("PIPIPI_ASYNC_RELEASE_STAGE: internal");
        expect(workflow).not.toContain("PIPIPI_ASYNC_RELEASE_STAGE: canary");
        expect(workflow).not.toContain(
            "PIPIPI_ASYNC_RELEASE_STAGE: production",
        );
        expect(defaultWorkflow).not.toContain("async-internal-release");
    });

    it("orders all gates before internal API activation and preserves evidence", async () => {
        const script = await readFile("ops/deploy-async-internal.sh", "utf8");
        const gates = [
            'failure_gate="environment_prechecks"',
            'failure_gate="database_boundary"',
            'failure_gate="database_migration"',
            'failure_gate="queue_recovery"',
            'failure_gate="background_activation"',
            'failure_gate="api_activation"',
            'failure_gate="role_verification"',
        ];

        let previous = -1;
        for (const gate of gates) {
            const current = script.indexOf(gate);
            expect(current, `missing or misordered ${gate}`).toBeGreaterThan(
                previous,
            );
            previous = current;
        }
        expect(script).toContain("dist/bin/migrate-and-verify.js");
        expect(script).toContain("audit:production-database");
        expect(script).toContain("dist/bin/recover.js --dry-run --mode=all");
        expect(script).toContain("reports.at(-1).nextCursor !== undefined");
        expect(script).toContain('recovery_failed_count" -ne 0');
        expect(script).toContain('PIPIPI_ASYNC_RELEASE_STAGE="internal"');
        expect(script).toContain("trap 'finalize_release $?' EXIT");
        expect(script).toContain("trap 'on_signal HUP 129' HUP");
        expect(script).toContain("trap 'on_signal INT 130' INT");
        expect(script).toContain("trap 'on_signal TERM 143' TERM");
        expect(script).toContain("flock -n 9");
        expect(script).toContain("async_control/smoke-lease");
        expect(script).toContain("rollback_deployment");
        expect(script).toContain('work_root="$shared/.async-release-work"');
        expect(script).toContain("rm -f --");
        expect(script).not.toContain("migration down");
        expect(script).not.toMatch(/docker compose[^\n]* down/);
        for (const evidence of [
            "candidateCommit",
            "candidateCiRunId",
            "imageId",
            "imageArchiveSha256",
            "backupId",
            "databaseBoundaryVerified",
            "migrationVerified",
            "recoveryStartedWithEmptyCursor",
            "recoveryFinalCursorEmpty",
            "recoveryVerified",
            "rolesVerified",
            "rollbackStatus",
        ]) {
            expect(script).toContain(String.raw`\"${evidence}\"`);
        }
    });

    it("keeps role secrets separate and verifies revisions and Queue identity", async () => {
        const script = await readFile("ops/deploy-async-internal.sh", "utf8");

        for (const envFile of [
            "async-api.env",
            "process-dispatcher.env",
            "process-worker.env",
            "webhook-worker.env",
            "retention-cleaner.env",
        ]) {
            expect(script).toContain(envFile);
        }
        for (const container of [
            "pipipi",
            "pipipi-business-api",
            "pipipi-process-dispatcher",
            "pipipi-process-worker",
            "pipipi-webhook-worker",
            "pipipi-retention-cleaner",
        ]) {
            expect(script).toContain(container);
        }
        expect(script).toContain("Runtime role revision mismatch");
        expect(script).toContain(
            "Candidate Queue configuration differs from the active async shape",
        );
        expect(script).toContain(
            "Async internal release cannot replace another release stage",
        );
        expect(script).toContain(
            "Runtime role stage or Queue configuration mismatch",
        );
    });

    it("prechecks the worker with the same observation settings as Compose", async () => {
        const script = await readFile("ops/deploy-async-internal.sh", "utf8");
        const workerPrecheck = script.match(
            /docker run --rm --env-file "\$worker_env"[\s\S]*?check-deployment-environment\.js process-worker/,
        )?.[0];

        expect(workerPrecheck).toContain(
            "--env PROCESS_RUN_RECORD_STORE=postgres",
        );
        expect(workerPrecheck).toContain(
            "--env PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output",
        );
    });
});
