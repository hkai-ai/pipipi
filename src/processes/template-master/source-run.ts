/** 受理阶段校验并读取 template-master/v1 引用的上游 template-from-image 运行产物。 */
import {
    type InputValidationDetail,
    sanitizeDiagnosticText,
} from "../../process-runtime/input-validation.js";
import {
    type AcceptedProcessInput,
    buildAcceptedProcessInput,
} from "../../process-runtime/registration.js";
import type { SourceRunErrorCode } from "../../process-runtime/result.js";
import { sourceConditionSchema } from "../template-from-image/design-spec/contract.js";
import { isSourceRunMasterInput, masterTemplateSchema } from "./contract.js";

export type TemplateMasterSourceRunRecord = Readonly<{
    runId: string;
    ownerId?: string;
    process?: string;
    version?: string;
    status: "queued" | "running" | "succeeded" | "failed";
    resultExpiredAt?: string;
    output?: unknown;
}>;

export type TemplateMasterSourceRunLookup = (
    runId: string,
) => Promise<TemplateMasterSourceRunRecord | undefined>;

export type TemplateMasterSourceRunResolution =
    | Readonly<{
          ok: true;
          acceptedInput: AcceptedProcessInput;
      }>
    | Readonly<{
          ok: false;
          code: SourceRunErrorCode | "INVALID_INPUT";
          message: string;
          details: readonly InputValidationDetail[];
      }>;

/**
 * 若 acceptedInput 为 template-master/v1 的 sourceRunId 模式，在入队或执行前按当前 caller
 * 校验上游运行归属、流程、终态、有效期与产物完整性，并将解析结果写入不可变 acceptedInput。
 */
export async function resolveTemplateMasterAcceptedInput(
    acceptedInput: AcceptedProcessInput,
    context: Readonly<{ callerId?: string }>,
    lookup?: TemplateMasterSourceRunLookup,
): Promise<TemplateMasterSourceRunResolution> {
    if (
        acceptedInput.process !== "template-master" ||
        acceptedInput.version !== "v1" ||
        !isSourceRunMasterInput(acceptedInput.input)
    ) {
        return { ok: true, acceptedInput };
    }

    const input = acceptedInput.input;
    const sourceRunId = input.sourceRunId;

    if (!context.callerId) {
        return failure(
            "SOURCE_RUN_FORBIDDEN",
            "Authenticated caller identity is required to reference sourceRunId",
            "caller identity is required to reference a source run",
        );
    }

    const safeSourceRunId = sanitizeDiagnosticText(sourceRunId, 128);
    if (!lookup) {
        return failure(
            "SOURCE_RUN_NOT_FOUND",
            `Source run ${safeSourceRunId} was not found`,
            "source run store is unavailable or run was not found",
        );
    }

    const record = await lookup(sourceRunId);
    if (!record) {
        return failure(
            "SOURCE_RUN_NOT_FOUND",
            `Source run ${safeSourceRunId} was not found`,
            "source run does not exist",
        );
    }

    // 先做归属校验，避免跨 caller 探测他人运行的流程类型、状态或产物。
    if (!record.ownerId || record.ownerId !== context.callerId) {
        return failure(
            "SOURCE_RUN_FORBIDDEN",
            "Source run does not belong to the authenticated caller",
            "source run belongs to a different caller",
        );
    }

    if (record.process !== "template-from-image") {
        return failure(
            "SOURCE_RUN_INVALID_PROCESS",
            `Source run process must be template-from-image, got ${record.process ?? "unknown"}`,
            "source run must be a template-from-image process run",
        );
    }

    if (record.status !== "succeeded") {
        return failure(
            "SOURCE_RUN_NOT_READY",
            `Source run is not ready (status: ${record.status})`,
            `source run status is ${record.status}, expected succeeded`,
        );
    }

    if (record.resultExpiredAt !== undefined) {
        return failure(
            "SOURCE_RUN_EXPIRED",
            "Source run output has expired and is no longer available",
            "source run output has expired",
        );
    }

    const output = record.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) {
        return failure(
            "SOURCE_RUN_MISSING_CONDITION",
            "Source run output is unavailable or missing template and source.condition",
            "source run output is missing template and source.condition",
        );
    }
    const outputRecord = output as Record<string, unknown>;
    const rawTemplate = outputRecord.template;
    const rawSource = outputRecord.source;
    const rawCondition =
        rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)
            ? (rawSource as Record<string, unknown>).condition
            : undefined;

    const parsedTemplate = masterTemplateSchema.safeParse(rawTemplate);
    const parsedCondition = sourceConditionSchema.safeParse(rawCondition);
    if (!parsedTemplate.success || !parsedCondition.success) {
        return failure(
            "SOURCE_RUN_MISSING_CONDITION",
            "Source run output does not contain a valid v4 template and source.condition (requires template-from-image/v3)",
            "source run output is missing a valid v4 template or source.condition",
        );
    }

    const resolvedSnapshot = buildAcceptedProcessInput(
        { id: acceptedInput.process, version: acceptedInput.version },
        {
            imageUrl: input.imageUrl,
            sourceRunId,
            template: parsedTemplate.data,
            condition: parsedCondition.data,
            budget: input.budget,
        },
    );
    if (!resolvedSnapshot) {
        return failure(
            "INVALID_INPUT",
            "Resolved template-master/v1 input exceeds the maximum accepted input size",
            "resolved input exceeds accepted size limit",
        );
    }

    return { ok: true, acceptedInput: resolvedSnapshot };
}

function failure(
    code: SourceRunErrorCode | "INVALID_INPUT",
    message: string,
    detailMessage: string,
): Extract<TemplateMasterSourceRunResolution, { ok: false }> {
    return Object.freeze({
        ok: false,
        code,
        message,
        details: Object.freeze([
            Object.freeze({
                path: "/sourceRunId",
                keyword: "sourceRun",
                message: detailMessage,
            }),
        ]),
    });
}
