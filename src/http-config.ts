export const defaultHttpMaxRequestBodyBytes = 262_144;
export const defaultMaxConcurrentExecutions = 4;

export type HttpConfiguration = {
  maxRequestBodyBytes: number;
  maxConcurrentExecutions: number;
};

export function loadHttpConfiguration(
  environment: Record<string, string | undefined>,
): HttpConfiguration {
  return {
    maxRequestBodyBytes: parsePositiveInteger(
      environment.HTTP_MAX_REQUEST_BODY_BYTES,
      defaultHttpMaxRequestBodyBytes,
      "HTTP_MAX_REQUEST_BODY_BYTES",
    ),
    maxConcurrentExecutions: parsePositiveInteger(
      environment.MAX_CONCURRENT_EXECUTIONS,
      defaultMaxConcurrentExecutions,
      "MAX_CONCURRENT_EXECUTIONS",
    ),
  };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
