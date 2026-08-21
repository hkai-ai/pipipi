/** 调用 app/retention-cleaner.ts 构造 Retention Cleaner Composition Root 并监听端口 */
import { constructRetentionCleanerService } from "../app/retention-cleaner.js";

const { application, port } = constructRetentionCleanerService(process.env);
const { url } = await application.listen({ host: "0.0.0.0", port });

console.log(
    JSON.stringify({
        event: "runtime_role_started",
        role: "retention-cleaner",
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
