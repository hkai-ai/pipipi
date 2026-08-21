import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("news image Business Process acceptance workflow", () => {
    it("is opt-in and runs only for relevant release changes behind approval", async () => {
        const [workflow, command, module, manifestSource] = await Promise.all([
            readFile(".github/workflows/production-ci-cd.yml", "utf8"),
            readFile("examples/news-image-business-acceptance.ts", "utf8"),
            readFile("src/release/news-image-acceptance.ts", "utf8"),
            readFile("package.json", "utf8"),
        ]);
        const manifest = JSON.parse(manifestSource) as {
            scripts: Record<string, string>;
        };
        const changeCheck = job(
            workflow,
            "news-image-change-check",
            "news-image-acceptance",
        );
        const acceptance = job(workflow, "news-image-acceptance", "deploy");
        const deploy = job(workflow, "deploy");

        expect(changeCheck).toContain("github.event_name != 'pull_request'");
        expect(changeCheck).toContain("NEWS_IMAGE_ACCEPTANCE_ENABLED");
        expect(changeCheck).toContain(
            'if [[ "$ACCEPTANCE_ENABLED" == "true" ]]',
        );
        expect(changeCheck).toContain("git diff --quiet");
        expect(changeCheck).toContain(
            ".pi/skills/news-image-pale-watercolor-prompt",
        );
        expect(changeCheck).toContain("src/processes/news-image");
        expect(changeCheck).toContain("src/business-api");
        expect(changeCheck).toContain("required=false");

        expect(acceptance).toContain("name: news-image-acceptance");
        expect(acceptance).toContain("group: pipipi-production-release");
        expect(acceptance).toContain("APPROVE_THREE_NEWS_IMAGE_PROCESS_RUNS");
        expect(acceptance).toContain("npm run accept:news-image-business");
        expect(acceptance).toContain("NEWS_IMAGE_ACCEPTANCE_REVISION");
        expect(acceptance).toContain("OPENAI_API_KEY");
        expect(acceptance).toContain("FAL_KEY");
        expect(acceptance).toContain("OSS_ACCESS_KEY_ID");
        expect(acceptance).toContain("retention-days: 90");
        expect(acceptance).toContain(
            ".totals == {processRuns:3, imageGenerationAttempts:3}",
        );
        expect(acceptance).toContain(
            "Forbidden news image acceptance evidence field detected",
        );

        expect(deploy).toContain("- news-image-change-check");
        expect(deploy).toContain("- news-image-acceptance");
        expect(deploy).toContain(
            "needs.news-image-acceptance.result == 'success'",
        );
        expect(deploy).toContain(
            "needs.news-image-acceptance.result == 'skipped'",
        );

        expect(command).toContain("imageGenerationAttempts > 3");
        expect(command).toContain("imageGenerationAttempts !== 3");
        expect(command).toContain('quality: "low"');
        expect(command).toContain("NEWS_IMAGE_ACCEPTANCE_EVIDENCE_FILE");
        expect(module).toContain('new URL("/execute", options.baseUrl)');
        expect(module).toContain('redirect: "manual"');
        expect(module).not.toContain("OPENAI_API_KEY");
        expect(module).not.toContain("FAL_KEY");
        expect(manifest.scripts["accept:news-image-business"]).toBe(
            "node --env-file-if-exists=.env --import tsx examples/news-image-business-acceptance.ts",
        );
    });
});

function job(workflow: string, name: string, next?: string): string {
    const normalized = workflow.replaceAll("\r\n", "\n");
    const startMarker = `\n  ${name}:\n`;
    const start = normalized.indexOf(startMarker);
    if (start < 0) throw new Error(`Missing ${name} job`);
    if (!next) return normalized.slice(start);
    const end = normalized.indexOf(
        `\n  ${next}:\n`,
        start + startMarker.length,
    );
    if (end < 0) throw new Error(`Missing ${next} job after ${name}`);
    return normalized.slice(start, end);
}
