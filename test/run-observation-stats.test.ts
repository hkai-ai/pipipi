import { describe, expect, it } from "vitest";
import { summariseAggregatedRunObservation } from "../src/run-observation/stats.js";

describe("Run observation aggregate shaping", () => {
    it("keeps large SQL counts aggregated instead of expanding fake Runs", () => {
        const summary = summariseAggregatedRunObservation({
            since: "2026-08-01T00:00:00.000Z",
            counts: [
                {
                    day: "2026-08-14",
                    process: "content-processing",
                    version: "v1",
                    status: "succeeded",
                    count: 1_000_000,
                },
                {
                    day: "2026-08-14",
                    process: "content-processing",
                    version: "v1",
                    status: "failed",
                    errorCode: "DEPENDENCY_FAILURE",
                    count: 250_000,
                },
            ],
            recentFailures: [],
            attemptDurationMs: { samples: 0 },
        });

        expect(summary.totals).toEqual({
            succeeded: 1_000_000,
            failed: 250_000,
        });
        expect(summary.byProcess).toEqual([
            {
                process: "content-processing",
                version: "v1",
                succeeded: 1_000_000,
                failed: 250_000,
            },
        ]);
        expect(summary.byErrorCode).toEqual([
            { errorCode: "DEPENDENCY_FAILURE", count: 250_000 },
        ]);
    });
});
