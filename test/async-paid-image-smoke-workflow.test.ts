import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async paid image smoke workflow", () => {
    it("is manual, protected, cost-approved, same-revision, and fixed to CRT", async () => {
        const [workflow, module, command, packageJson] = await Promise.all([
            readFile(".github/workflows/async-paid-image-smoke.yml", "utf8"),
            readFile("src/app/paid-async-image-smoke.ts", "utf8"),
            readFile("examples/paid-async-image-smoke.ts", "utf8"),
            readFile("package.json", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain("name: async-paid-smoke");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("APPROVE_ONE_PAID_CRT_OPERATION");
        expect(workflow).toContain("async-promote-release.yml");
        expect(workflow).toContain("targetTrafficPercent >= 1");
        expect(workflow).toContain("allEvidenceSameRevision");
        expect(workflow).toContain("npm run smoke:async-paid-image");
        expect(workflow).toContain("PAID_ASYNC_SOURCE_IMAGE_URL");
        expect(workflow).toContain("PAID_ASYNC_CALLER_AUTHORIZATION");
        expect(workflow).toContain("Verify active revision stage and traffic");
        expect(workflow).toContain("com.pipipi.revision");
        expect(workflow).toContain("set-traffic get");
        expect(workflow).toContain("retention-days: 90");
        expect(workflow).not.toMatch(/\n {2}push:/);
        expect(workflow).not.toContain("schedule:");
        expect(workflow).not.toContain("workflow_call:");
        expect(workflow).not.toContain("FAL_KEY");
        expect(workflow).not.toContain("OSS_ACCESS_KEY");

        expect(module).toContain('id: "crt-interface-image"');
        expect(module).toContain('version: "v1"');
        expect(module).toContain('const palette = "经典"');
        expect(module).toContain('const aspectRatio = "4:3"');
        expect(module).toContain("acceptanceResponseRecoveryVerified");
        expect(module).toContain("queryRecoveryVerified");
        expect(module).not.toContain("FAL_KEY");
        expect(module).not.toContain("OSS_ACCESS_KEY");
        expect(command).toContain("PAID_ASYNC_EVIDENCE_FILE");
        expect(packageJson).toContain('"smoke:async-paid-image"');
    });
});
