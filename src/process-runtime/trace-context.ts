/** 将请求内的 Pi 会话归属到实际运行的 Attempt 和活动实例。 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PiSessionTrace } from "./pi-trace.js";

export type TraceActivity = {
    runId: string;
    attemptNumber: number;
    activityId: number;
    activity: string;
    collectionFailed?: boolean;
    sessions: PiSessionTrace[];
};
const context = new AsyncLocalStorage<TraceActivity>();
export function currentTraceActivity(): TraceActivity | undefined {
    return context.getStore();
}
export function withTraceActivity<T>(
    activity: TraceActivity,
    operation: () => T,
): T {
    return context.run(activity, operation);
}
