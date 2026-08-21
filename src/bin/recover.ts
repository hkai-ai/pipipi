/** 构造 Recovery 命令，执行一次性队列恢复批次并输出报告 */
import { constructProcessRecoveryCommand } from "../app/process-recovery.js";
import {
    parseQueueRecoveryCommandOptions,
    runQueueRecoveryCommand,
} from "../process-runs/recovery/command.js";

const command = parseQueueRecoveryCommandOptions(
    process.argv.slice(2),
    process.env,
);
const constructed = constructProcessRecoveryCommand(process.env);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        stopping = true;
    });
}

try {
    await constructed.ready();
    const reports = await runQueueRecoveryCommand({
        reconciler: constructed.reconciler,
        command,
        shouldStop: () => stopping,
        onReport: (report) => {
            console.log(
                JSON.stringify({
                    event: "process_queue_recovery_batch_completed",
                    ...report,
                    timestamp: new Date().toISOString(),
                }),
            );
        },
    });
    if (reports.some((report) => report.failed > 0) || stopping) {
        process.exitCode = 1;
    }
} finally {
    await constructed.close();
}
