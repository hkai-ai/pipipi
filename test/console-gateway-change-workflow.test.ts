import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Console gateway change workflow", () => {
    it("is protected, digest-pinned, secret-safe, probed, and rollback-capable", async () => {
        const [workflow, script, runbook] = await Promise.all([
            readFile(".github/workflows/console-gateway-change.yml", "utf8"),
            readFile("ops/apply-console-gateway-auth.sh", "utf8"),
            readFile("docs/mvp-release-runbook.md", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request|schedule):/);
        expect(workflow).toContain("name: console-gateway-change");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("CONSOLE_GATEWAY_HOST_CONFIG_SHA256");
        expect(workflow).toContain("CONSOLE_GATEWAY_CONTAINER_CONFIG_PATH");
        expect(workflow).toContain("CONSOLE_GATEWAY_APPLICATION_CONTAINER");
        expect(workflow).toContain("CONSOLE_GATEWAY_LEGACY_REVISION");
        expect(workflow).toContain(
            '[ "$ACTIVE_REVISION" = "$LEGACY_REVISION" ]',
        );
        expect(workflow).toContain('[[ "$REMOTE_HOST" =~');
        expect(workflow).toContain('[ "$REMOTE_USER" = "root" ]');
        expect(workflow).toContain("CONSOLE_PUBLIC_URL path is not safe");
        expect(workflow).toContain("CONSOLE_BASIC_AUTH_HTPASSWD");
        expect(workflow).toContain("CONSOLE_AUTHORIZATION");
        expect(workflow).toContain("StrictHostKeyChecking=yes");
        expect(workflow).toContain("mktemp -d");
        expect(workflow).toContain("chmod 600");
        expect(workflow).toContain("trap cleanup EXIT");
        expect(workflow).not.toContain("set -x");
        expect(script).toContain("Gateway configuration digest changed");
        expect(script).toContain("config.authBasicDirectiveCount == 0");
        expect(script).toContain("reloadAdapter.configPath == $containerPath");
        expect(script).toContain("set $pipipi_console_realm off;");
        expect(script).toContain("auth_basic $pipipi_console_realm;");
        expect(script).toContain('docker exec "$container" openresty -t');
        expect(script).toContain(
            'docker exec "$container" openresty -s reload',
        );
        expect(script).toContain("rollback()");
        expect(script).toContain('[ "$anonymous_status" != "401" ]');
        expect(script).toContain("www-authenticate:");
        expect(script).toContain('[ "$authenticated_status" != "200" ]');
        expect(script).toContain("x-pipipi-revision:");
        expect(script).toContain("legacy_container_and_contract");
        expect(script).toContain('--resolve "$domain:443:127.0.0.1"');
        expect(script).toContain("console_gateway_auth_change_failed");
        expect(script).toContain("trap rollback ERR HUP INT TERM");
        expect(script).toContain("stat -c '%a:%g'");
        expect(script).not.toContain('echo "$authorization"');
        expect(runbook).toContain("Console gateway change");
        expect(runbook).toContain("CONSOLE_BASIC_AUTH_HTPASSWD");
    });
});
