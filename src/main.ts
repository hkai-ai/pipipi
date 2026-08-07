import { createProcessingApplication } from "./application.js";
import { HttpContentProcessingCapability } from "./content-processing.js";

const businessApiBaseUrl = process.env.BUSINESS_API_BASE_URL;
if (!businessApiBaseUrl) {
  throw new Error("BUSINESS_API_BASE_URL is required");
}

const port = parsePort(process.env.PORT);
const application = createProcessingApplication({
  contentProcessing: new HttpContentProcessingCapability({
    baseUrl: businessApiBaseUrl,
    timeoutMs: parseTimeout(process.env.BUSINESS_API_TIMEOUT_MS, 10_000),
  }),
  processTimeoutMs: parseTimeout(process.env.PROCESS_TIMEOUT_MS, 30_000),
});
const { url } = await application.listen({ host: "0.0.0.0", port });

console.log(`Business processing service listening at ${url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void application.close().then(() => {
      process.exitCode = 0;
    });
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("Timeout values must be positive integers");
  }
  return timeout;
}
