import type { ProcessWorkJob } from "./queue.js";

export type ClaimedProcessOutboxMessage = Readonly<{
    messageId: string;
    eventId: string;
    claimToken: string;
    job: ProcessWorkJob;
}>;

export type ProcessOutbox = Readonly<{
    claimProcessWork: (request: {
        limit: number;
        claimToken: string;
        claimedAt: string;
        claimExpiresAt: string;
    }) => Promise<readonly ClaimedProcessOutboxMessage[]>;
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
