/** 调用 app/process-worker.ts 构造 Process Worker Composition Root 并监听端口 */
import { constructProcessWorkerService } from "../app/process-worker.js";

const { application, port } = constructProcessWorkerService(process.env);
const { url } = await application.listen({ host: "0.0.0.0", port });

console.log(
    JSON.stringify({
        event: "runtime_role_started",
        role: "process-worker",
        timestamp: new Date().toISOString(),
        url,
    }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        void application.close().then(() => {
            process.exitCode = 0;
        });
    });
}
