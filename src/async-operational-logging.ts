export type AsyncOperationalLogRecord =
  | Readonly<{
      event: "outbox_message_published" | "outbox_message_publish_failed";
      topic: "process-runs" | "webhook-deliveries";
      timestamp: string;
      messageId: string;
      eventId: string;
      runId?: string;
      deliveryId?: string;
    }>
  | Readonly<{
      event: "process_run_work_finished";
      timestamp: string;
      runId: string;
      attemptNumber?: number;
      outcome: "processed" | "ignored" | "retry_scheduled" | "worker_error";
    }>
  | Readonly<{
      event: "webhook_delivery_attempt_finished";
      timestamp: string;
      deliveryId: string;
      eventId: string;
      attemptNumber: number;
      outcome: "succeeded" | "failed";
      disposition: "completed" | "retry_scheduled" | "claim_lost" | "worker_error";
      httpStatus?: number;
      errorCode?: "HTTP_ERROR" | "NETWORK_ERROR" | "TARGET_REJECTED";
    }>;

export type AsyncOperationalLogSink = (
  record: AsyncOperationalLogRecord,
) => void;

export function emitAsyncOperationalLog(
  sink: AsyncOperationalLogSink | undefined,
  record: AsyncOperationalLogRecord,
): void {
  if (!sink) return;
  try {
    sink(record);
  } catch {
    // Operational logging is best-effort and cannot change durable state.
  }
}

export function writeAsyncOperationalLog(
  record: AsyncOperationalLogRecord,
): void {
  console.log(JSON.stringify(record));
}
