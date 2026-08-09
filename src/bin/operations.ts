import { constructAsyncOperationsCommand } from "../process-runs/ops/command.js";

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
