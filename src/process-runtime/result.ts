/** 定义 Process Run 的成功/失败结果类型（ProcessRunResult）与公开错误码 */
/**
 * `DEPENDENCY_FAILURE` covers failures that occur before a Business Capability
 * commits its irreversible effect, so retrying costs nothing.
 * `DEPENDENCY_FAILURE_AFTER_COMMIT` covers failures after that effect landed.
 * For priced dependencies the spend has already happened, so a retry spends
 * again and must reach a human rather than be retried silently.
 */
export type ProcessErrorCode =
    | "AGENT_FAILURE"
    | "DEPENDENCY_FAILURE"
    | "DEPENDENCY_FAILURE_AFTER_COMMIT"
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
