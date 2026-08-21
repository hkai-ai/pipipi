/** Webhook 事务 Outbox 的认领/发布/释放接口 */
import type { WebhookDeliveryJob } from "../delivery/job.js";

export type ClaimedWebhookOutboxMessage = Readonly<{
    messageId: string;
    eventId: string;
    claimToken: string;
    job: WebhookDeliveryJob;
}>;

export type WebhookOutbox = Readonly<{
    claimWebhookWork: (request: {
        limit: number;
        claimToken: string;
        claimedAt: string;
        claimExpiresAt: string;
    }) => Promise<readonly ClaimedWebhookOutboxMessage[]>;
    markPublished: (request: {
        messageId: string;
        claimToken: string;
        publishedAt: string;
    }) => Promise<boolean>;
    release: (request: {
        messageId: string;
        claimToken: string;
    }) => Promise<boolean>;
}>;
