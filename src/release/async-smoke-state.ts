/** smoke 之后的数据库状态审计 */
export type AsyncSmokeState = Readonly<{
    schemaVersion: 1;
    event: "async_smoke_state_audited";
    measuredAt: string;
    runIds: readonly string[];
    runs: Readonly<{
        count: number;
        terminalCount: number;
        ownersPresent: boolean;
        idempotencyPresent: boolean;
        deliveriesPresent: boolean;
    }>;
    processEventCount: number;
    outboxMessageCount: number;
    deliveryCount: number;
    deliveryRunCount: number;
    additiveSchemaPresent: boolean;
}>;

export type AsyncSmokeStateQuery = Readonly<{
    query: <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[],
    ) => Promise<{ rows: Row[] }>;
}>;

export async function auditAsyncSmokeState(options: {
    database: AsyncSmokeStateQuery;
    runIds: readonly string[];
    clock?: () => string;
}): Promise<AsyncSmokeState> {
    const runIds = validateRunIds(options.runIds);
    const result = await options.database.query<AuditRow>(auditQuery, [runIds]);
    const row = result.rows[0];
    if (!row) throw new Error("Async smoke state audit returned no row");
    const count = integer(row.run_count, "Run count");
    return Object.freeze({
        schemaVersion: 1,
        event: "async_smoke_state_audited",
        measuredAt: (options.clock ?? (() => new Date().toISOString()))(),
        runIds,
        runs: Object.freeze({
            count,
            terminalCount: integer(row.terminal_count, "terminal Run count"),
            ownersPresent: integer(row.owner_count, "owner count") === count,
            idempotencyPresent:
                integer(row.idempotency_count, "idempotency count") === count,
            deliveriesPresent:
                integer(row.delivery_run_count, "Delivery Run count") === count,
        }),
        processEventCount: integer(row.event_count, "Process Event count"),
        outboxMessageCount: integer(row.outbox_count, "Outbox count"),
        deliveryCount: integer(row.delivery_count, "Delivery count"),
        deliveryRunCount: integer(row.delivery_run_count, "Delivery Run count"),
        additiveSchemaPresent: integer(row.schema_count, "schema count") === 8,
    });
}

export async function waitForAsyncSmokeDeliveryCoverage(options: {
    read: () => Promise<AsyncSmokeState>;
    maximumAttempts?: number;
    intervalMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
}): Promise<AsyncSmokeState> {
    const maximumAttempts = positiveInteger(
        options.maximumAttempts ?? 30,
        "maximum attempts",
    );
    const intervalMs = positiveInteger(
        options.intervalMs ?? 1_000,
        "poll interval",
    );
    const wait =
        options.wait ??
        ((milliseconds) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const state = await options.read();
        if (state.deliveryRunCount === state.runs.count) return state;
        if (state.deliveryRunCount > state.runs.count) {
            throw new Error("Async smoke Delivery Run count is inconsistent");
        }
        if (attempt < maximumAttempts) await wait(intervalMs);
    }
    throw new Error(
        "Both controlled smoke Runs did not produce a Webhook Delivery",
    );
}

type AuditRow = Record<string, unknown> & {
    run_count: unknown;
    terminal_count: unknown;
    owner_count: unknown;
    idempotency_count: unknown;
    event_count: unknown;
    outbox_count: unknown;
    delivery_count: unknown;
    delivery_run_count: unknown;
    schema_count: unknown;
};

const auditQuery = `
SELECT
  (SELECT count(*)::integer FROM process_runs WHERE run_id = ANY($1::uuid[])) AS run_count,
  (SELECT count(*)::integer FROM process_runs WHERE run_id = ANY($1::uuid[]) AND status IN ('succeeded', 'failed')) AS terminal_count,
  (SELECT count(*)::integer FROM process_runs WHERE run_id = ANY($1::uuid[]) AND octet_length(caller_id) > 0) AS owner_count,
  (SELECT count(*)::integer FROM process_runs WHERE run_id = ANY($1::uuid[]) AND octet_length(idempotency_key) > 0) AS idempotency_count,
  (SELECT count(*)::integer FROM process_events WHERE run_id = ANY($1::uuid[])) AS event_count,
  (SELECT count(*)::integer FROM outbox_messages messages JOIN process_events events USING (event_id) WHERE events.run_id = ANY($1::uuid[])) AS outbox_count,
  (SELECT count(*)::integer FROM webhook_deliveries WHERE run_id = ANY($1::uuid[])) AS delivery_count,
  (SELECT count(DISTINCT run_id)::integer FROM webhook_deliveries WHERE run_id = ANY($1::uuid[])) AS delivery_run_count,
  (SELECT count(*)::integer FROM unnest(ARRAY[
      to_regclass('process_runs'),
      to_regclass('process_run_attempts'),
      to_regclass('process_events'),
      to_regclass('outbox_messages'),
      to_regclass('webhook_deliveries'),
      to_regclass('queue_recovery_runs'),
      to_regclass('process_run_records'),
      to_regclass('process_run_activities')
  ]) table_name WHERE table_name IS NOT NULL) AS schema_count
`;

function validateRunIds(values: readonly string[]): readonly string[] {
    if (values.length === 0 || values.length > 20) {
        throw new Error("Async smoke state audit requires 1 to 20 Run IDs");
    }
    for (const value of values) {
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                value,
            )
        ) {
            throw new Error("Async smoke state audit Run ID is invalid");
        }
    }
    return Object.freeze([...values]);
}

function integer(value: unknown, label: string): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Async smoke ${label} must be positive`);
    }
    return value;
}
