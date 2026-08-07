const serviceBaseUrl = requiredEnvironment("STAGING_SERVICE_BASE_URL");
const timeoutMs = positiveIntegerEnvironment(
  "STAGING_SMOKE_TIMEOUT_MS",
  180_000,
);
const headers: Record<string, string> = {
  "content-type": "application/json",
};
if (process.env.STAGING_AUTHORIZATION) {
  headers.authorization = process.env.STAGING_AUTHORIZATION;
}

const healthResponse = await fetch(new URL("/healthz", serviceBaseUrl), {
  headers,
  signal: AbortSignal.timeout(timeoutMs),
});
if (!healthResponse.ok) {
  throw new Error(`Staging health check failed with HTTP ${healthResponse.status}`);
}

const successResponse = await execute({
  process: "content-processing",
  version: "v1",
  input: {
    content:
      process.env.STAGING_SMOKE_CONTENT ??
      "Rewrite this controlled MVP staging sentence clearly.",
  },
});
const successBody = await readJson(successResponse);
if (!successResponse.ok || !isSuccessfulExecution(successBody)) {
  throw new Error(
    `Staging execution failed with HTTP ${successResponse.status} (${safeErrorCode(successBody)})`,
  );
}

const failureResponse = await execute({
  process: "content-processing",
  version: "v1",
  input: { content: "   " },
});
const failureBody = await readJson(failureResponse);
if (
  failureResponse.status !== 400 ||
  !isSafeInvalidInputFailure(failureBody)
) {
  throw new Error(
    `Staging failure-contract check failed with HTTP ${failureResponse.status} (${safeErrorCode(failureBody)})`,
  );
}

console.log(
  JSON.stringify({
    event: "staging_smoke_completed",
    runId: successBody.runId,
    process: successBody.process,
    version: successBody.version,
    status: successBody.status,
  }),
);

function execute(body: unknown): Promise<Response> {
  return fetch(new URL("/execute", serviceBaseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Staging service returned non-JSON HTTP ${response.status}`);
  }
}

function isSuccessfulExecution(value: unknown): value is {
  runId: string;
  process: "content-processing";
  version: "v1";
  status: "succeeded";
  output: { content: string };
} {
  if (!isRecord(value) || !isRecord(value.output)) return false;
  return (
    typeof value.runId === "string" &&
    value.process === "content-processing" &&
    value.version === "v1" &&
    value.status === "succeeded" &&
    typeof value.output.content === "string" &&
    value.output.content.trim().length > 0
  );
}

function isSafeInvalidInputFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["error", "process", "runId", "status", "version"]) &&
    typeof value.runId === "string" &&
    value.process === "content-processing" &&
    value.version === "v1" &&
    value.status === "failed" &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ["code", "message"]) &&
    value.error.code === "INVALID_INPUT" &&
    value.error.message === "The process input is invalid"
  );
}

function safeErrorCode(value: unknown): string {
  return isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
    ? value.error.code
    : "UNKNOWN";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
