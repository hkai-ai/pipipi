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
        const acceptance = job(workflow, "async-acceptance", "deploy");
        const cleanup = step(acceptance, "Clean isolated dependencies");
        const deploy = job(workflow, "deploy");

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
        expect(manifest.scripts["test:acceptance:async"]).toBe(
            "npm run test:integration:postgres && npm run test:integration:async && npm run test:acceptance:console",
        );
    });
});

function step(jobSource: string, name: string): string {
    const marker = `\n      - name: ${name}\n`;
    const start = jobSource.indexOf(marker);
    if (start < 0) throw new Error(`Missing ${name} step`);
    const end = jobSource.indexOf("\n      - name:", start + marker.length);
    return jobSource.slice(start, end < 0 ? undefined : end);
}

function job(workflow: string, name: string, next?: string): string {
    const startMarker = `\n  ${name}:\n`;
    const start = workflow.indexOf(startMarker);
    if (start < 0) throw new Error(`Missing ${name} job`);
    if (!next) return workflow.slice(start);
    const end = workflow.indexOf(`\n  ${next}:\n`, start + startMarker.length);
    if (end < 0) throw new Error(`Missing ${next} job after ${name}`);
    return workflow.slice(start, end);
}
