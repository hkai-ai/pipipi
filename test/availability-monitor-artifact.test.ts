import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Availability Monitor artifact", () => {
    it("runs the compiled entrypoint without development dependencies", async () => {
        const packageJson = JSON.parse(
            await readFile("package.json", "utf8"),
        ) as { scripts: Readonly<Record<string, string>> };

        expect(packageJson.scripts["start:availability"]).toBe(
            "node --env-file-if-exists=.env dist/bin/availability-monitor.js",
        );
        expect(packageJson.scripts["observe:availability"]).toBe(
            "npm run start:availability",
        );
        expect(packageJson.scripts["start:availability"]).not.toMatch(
            /(?:tsx|src\/)/,
        );
    });
});
