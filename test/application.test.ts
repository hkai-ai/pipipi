import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessingApplication,
  type ProcessingApplication,
} from "../src/api/application.js";

const runningApplications: ProcessingApplication[] = [];

afterEach(async () => {
  await Promise.all(
    runningApplications.splice(0).map((application) => application.close()),
  );
});

describe("Processing Application", () => {
  it("serves a ready Process Executor without knowing its Business Processes", async () => {
    let receivedRequest: unknown;
    const application = createProcessingApplication({
      executor: {
        execute: async (request) => {
          receivedRequest = request;
          return {
            runId: "00000000-0000-4000-8000-000000000001",
            process: "test-processing",
            version: "v1",
            status: "succeeded",
            output: { accepted: true },
          };
        },
      },
    });
    runningApplications.push(application);
    const { url } = await application.listen();

    const response = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "test-processing",
        version: "v1",
        input: { value: "request" },
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedRequest).toEqual({
      process: "test-processing",
      version: "v1",
      input: { value: "request" },
    });
    expect(await response.json()).toEqual({
      runId: "00000000-0000-4000-8000-000000000001",
      process: "test-processing",
      version: "v1",
      status: "succeeded",
      output: { accepted: true },
    });
  });

  it("closes injected resources once with the HTTP server", async () => {
    const closeResources = vi.fn<() => Promise<void>>().mockResolvedValue();
    const application = createProcessingApplication({
      executor: {
        execute: async () => ({
          runId: "00000000-0000-4000-8000-000000000001",
          status: "failed",
          error: { code: "INTERNAL_ERROR", message: "unused" },
        }),
      },
      closeResources,
    });
    await application.listen();

    await application.close();
    await application.close();

    expect(closeResources).toHaveBeenCalledTimes(1);
  });
});
