type Schedule = (milliseconds: number, operation: () => void) => () => void;

export function createAbortableWait(schedule: Schedule) {
    return (milliseconds: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new DOMException("aborted", "AbortError"));
                return;
            }

            let cancelTimer: () => void = () => undefined;
            const onAbort = () => {
                signal.removeEventListener("abort", onAbort);
                cancelTimer();
                reject(new DOMException("aborted", "AbortError"));
            };
            const onElapsed = () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            };
            signal.addEventListener("abort", onAbort, { once: true });
            cancelTimer = schedule(milliseconds, onElapsed);
        });
}
