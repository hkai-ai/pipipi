import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeRoleApplication,
  type BackgroundRuntime,
} from "../src/api/role.js";

describe("Runtime role application", () => {
  it("keeps liveness independent and reports dynamic readiness", async () => {
    let dependencyReady = false;
    const ready = vi.fn(async () => {
      if (!dependencyReady) throw new Error("redis://secret-host unavailable");
    });
    const runtime = fakeRuntime({ ready });
    const application = createRuntimeRoleApplication({
      role: "process-dispatcher",
      runtime,
      readinessTimeoutMs: 50,
    });
    const { url } = await application.listen();

    try {
      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: "ok",
        role: "process-dispatcher",
      });
      expect(ready).not.toHaveBeenCalled();

      const unavailable = await fetch(`${url}/readyz`);
      expect(unavailable.status).toBe(503);
      const unavailableBody = await unavailable.text();
      expect(JSON.parse(unavailableBody)).toEqual({
        status: "not_ready",
        role: "process-dispatcher",
      });
      expect(unavailableBody).not.toContain("secret-host");

      dependencyReady = true;
      const available = await fetch(`${url}/readyz`);
      expect(available.status).toBe(200);
      expect(await available.json()).toEqual({
        status: "ready",
        role: "process-dispatcher",
      });
    } finally {
      await application.close();
    }
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("bounds a readiness check that never settles", async () => {
    const application = createRuntimeRoleApplication({
      role: "process-worker",
      runtime: fakeRuntime({ ready: async () => new Promise(() => {}) }),
      readinessTimeoutMs: 10,
    });
    const { url } = await application.listen();
    try {
      const readiness = await fetch(`${url}/readyz`);
      expect(readiness.status).toBe(503);
    } finally {
      await application.close();
    }
  });

  it("validates configuration and closes an unstarted runtime once", async () => {
    const runtime = fakeRuntime();
    expect(() =>
      createRuntimeRoleApplication({
        role: "process-worker",
        runtime,
        readinessTimeoutMs: 0,
      }),
    ).toThrow("Runtime role readiness timeout must be a positive safe integer");

    const application = createRuntimeRoleApplication({
      role: "process-worker",
      runtime,
    });
    await application.close();
    await application.close();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledOnce();
    await expect(application.listen()).rejects.toThrow(
      "Runtime role application is closed",
    );
  });
});

function fakeRuntime(
  overrides: Partial<BackgroundRuntime> = {},
): BackgroundRuntime {
  const start = vi.fn<BackgroundRuntime["start"]>(async () => undefined);
  const close = vi.fn<BackgroundRuntime["close"]>(async () => undefined);
  return {
    start,
    ready: async () => undefined,
    close,
    ...overrides,
  };
}
