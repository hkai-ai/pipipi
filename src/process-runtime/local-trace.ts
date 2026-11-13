/** 在显式本地请求存活期间提供按 runId 查询的调试字段，退出后撤销写入并清除正文。 */
import { AsyncLocalStorage } from "node:async_hooks";
import { currentTraceActivity } from "./trace-context.js";

export type LocalTraceEvent = {
    kind: "input" | "model" | "toolCall" | "toolResult" | "validation";
    field: string;
    value?: string;
    note?: string;
    activityId?: number;
    sessionId?: number;
    round?: number;
    call?: number;
};
type Run = { runId: string; process: string; version: string };
type Snapshot = Run & { events: LocalTraceEvent[] };
type Scope = { start?: (run: Run) => Snapshot; active?: Snapshot };
const requestScope = new AsyncLocalStorage<Scope>();

export function createLocalTrace() {
    const runs = new Map<string, Snapshot>();
    return {
        list: () =>
            Array.from(runs.values(), ({ runId, process, version }) => ({
                runId,
                process,
                version,
            })),
        find: (id: string) => runs.get(id),
        request: async <T>(signal: AbortSignal, execute: () => Promise<T>) => {
            const scope: Scope = {
                start: (run) => {
                    const snapshot = { ...run, events: [] };
                    runs.set(run.runId, snapshot);
                    return snapshot;
                },
            };
            const clear = () => {
                delete scope.start;
                if (!scope.active) return;
                runs.delete(scope.active.runId);
                scope.active.events.length = 0;
                delete scope.active;
            };
            if (signal.aborted) clear();
            signal.addEventListener("abort", clear, { once: true });
            try {
                return await requestScope.run(scope, execute);
            } finally {
                signal.removeEventListener("abort", clear);
                clear();
            }
        },
    };
}
export function startLocalTrace(run: Run) {
    const scope = requestScope.getStore();
    if (scope?.start && !scope.active) scope.active = scope.start(run);
}

export function recordLocalField(
    kind: LocalTraceEvent["kind"],
    field: string,
    read: () => { value?: string; note?: string },
    link?: Pick<LocalTraceEvent, "sessionId" | "round" | "call">,
) {
    const snapshot = requestScope.getStore()?.active;
    if (!snapshot || snapshot.events.length >= 128) return;
    const activity = currentTraceActivity();
    if (activity && snapshot.runId !== activity.runId) return;
    try {
        const item = read();
        // Oversized values are omitted as a whole so a truncated string cannot look like the model's text.
        const content =
            item.value && item.value.length > 4096
                ? { note: "字段超过本地展示上限，正文已省略。" }
                : item;
        snapshot.events.push({
            kind,
            field,
            ...content,
            ...(activity ? { activityId: activity.activityId } : {}),
            ...link,
        });
    } catch {
        /* Observing a field cannot change model or business execution. */
    }
}
