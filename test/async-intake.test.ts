import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileControlledAsyncIntake } from "../src/app/async-intake.js";

describe("File-controlled async intake", () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            directories
                .splice(0)
                .map((directory) =>
                    rm(directory, { recursive: true, force: true }),
                ),
        );
    });

    it("closes intake only while the server-owned marker exists", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "async-intake-"));
        directories.push(directory);
        const marker = path.join(directory, "intake-disabled");
        const intake = createFileControlledAsyncIntake({
            disabledMarkerFile: marker,
        });

        expect(intake.isOpen()).toBe(true);
        await writeFile(marker, "");
        expect(intake.isOpen()).toBe(false);
        await rm(marker);
        expect(intake.isOpen()).toBe(true);
    });

    it("rejects relative marker paths", () => {
        expect(() =>
            createFileControlledAsyncIntake({
                disabledMarkerFile: "relative/intake-disabled",
            }),
        ).toThrow("must be an absolute path");
    });
});
