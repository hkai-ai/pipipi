import { describe, expect, it, vi } from "vitest";
import { applyMigrationsAndVerify } from "../src/release/migration-verification.js";

describe("migration verification", () => {
    it("applies migrations and proves the second run is empty", async () => {
        const migrate = vi
            .fn<() => Promise<readonly unknown[]>>()
            .mockResolvedValueOnce(["001", "002"])
            .mockResolvedValueOnce([]);

        await expect(applyMigrationsAndVerify(migrate)).resolves.toEqual({
            appliedCount: 2,
            verificationCount: 0,
        });
        expect(migrate).toHaveBeenCalledTimes(2);
    });

    it("rejects a migration that remains pending on the second run", async () => {
        const migrate = vi
            .fn<() => Promise<readonly unknown[]>>()
            .mockResolvedValueOnce(["001"])
            .mockResolvedValueOnce(["002"]);

        await expect(applyMigrationsAndVerify(migrate)).rejects.toThrow(
            "Migration verification found migrations on the second run",
        );
    });
});
