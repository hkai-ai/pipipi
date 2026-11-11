const previousCodes = [
    "AGENT_FAILURE",
    "DEPENDENCY_FAILURE",
    "INTERNAL_ERROR",
    "INVALID_INPUT",
    "INVALID_OUTPUT",
    "PROCESS_NOT_FOUND",
    "PROCESS_TIMEOUT",
];

function replaceConstraint(pgm, codes) {
    pgm.dropConstraint("process_runs", "process_runs_error_code_check");
    pgm.addConstraint("process_runs", "process_runs_error_code_check", {
        check: `error_code IS NULL OR error_code IN (${codes.map((code) => `'${code}'`).join(", ")})`,
    });
}

export const up = (pgm) =>
    replaceConstraint(pgm, [
        ...previousCodes,
        "DEPENDENCY_FAILURE_AFTER_COMMIT",
    ]);

// 已保存新错误码时，恢复旧约束会失败，事务回滚保留原记录。
export const down = (pgm) => replaceConstraint(pgm, previousCodes);
