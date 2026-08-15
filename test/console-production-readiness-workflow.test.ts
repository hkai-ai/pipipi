import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Console production readiness workflow", () => {
    it("is protected, read-only, same-revision, authenticated, and backup-gated", async () => {
        const [workflow, serverAudit, gatewayHostAudit, runbook] =
            await Promise.all([
                readFile(
                    ".github/workflows/console-production-readiness.yml",
                    "utf8",
                ),
                readFile(
                    "ops/collect-console-production-server-evidence.sh",
                    "utf8",
                ),
                readFile(
                    "ops/collect-console-gateway-host-evidence.sh",
                    "utf8",
                ),
                readFile("docs/mvp-release-runbook.md", "utf8"),
            ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request|schedule):/);
        expect(workflow).toContain("name: console-production-readiness");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("uses: actions/checkout@v6");
        expect(workflow.indexOf("uses: actions/checkout@v6")).toBeLessThan(
            workflow.indexOf(
                "< ops/collect-console-production-server-evidence.sh",
            ),
        );
        expect(workflow).toContain(
            "< ops/collect-console-production-server-evidence.sh",
        );
        expect(serverAudit).toContain("pipipi-business-api");
        expect(serverAudit).toContain("com.pipipi.revision");
        expect(serverAudit).toContain("audit:production-database");
        expect(serverAudit).toContain("administrativePrivilegesAbsent");
        expect(serverAudit).toContain("otherDatabaseAccessAbsent");
        expect(serverAudit).toContain("roleMembershipAbsent");
        expect(serverAudit).toContain("pipipi-process-worker");
        expect(serverAudit).toContain('test "$worker_store" = "postgres"');
        expect(serverAudit).toContain(
            'test "$worker_content" = "accepted-input-and-output"',
        );
        expect(serverAudit).toContain("shared/postgres-backup/evidence.json");
        expect(serverAudit).toContain("postgres_backup_verified");
        expect(serverAudit).toContain(
            ".databaseIdentitySha256 == $database.databaseIdentitySha256",
        );
        expect(serverAudit).toContain("restoreVerifiedAt");
        expect(serverAudit).toContain("retentionUntil");
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
        expect(serverAudit).toContain("console_server_readiness_failed");
        expect(serverAudit).toContain('failure_gate="database_audit"');
        expect(serverAudit).toContain('failure_gate="backup_evidence"');
        expect(serverAudit).toContain("databaseAuditFailure");
        expect(serverAudit).toContain("activeDatabaseUrlConfigured");
        expect(serverAudit).toContain("sharedDatabaseUrlConfigured");
        expect(serverAudit).toContain("databaseCaPresent");
        expect(serverAudit).toContain("backupEvidencePresent");
        expect(workflow).toContain("name: Inspect console gateway host");
        expect(workflow).toContain("steps.server.outcome == 'failure'");
        expect(workflow).toContain(
            "< ops/collect-console-gateway-host-evidence.sh",
        );
        expect(workflow).toContain(
            "> artifacts/console-production-readiness/gateway-host.json",
        );
        expect(workflow).toContain(
            'publicPath: url.pathname.replace(/\\/$/, "")',
        );
        expect(workflow).toContain('"$domain" "$public_path"');
        expect(gatewayHostAudit).toContain("console_gateway_host_inspected");
        expect(gatewayHostAudit).toContain("config_enumeration_failed");
        expect(gatewayHostAudit).toContain("config_parse_failed");
        expect(gatewayHostAudit).toContain(
            "gateway_container_enumeration_failed",
        );
        expect(gatewayHostAudit).toContain("gateway_mount_inspection_failed");
        expect(gatewayHostAudit).toContain("matchingServerBlockCount");
        expect(gatewayHostAudit).toContain("docker inspect");
        expect(gatewayHostAudit).toContain("authBasicDirectiveCount");
        expect(gatewayHostAudit).toContain("authRequestDirectiveCount");
        expect(gatewayHostAudit).toContain("proxyPassDirectiveCount");
        expect(gatewayHostAudit).toContain("reloadAdapter");
        expect(gatewayHostAudit).toContain("containerConfigPath");
        expect(gatewayHostAudit).not.toContain("sed -i");
        expect(gatewayHostAudit).not.toContain("docker restart");
        expect(gatewayHostAudit).not.toContain("docker exec");
        expect(runbook).toContain("databaseAuditFailure");
        expect(runbook).toContain("role_switching_present");
        expect(runbook).toContain("connection_or_unclassified_failure");
        expect(runbook).toContain("gateway-host.json");
        expect(runbook).toContain("console_gateway_host_inspected");
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
