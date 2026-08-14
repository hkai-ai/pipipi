import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async observability specification", () => {
    it("covers the production acceptance signals with Runbook-linked alerts", async () => {
        const specification = JSON.parse(
            await readFile("ops/async-observability.json", "utf8"),
        ) as {
            schemaVersion: number;
            dashboards: Array<{ panels: Array<{ metric: string }> }>;
            alerts: Array<{
                metric: string;
                runbook: string;
                severity: string;
            }>;
            correlationKeys: string[];
        };
        const metrics = new Set([
            ...specification.dashboards.flatMap((dashboard) =>
                dashboard.panels.map((panel) => panel.metric),
            ),
            ...specification.alerts.map((alert) => alert.metric),
        ]);
        const alertMetrics = new Set(
            specification.alerts.map((alert) => alert.metric),
        );

        expect(specification.schemaVersion).toBe(1);
        expect(metrics).toEqual(
            expect.objectContaining({
                size: expect.any(Number),
            }),
        );
        for (const required of [
            "logs.process_run_submission_accepted.durationMs",
            "persistence.runs.queueWaitP95Ms",
            "persistence.runs.executionP95Ms",
            "logs.process_run_attempt_finished.durationMs",
            "logs.process_run_activity_finished.durationMs",
            "persistence.runs.failureRateRecent",
            "persistence.runs.stuck",
            "persistence.outbox.oldestProcessLagMs",
            "persistence.webhooks.failureRateRecent",
            "persistence.storage.asyncTablesBytes",
            "queues.process.oldestRunnableAgeMs",
            "queues.webhook.oldestRunnableAgeMs",
        ]) {
            expect(metrics.has(required), required).toBe(true);
        }
        for (const requiredAlert of [
            "logs.process_run_submission_accepted.durationMs",
            "persistence.outbox.oldestWebhookLagMs",
            "logs.retention_cleanup_sweep_failed.count",
            "persistence.cleanup.lastCompletedAt",
            "persistence.recovery.lastCompletedAt",
            "persistence.recovery.lastFailedItems",
        ]) {
            expect(alertMetrics.has(requiredAlert), requiredAlert).toBe(true);
        }
        expect(specification.correlationKeys).toEqual([
            "runId",
            "eventId",
            "deliveryId",
        ]);
        expect(
            specification.alerts
                .filter((alert) =>
                    [
                        "persistence.webhooks.failureRateRecent",
                        "queues.webhook.oldestRunnableAgeMs",
                        "persistence.recovery.lastCompletedAt",
                        "persistence.recovery.lastFailedItems",
                    ].includes(alert.metric),
                )
                .every((alert) => alert.severity === "critical"),
        ).toBe(true);
        expect(
            specification.alerts.every((alert) =>
                alert.runbook.startsWith("docs/async-process-runs-runbook.md#"),
            ),
        ).toBe(true);
    });
});
