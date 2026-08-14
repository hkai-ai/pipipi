import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async Webhook observability drill workflow", () => {
    it("is manual, protected, revision-bound, isolated, and evidence-safe", async () => {
        const [workflow, drill, observability] = await Promise.all([
            readFile(
                ".github/workflows/async-webhook-observability-drill.yml",
                "utf8",
            ),
            readFile(
                "test/webhook-observability-drill.integration.test.ts",
                "utf8",
            ),
            readFile("ops/async-observability.json", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request):/);
        expect(workflow).toContain("name: async-staging");
        expect(workflow).toContain("pipipi-async-staging-fault-drill");
        expect(workflow).toContain(
            'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
        );
        expect(workflow).toContain(".terminalBeforeWebhookSuccess == true");
        expect(workflow).toContain(
            ".isolation.futureRetryExcludedFromCurrentOutboxLag == true",
        );
        expect(workflow).toContain(".readiness.productionPassed == true");
        expect(workflow).toContain("down --volumes --remove-orphans");
        expect(workflow).not.toContain("ASYNC_RELEASE_STAGE");
        expect(drill).toContain("createPostgresAsyncReleaseReadiness");
        expect(drill).toContain("REMOTE_RESPONSE_SENTINEL");
        expect(drill).toContain("stableEventId: true");

        const specification = JSON.parse(observability) as {
            correlationKeys: string[];
            alerts: Array<{ metric: string; severity: string }>;
        };
        expect(specification.correlationKeys).toEqual([
            "runId",
            "eventId",
            "deliveryId",
        ]);
        expect(
            specification.alerts.find(
                (alert) =>
                    alert.metric === "persistence.recovery.lastCompletedAt",
            ),
        ).toMatchObject({ severity: "critical" });
    });
});
