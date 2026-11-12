/** 归一模板成图单次提交的明确拒绝和结果未知，仅保留状态码。 */
export class TemplateImageSubmissionError extends Error {
    constructor(
        readonly type: "provider_rejected" | "submission_unknown",
        readonly httpStatus?: number,
    ) {
        super(
            type === "provider_rejected"
                ? "图片服务明确拒绝提交"
                : "图片提交结果未知",
        );
    }

    static fromStatus(status?: number) {
        const rejected =
            status !== undefined &&
            status >= 400 &&
            status < 500 &&
            ![408, 409, 425, 429].includes(status);
        return new TemplateImageSubmissionError(
            rejected ? "provider_rejected" : "submission_unknown",
            status,
        );
    }
}
