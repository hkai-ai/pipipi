import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("UAT CI/CD workflow", () => {
    it("deploys the existing develop deployment shape to the UAT environment", async () => {
        const [workflow, script, production] = (
            await Promise.all([
                readFile(".github/workflows/uat-ci-cd.yml", "utf8"),
                readFile("ops/deploy-uat-release.sh", "utf8"),
                readFile(".github/workflows/production-ci-cd.yml", "utf8"),
            ])
        ).map((source) => source.replaceAll("\r\n", "\n"));

        expect(workflow).toContain("branches:\n      - develop");
        expect(workflow).not.toContain("- main");
        expect(workflow).toContain("environment: uat");
        expect(workflow).toContain("group: pipipi-uat-release");
        expect(workflow).toContain("github.ref == 'refs/heads/develop'");
        expect(workflow).toContain("secrets.UAT_SSH_PRIVATE_KEY");
        expect(workflow).toContain("IdentityFile ~/.ssh/deploy_key");
        expect(workflow).toContain("IPQoS none");
        expect(workflow).toContain("ServerAliveInterval 15");
        expect(workflow).toContain("split -b 8M");
        expect(workflow).toContain("xargs -0 -n 1 -P 4");
        expect(workflow).toContain("sha256sum");
        expect(workflow).toContain("postgres:18-alpine");
        expect(workflow).toContain("docker image inspect");
        expect(workflow).not.toContain("id_ed25519");
        expect(workflow).toContain("secrets.UAT_SSH_KNOWN_HOSTS");
        expect(workflow).toContain("vars.UAT_REMOTE_HOST");
        expect(workflow).toContain("vars.UAT_REMOTE_PATH");
        expect(workflow).toContain("StrictHostKeyChecking=yes");
        expect(workflow).toContain("compose.production.yaml");
        expect(workflow).toContain("ops/deploy-uat-release.sh");
        expect(workflow).not.toContain("vars.REMOTE_HOST");
        expect(workflow).not.toContain("secrets.SSH_PRIVATE_KEY");
        expect(workflow).toContain("compose.production.async.yaml");
        expect(workflow).not.toContain("pipipi-production-release");
        expect(workflow).not.toContain("StrictHostKeyChecking=no");

        expect(script).toContain("uat-target");
        expect(script.indexOf("grep -Fxq uat")).toBeLessThan(
            script.indexOf('bash "$async_update"'),
        );
        expect(script).toContain(
            'bash "$async_update" "$app_root" "$revision"',
        );
        expect(script).toContain("ASYNC_PROCESS_RUNS_ENABLED=false");
        expect(script).toContain("--project-name pipipi");
        expect(script).toContain("audit:production-database");
        expect(workflow).toContain("ops/update-async-release.sh");
        expect(script).not.toContain("pm2 ");

        expect(production).toContain("github.ref == 'refs/heads/main'");
        expect(production).not.toContain("uat-ci-cd.yml");
    });
});
