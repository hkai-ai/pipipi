import type { ProcessRunLogRecord } from "./api.js";

export type AttemptActivityComparison = Readonly<{
    attemptNumber: number;
    actual: readonly string[];
    outcome: "matched" | "ended-early" | "diverged";
}>;

/**
 * Puts the Registration's declared activity order beside every observed
 * Attempt. A prefix means the Attempt stopped early; any other sequence is a
 * real divergence worth showing to an operator.
 */
export function compareAttemptActivities(
    declared: readonly string[],
    timeline: readonly ProcessRunLogRecord[],
): readonly AttemptActivityComparison[] {
    if (declared.length === 0) return Object.freeze([]);
    const attempts = new Map<number, string[]>();
    for (const entry of timeline) {
        const actual = attempts.get(entry.attemptNumber) ?? [];
        attempts.set(entry.attemptNumber, actual);
        if (
            entry.event === "process_run_activity_started" &&
            "activity" in entry
        ) {
            actual.push(entry.activity);
        }
    }
    return Object.freeze(
        [...attempts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([attemptNumber, actual]) => {
                const prefix = actual.every(
                    (activity, index) => declared[index] === activity,
                );
                const outcome = !prefix
                    ? "diverged"
                    : actual.length === declared.length
                      ? "matched"
                      : "ended-early";
                return Object.freeze({
                    attemptNumber,
                    actual: Object.freeze(actual),
                    outcome,
                });
            }),
    );
}
