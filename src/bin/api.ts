import { constructProcessingService } from "../app/api.js";

const { application, port } = constructProcessingService(process.env);
const { url } = await application.listen({ host: "0.0.0.0", port });

console.log(
    JSON.stringify({
        event: "service_started",
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
