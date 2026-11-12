/** 限定模板网关回执字段；供应商消息、请求正文和凭证不进入生产记录。 */
import { z } from "zod";
export const reasonSchema = z.enum([
    "http_error",
    "connection",
    "timeout",
    "cancelled",
    "invalid_response",
    "storage",
    "unknown",
    "delivered",
]);
export const receiptSchema = z.object({
    reason: reasonSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
    requestId: z
        .string()
        .regex(/^(?!sk-|Bearer|eyJ)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/i)
        .optional()
        .catch(undefined),
    errorCode: z
        .enum([
            "invalid_api_key",
            "invalid_request_error",
            "invalid_parameter",
            "insufficient_quota",
            "rate_limit_exceeded",
            "content_policy_violation",
            "model_not_found",
            "server_error",
            "service_unavailable",
            "upstream_error",
            "authentication_error",
            "permission_denied",
            "invalid_image",
            "model_unavailable",
            "timeout",
        ])
        .optional()
        .catch(undefined),
});
export type GatewayReceipt = z.infer<typeof receiptSchema>;

export const attemptReceiptSchema = receiptSchema.extend({
    hasSavedImage: z.boolean(),
    state: z.enum([
        "provider_rejected",
        "approved",
        "submission_unknown",
        "provider_pending",
        "provider_complete",
        "image_ready",
    ]),
});
