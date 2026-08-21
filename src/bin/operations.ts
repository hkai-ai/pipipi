/** 构造 Operations 命令，执行一次性异步任务快照并输出报告 */
import { constructAsyncOperationsCommand } from "../app/async-operations.js";

const command = constructAsyncOperationsCommand(process.env);
try {
    await command.ready();
    const snapshot = await command.snapshot();
    console.log(
        JSON.stringify({
            event: "async_operations_snapshot",
            ...snapshot,
        }),
    );
} finally {
    await command.close();
}
