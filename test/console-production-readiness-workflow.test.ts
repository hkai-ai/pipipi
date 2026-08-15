import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Console production readiness workflow", () => {
    it("is protected, read-only, same-revision, authenticated, and backup-gated", async () => {
        const workflow = await readFile(
            ".github/workflows/console-production-readiness.yml",
            "utf8",
        );

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request|schedule):/);
        expect(workflow).toContain("name: console-production-readiness");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("pipipi-business-api");
        expect(workflow).toContain("com.pipipi.revision");
        expect(workflow).toContain("audit:production-database");
        expect(workflow).toContain("administrativePrivilegesAbsent");
        expect(workflow).toContain("otherDatabaseAccessAbsent");
        expect(workflow).toContain("roleMembershipAbsent");
        expect(workflow).toContain("pipipi-process-worker");
        expect(workflow).toContain('test "$worker_store" = "postgres"');
        expect(workflow).toContain(
            'test "$worker_content" = "accepted-input-and-output"',
        );
        expect(workflow).toContain("shared/postgres-backup/evidence.json");
        expect(workflow).toContain("postgres_backup_verified");
        expect(workflow).toContain(
            ".databaseIdentitySha256 == $database.databaseIdentitySha256",
        );
        expect(workflow).toContain("restoreVerifiedAt");
        expect(workflow).toContain("retentionUntil");
        expect(workflow).toContain("BACKUP_EVIDENCE_HMAC_KEY");
        expect(workflow).toContain("createHmac");
        expect(workflow).toContain("timingSafeEqual");
        expect(workflow).toContain("CONSOLE_AUTHORIZATION");
        expect(workflow).toContain("CONSOLE_PUBLIC_URL");
        expect(workflow).toContain("anonymousStatus");
        expect(workflow).toContain("authenticatedStatus");
        expect(workflow).toContain('headers.get("x-pipipi-revision")');
        expect(workflow).toContain("documentVerified");
        expect(workflow).toContain("processCatalogVerified");
        expect(workflow).toContain("statisticsVerified");
        expect(workflow).toContain("id: server");
        expect(workflow).toContain("id: gateway");
        expect(workflow).toContain("id: assemble");
        expect(workflow).toContain("console_server_readiness_failed");
        expect(workflow).toContain('failure_gate="database_audit"');
        expect(workflow).toContain('failure_gate="backup_evidence"');
        expect(workflow).toContain("name: Record failed readiness gate");
        expect(workflow).toMatch(
            /SERVER_OUTCOME: \$\{\{ steps\.server\.outcome \}\}/,
        );
        expect(workflow).toMatch(
            /GATEWAY_OUTCOME: \$\{\{ steps\.gateway\.outcome \}\}/,
        );
        expect(workflow).toMatch(
            /ASSEMBLE_OUTCOME: \$\{\{ steps\.assemble\.outcome \}\}/,
        );
        expect(workflow).toMatch(/if: \$\{\{ failure\(\) \}\}/);
        expect(workflow).toMatch(/if: \$\{\{ always\(\) \}\}/);
        expect(workflow).toContain(
            "path: artifacts/console-production-readiness/",
        );
        expect(workflow).toMatch(
            /name: pipipi-console-production-readiness-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
        );
        expect(workflow).not.toMatch(
            /name: pipipi-console-production-readiness-.*inputs\.candidate_sha/,
        );
        expect(workflow).toContain('revision=""');
        expect(workflow).toContain(
            'revision: (if $revision == "" then null else $revision end)',
        );
        expect(workflow).toContain("retention-days: 90");
        expect(workflow).not.toContain("docker compose up");
        expect(workflow).not.toContain("set-traffic");
        expect(workflow).not.toContain("DATABASE_URL:");
    });
});
