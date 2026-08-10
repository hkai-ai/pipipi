export type ProcessErrorCode =
    | "AGENT_FAILURE"
    | "DEPENDENCY_FAILURE"
    | "INTERNAL_ERROR"
    | "INVALID_INPUT"
    | "INVALID_OUTPUT"
    | "PROCESS_NOT_FOUND"
    | "PROCESS_TIMEOUT";

export type ProcessRunResult =
    | {
          runId: string;
          process: string;
          version: string;
          status: "succeeded";
          output: unknown;
      }
    | {
          runId: string;
          process?: string;
          version?: string;
          status: "failed";
          error: {
              code: ProcessErrorCode;
              message: string;
          };
      };

export function processFailure(
    runId: string,
    code: ProcessErrorCode,
    message: string,
    identity: { process?: string; version?: string } = {},
): ProcessRunResult {
    return {
        runId,
        ...identity,
        status: "failed",
        error: { code, message },
    };
}
