import type { OutboxDispatcher } from "./outbox-dispatcher.js";
import type { ProcessRunReconciler } from "./process-run-reconciler.js";
import type { BackgroundRuntime } from "./runtime-role-application.js";

export type ProcessDispatcherOperation =
  | "outbox_dispatch"
  | "run_reconciliation";

export function createProcessDispatcherRuntime(options: {
  dispatcher: OutboxDispatcher;
  reconciler: ProcessRunReconciler;
  databaseReady: () => Promise<void>;
  queueReady: () => Promise<void>;
  closeResources: () => Promise<void>;
  dispatchIntervalMs?: number;
  reconciliationIntervalMs?: number;
  onError?: (operation: ProcessDispatcherOperation) => void;
}): BackgroundRuntime {
  const onError = options.onError ?? reportDispatcherError;
  const dispatchLoop = createPeriodicLoop(
    () => options.dispatcher.dispatchOnce(),
    positiveInteger(
      options.dispatchIntervalMs ?? 1_000,
      "Outbox dispatch interval",
    ),
    () => onError("outbox_dispatch"),
  );
  const reconciliationLoop = createPeriodicLoop(
    () => options.reconciler.reconcileOnce(),
    positiveInteger(
      options.reconciliationIntervalMs ?? 30_000,
      "Process Run reconciliation interval",
    ),
    () => onError("run_reconciliation"),
  );
  let started = false;
  let closed = false;

  return Object.freeze({
    start: async () => {
      if (closed) throw new Error("Process Dispatcher is closed");
      if (started) return;
      started = true;
      dispatchLoop.start();
      reconciliationLoop.start();
    },
    ready: async () => {
      await Promise.all([options.databaseReady(), options.queueReady()]);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await Promise.all([dispatchLoop.close(), reconciliationLoop.close()]);
      } finally {
        await options.closeResources();
      }
    },
  });
}

function createPeriodicLoop(
  operation: () => Promise<unknown>,
  intervalMs: number,
  onError: () => void,
): Readonly<{ start: () => void; close: () => Promise<void> }> {
  let current: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const run = () => {
    if (stopped || current) return;
    current = operation()
      .then(() => undefined)
      .catch(() => onError())
      .finally(() => {
        current = undefined;
        if (!stopped) timer = setTimeout(run, intervalMs);
      });
  };

  return Object.freeze({
    start: run,
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function reportDispatcherError(operation: ProcessDispatcherOperation): void {
  console.error(
    JSON.stringify({
      event: "process_dispatcher_error",
      operation,
      timestamp: new Date().toISOString(),
    }),
  );
}
