#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 9 ]; then
    echo "Expected application root, revision, phase, two Run IDs, and four request IDs" >&2
    exit 1
fi

app_root="$1"
revision="$2"
phase="$3"
success_run_id="$4"
failure_run_id="$5"
success_submit_request_id="$6"
failure_submit_request_id="$7"
success_observe_request_id="$8"
failure_observe_request_id="$9"

if ! printf '%s' "$app_root" | grep -Eq '^/[A-Za-z0-9._/-]+$' || \
    ! printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || \
    ! printf '%s' "$phase" | grep -Eq '^(baseline|rollback)$'; then
    echo "Invalid async smoke evidence request" >&2
    exit 1
fi
for value in "$success_run_id" "$failure_run_id"; do
    if ! printf '%s' "$value" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
        echo "Invalid async smoke Run ID" >&2
        exit 1
    fi
done
for value in "$success_submit_request_id" "$failure_submit_request_id" "$success_observe_request_id" "$failure_observe_request_id"; do
    if ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_.:-]{1,200}$'; then
        echo "Invalid async smoke request ID" >&2
        exit 1
    fi
done

shared="$app_root/shared"
dispatcher_env="$shared/process-dispatcher.env"
database_ca="$shared/pg-server.crt"
image="pipipi:$revision"
temporary="$(mktemp -d)"
operations="$temporary/operations.json"
audit="$temporary/audit.json"
logs="$temporary/logs.txt"
correlated="$temporary/correlated.json"
roles="$temporary/roles.json"

cleanup() {
    rm -f -- "$operations" "$audit" "$logs" "$correlated" "$roles"
    rmdir "$temporary" 2>/dev/null || true
}
trap cleanup EXIT

container_environment() {
    container="$1"
    name="$2"
    docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' |
        awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }'
}

for container in \
    pipipi \
    pipipi-business-api \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    if [ "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" != "$revision" ]; then
        echo "Async smoke role revision mismatch" >&2
        exit 1
    fi
done

printf '%s\n' '[' > "$roles"
first="true"
for role_and_port in \
    'api 4300' \
    'business-api 4400' \
    'process-dispatcher 4310' \
    'process-worker 4320' \
    'webhook-worker 4330' \
    'retention-cleaner 4340'; do
    read -r role port <<< "$role_and_port"
    curl --fail --silent --show-error "http://127.0.0.1:$port/healthz" >/dev/null
    curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null
    if [ "$first" = "false" ]; then printf '%s\n' ',' >> "$roles"; fi
    printf '{"role":"%s","health":"ok","readiness":"ready"}' "$role" >> "$roles"
    first="false"
done
printf '%s\n' ']' >> "$roles"

process_queue_name="$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_NAME)"
process_queue_prefix="$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_PREFIX)"
webhook_queue_name="$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_NAME)"
webhook_queue_prefix="$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)"

docker run --rm --env-file "$dispatcher_env" \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix" \
    --env WEBHOOK_QUEUE_NAME="$webhook_queue_name" \
    --env WEBHOOK_QUEUE_PREFIX="$webhook_queue_prefix" \
    --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint node "$image" dist/bin/operations.js > "$operations"

audit_state() {
    audit_options=()
    if [ "$phase" = "baseline" ]; then
        audit_options+=(--wait-for-deliveries)
    fi
    docker run --rm --env-file "$dispatcher_env" \
        --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
        --entrypoint node "$image" \
        dist/bin/audit-async-smoke-state.js \
        "${audit_options[@]}" \
        "$success_run_id" "$failure_run_id" > "$audit"
}

audit_state

for container in pipipi pipipi-process-dispatcher pipipi-process-worker; do
    docker logs --since 30m "$container" >> "$logs" 2>&1
done

docker run --rm -i --entrypoint node "$image" -e '
const [successRun, failureRun, successSubmit, failureSubmit, successObserve, failureObserve] = process.argv.slice(1);
const runIds = new Set([successRun, failureRun]);
const required = new Map([...runIds].map((runId) => [runId, new Set()]));
const output = [];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString("utf8");
for (const line of text.split("\n")) {
  const start = line.indexOf("{");
  if (start < 0) continue;
  let record;
  try { record = JSON.parse(line.slice(start)); } catch { continue; }
  if (!runIds.has(record.runId)) continue;
  if (record.event === "process_run_submission_accepted") {
    const expected = record.runId === successRun ? successSubmit : failureSubmit;
    if (record.requestId !== expected) continue;
    required.get(record.runId).add("accepted");
  } else if (record.event === "process_run_observed") {
    const expected = record.runId === successRun ? successObserve : failureObserve;
    if (record.requestId !== expected || !["succeeded", "failed"].includes(record.status)) continue;
    required.get(record.runId).add("observed");
  } else if (record.event === "outbox_message_published" && record.topic === "process-runs") {
    required.get(record.runId).add("published");
  } else if (record.event === "process_run_work_finished") {
    required.get(record.runId).add("worked");
  } else continue;
  output.push({
    event: record.event,
    timestamp: record.timestamp,
    runId: record.runId,
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.status ? { status: record.status } : {}),
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.topic ? { topic: record.topic } : {})
  });
}
for (const [runId, seen] of required) {
  for (const name of ["accepted", "observed", "published", "worked"]) {
    if (!seen.has(name)) throw new Error(`Missing ${name} correlated log for ${runId}`);
  }
}
process.stdout.write(JSON.stringify(output));
' \
    "$success_run_id" \
    "$failure_run_id" \
    "$success_submit_request_id" \
    "$failure_submit_request_id" \
    "$success_observe_request_id" \
    "$failure_observe_request_id" < "$logs" > "$correlated"

docker run --rm -i \
    --volume "$operations:/evidence/operations.json:ro" \
    --volume "$audit:/evidence/audit.json:ro" \
    --volume "$correlated:/evidence/correlated.json:ro" \
    --volume "$roles:/evidence/roles.json:ro" \
    --entrypoint node "$image" -e '
const fs = require("node:fs");
const read = (name) => JSON.parse(fs.readFileSync(`/evidence/${name}.json`, "utf8"));
const [revision, phase] = process.argv.slice(1);
const operations = read("operations");
const state = read("audit");
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const queueFields = ["waiting", "active", "delayed", "prioritized", "failed", "completed", "waitingChildren", "oldestRunnableAgeMs"];
if (
  operations.event !== "async_operations_snapshot" ||
  operations.schemaVersion !== 1 ||
  !operations.persistence ||
  !operations.persistence.runs ||
  !operations.persistence.outbox ||
  !nonnegative(operations.persistence.runs.queued) ||
  !nonnegative(operations.persistence.runs.running) ||
  !nonnegative(operations.persistence.outbox.processPending) ||
  !nonnegative(operations.persistence.outbox.webhookPending) ||
  !operations.queues ||
  !operations.queues.process ||
  !operations.queues.webhook ||
  !queueFields.every((field) => nonnegative(operations.queues.process[field])) ||
  !queueFields.every((field) => nonnegative(operations.queues.webhook[field]))
) process.exit(1);
if (state.event !== "async_smoke_state_audited" || state.runs.count !== 2 || state.runs.terminalCount !== 2 || state.runs.ownersPresent !== true || state.runs.idempotencyPresent !== true || state.runs.deliveriesPresent !== true || state.deliveryCount < 2 || state.deliveryRunCount !== 2 || state.additiveSchemaPresent !== true) process.exit(1);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  event: "async_internal_operational_evidence_collected",
  revision,
  phase,
  measuredAt: new Date().toISOString(),
  roles: read("roles"),
  state,
  operations,
  correlatedLogs: read("correlated")
}));
' "$revision" "$phase"
printf '\n'
