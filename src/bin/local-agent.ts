/** 启动只监听回环地址的单进程文本 Agent 本地联调服务 */
import { constructLocalAgentService } from "../app/local-agent.js";

const { application, port } = constructLocalAgentService(process.env);
const { url } = await application.listen({ host: "127.0.0.1", port });

console.log(
    JSON.stringify({
        event: "local_agent_service_started",
        mode: "scripted-text-only",
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
