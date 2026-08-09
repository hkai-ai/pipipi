import type { BackgroundRuntime } from "../api/role.js";
import type { OutboxDispatcher } from "../runs/outbox-dispatcher.js";

export function createWebhookWorkerRuntime(options: {
    dispatcher: OutboxDispatcher;
    worker: Readonly<{
        start: () => Promise<void>;
        ready: () => Promise<void>;
        close: () => Promise<void>;
    }>;
    databaseReady: () => Promise<void>;
    queueReady: () => Promise<void>;
    closeResources: () => Promise<void>;
    dispatchIntervalMs?: number;
    onError?: () => void;
}): BackgroundRuntime {
    const intervalMs = positiveInteger(
        options.dispatchIntervalMs ?? 1_000,
        "Webhook outbox dispatch interval",
    );
    const onError = options.onError ?? reportDispatchError;
    let dispatching: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let started = false;
    let closed = false;

    const dispatch = () => {
        if (closed || dispatching) return;
        dispatching = options.dispatcher
            .dispatchOnce()
            .then(() => undefined)
            .catch(() => onError())
            .finally(() => {
                dispatching = undefined;
                if (!closed) timer = setTimeout(dispatch, intervalMs);
            });
    };

    return Object.freeze({
        start: async () => {
            if (closed) throw new Error("Webhook Worker Runtime is closed");
            if (started) return;
            started = true;
            await options.worker.start();
            dispatch();
        },
        ready: async () => {
            await Promise.all([
                options.databaseReady(),
                options.queueReady(),
                options.worker.ready(),
            ]);
        },
        close: async () => {
            if (closed) return;
            closed = true;
            if (timer) clearTimeout(timer);
            await dispatching;
            try {
                await options.worker.close();
            } finally {
                await options.closeResources();
            }
        },
    });
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function reportDispatchError(): void {
    console.error(
        JSON.stringify({
            event: "webhook_outbox_dispatch_error",
            timestamp: new Date().toISOString(),
        }),
    );
}
