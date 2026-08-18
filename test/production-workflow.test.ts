import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Production CI/CD workflow", () => {
    it("keeps durable async acceptance separate, ordered, and required for deploy", async () => {
        const [workflow, manifestSource] = await Promise.all([
            readFile(".github/workflows/production-ci-cd.yml", "utf8"),
            readFile("package.json", "utf8"),
        ]);
        const manifest = JSON.parse(manifestSource) as {
            scripts: Record<string, string>;
        };
        const acceptance = job(
            workflow,
            "async-acceptance",
            "news-image-change-check",
        );
        const cleanup = step(acceptance, "Clean isolated dependencies");
        const deploy = job(workflow, "deploy");
        const gateway = step(deploy, "Verify console gateway precondition");
        const activation = step(deploy, "Activate release");

        expect(acceptance).toContain("name: Async durable acceptance");
        expect(acceptance).toContain(
            "run: npm run test:acceptance:async:local",
        );
        expect(acceptance).toMatch(
            /ASYNC_INTEGRATION_PROJECT_NAME: pipipi-async-ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
        );
        expect(cleanup).toMatch(/if: \$\{\{ always\(\) \}\}/);
        expect(cleanup).toContain(
            '--project-name "$ASYNC_INTEGRATION_PROJECT_NAME"',
        );
        expect(cleanup).toContain("down --volumes --remove-orphans");
        expect(acceptance).not.toContain("secrets.");
        expect(deploy).toContain("- ci");
        expect(deploy).toContain("- async-acceptance");
        expect(deploy).toContain("group: pipipi-production-release");
        expect(deploy).toContain("SSH_KNOWN_HOSTS");
        expect(deploy).toContain("flock -n 9");
        expect(deploy).toContain("async-control/smoke-lease");
        expect(gateway).toContain("CONSOLE_PUBLIC_URL");
        expect(gateway).toContain("^(401|403)$");
        expect(gateway).toContain('url.protocol !== "https:"');
        expect(deploy.indexOf(gateway)).toBeLessThan(
            deploy.indexOf(activation),
        );
        expect(deploy).toContain("run audit:production-database");
        expect(deploy).toContain("pg-server.crt:/etc/pipipi/pg-server.crt:ro");
        expect(deploy).not.toContain("StrictHostKeyChecking=no");
        expect(manifest.scripts["audit:production-database"]).toBe(
            "node dist/bin/audit-production-database.js",
        );
        expect(manifest.scripts["test:acceptance:async"]).toBe(
            "npm run test:integration:postgres && npm run test:integration:observation && npm run test:integration:async && npm run test:acceptance:console",
        );
    });

    it("validates and packages the opt-in async production shape", async () => {
        const [
            workflow,
            manifestSource,
            defaultCompose,
            asyncCompose,
            asyncRunbook,
        ] = await Promise.all([
            readFile(".github/workflows/production-ci-cd.yml", "utf8"),
            readFile("package.json", "utf8"),
            readFile("compose.production.yaml", "utf8"),
            readFile("compose.production.async.yaml", "utf8"),
            readFile("docs/async-process-runs-runbook.md", "utf8"),
        ]);
        const manifest = JSON.parse(manifestSource) as {
            scripts: Record<string, string>;
        };
        const ci = job(workflow, "ci", "async-acceptance");
        const deploy = job(workflow, "deploy");
        const shellSha = "$" + "{GITHUB_SHA}";
        const workflowSha = "$" + "{{ github.sha }}";

        expect(manifest.scripts["check:deployment:async-shape"]).toBe(
            "node --import tsx tools/check-async-production-compose.ts",
        );
        expect(ci).toContain("run: npm run check:deployment:async-shape");
        expect(ci).toContain(
            `cp compose.production.async.yaml "pipipi-${shellSha}.compose.async.yaml"`,
        );
        expect(ci).toContain(`pipipi-${workflowSha}.compose.async.yaml`);
        expect(defaultCompose).toContain('ASYNC_PROCESS_RUNS_ENABLED: "false"');
        expect(defaultCompose).toContain('INTERNAL_EVAL_ENABLED: "false"');
        for (const role of [
            "process-dispatcher",
            "process-worker",
            "webhook-worker",
            "retention-cleaner",
        ]) {
            expect(defaultCompose).not.toContain(`  ${role}:`);
            expect(asyncCompose).toContain(`  ${role}:`);
            expect(asyncCompose).toContain(
                `check-deployment-environment.js ${role}`,
            );
        }
        for (const [role, variable] of Object.entries({
            api: "PIPIPI_ASYNC_API_ENV_FILE",
            "process-dispatcher": "PIPIPI_PROCESS_DISPATCHER_ENV_FILE",
            "process-worker": "PIPIPI_PROCESS_WORKER_ENV_FILE",
            "webhook-worker": "PIPIPI_WEBHOOK_WORKER_ENV_FILE",
            "retention-cleaner": "PIPIPI_RETENTION_CLEANER_ENV_FILE",
        })) {
            const service = composeService(asyncCompose, role);
            expect(service).toContain("env_file:");
            expect(service).toContain(`${variable}:?${variable} is required`);
        }
        const processWorker = composeService(asyncCompose, "process-worker");
        expect(processWorker).toContain("PROCESS_RUN_RECORD_STORE: postgres");
        expect(processWorker).toContain(
            "PROCESS_RUN_RECORD_CONTENT: accepted-input-and-output",
        );
        const webhookWorker = composeService(asyncCompose, "webhook-worker");
        expect(webhookWorker).toContain('PORT: "4350"');
        expect(webhookWorker).toContain("http://127.0.0.1:4350/readyz");
        expect(deploy).not.toContain("compose.async.yaml");
        expect(deploy).not.toContain("--remove-orphans");
        expect(deploy).toContain(
            "Explicit async deployment is present; refusing an implicit synchronous rollback",
        );
        for (const container of [
            "pipipi-process-dispatcher",
            "pipipi-process-worker",
            "pipipi-webhook-worker",
            "pipipi-retention-cleaner",
        ]) {
            expect(deploy).toContain(container);
        }
        expect(asyncRunbook).not.toContain("--project-name pipipi-async");
        expect(asyncRunbook).toContain("--project-name pipipi");
        expect(asyncRunbook).toContain(
            "up -d --force-recreate --no-build --remove-orphans",
        );
    });
});

function step(jobSource: string, name: string): string {
    jobSource = jobSource.replaceAll("\r\n", "\n");
    const marker = `\n      - name: ${name}\n`;
    const start = jobSource.indexOf(marker);
    if (start < 0) throw new Error(`Missing ${name} step`);
    const end = jobSource.indexOf("\n      - name:", start + marker.length);
    return jobSource.slice(start, end < 0 ? undefined : end);
}

function job(workflow: string, name: string, next?: string): string {
    workflow = workflow.replaceAll("\r\n", "\n");
    const startMarker = `\n  ${name}:\n`;
    const start = workflow.indexOf(startMarker);
    if (start < 0) throw new Error(`Missing ${name} job`);
    if (!next) return workflow.slice(start);
    const end = workflow.indexOf(`\n  ${next}:\n`, start + startMarker.length);
    if (end < 0) throw new Error(`Missing ${next} job after ${name}`);
    return workflow.slice(start, end);
}

function composeService(compose: string, name: string): string {
    compose = compose.replaceAll("\r\n", "\n");
    const startMarker = `\n  ${name}:\n`;
    const start = compose.indexOf(startMarker);
    if (start < 0) throw new Error(`Missing ${name} service`);
    const remaining = compose.slice(start + startMarker.length);
    const next = remaining.search(/\n {2}[a-z][a-z-]*:\n/);
    return compose.slice(
        start,
        next < 0 ? undefined : start + startMarker.length + next,
    );
}
