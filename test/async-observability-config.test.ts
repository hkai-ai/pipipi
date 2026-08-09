import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Async observability specification", () => {
  it("covers the production acceptance signals with Runbook-linked alerts", async () => {
    const specification = JSON.parse(
      await readFile("ops/async-observability.json", "utf8"),
    ) as {
      schemaVersion: number;
      dashboards: Array<{ panels: Array<{ metric: string }> }>;
      alerts: Array<{ metric: string; runbook: string }>;
    };
    const metrics = new Set([
      ...specification.dashboards.flatMap((dashboard) =>
        dashboard.panels.map((panel) => panel.metric),
      ),
      ...specification.alerts.map((alert) => alert.metric),
    ]);

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
    expect(specification.alerts.every((alert) => alert.runbook.startsWith("docs/async-process-runs-runbook.md#"))).toBe(true);
  });
});
