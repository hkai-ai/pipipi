import { constructWebhookWorkerService } from "./webhook-runtime-construction.js";

const { application, port } = constructWebhookWorkerService(process.env);
const { url } = await application.listen({ host: "0.0.0.0", port });

console.log(
  JSON.stringify({
    event: "runtime_role_started",
    role: "webhook-worker",
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
