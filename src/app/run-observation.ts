import { Pool } from "pg";
import {
    type CompletedProcessRun,
    createProcessRunRecords,
    type ProcessRunRecords,
} from "../process-runtime/records.js";
import {
    createJsonlProcessRunActivityArchive,
    type ProcessRunActivityArchive,
    pruneProcessRunActivities,
} from "../run-observation/activities.js";
import {
    createPostgresProcessRunActivityArchive,
    createPostgresProcessRunRecordArchive,
    createPostgresRunObservationStats,
    pruneProcessRunObservation,
} from "../run-observation/postgres.js";
import {
    createJsonlProcessRunRecordArchive,
    defaultProcessRunRecordRetentionDays,
    type ProcessRunRecordArchive,
    parseProcessRunRecordContent,
    pruneProcessRunRecords,
} from "../run-observation/records.js";
import {
    createJsonlRunObservationStats,
    type RunObservationStats,
} from "../run-observation/stats.js";
import { parsePositiveInteger, type StartupEnvironment } from "./config.js";

export type ConstructedProcessRunObservation = Readonly<{
    records: ProcessRunRecords;
    archive: ProcessRunRecordArchive;
    activities: ProcessRunActivityArchive;
    stats: RunObservationStats;
    close?: () => Promise<void>;
}>;

/**
 * Builds the shared Run observation Module used by synchronous API execution
 * and asynchronous Workers. It is optional for execution, but mandatory when
 * the Console is enabled.
 */
export function constructProcessRunObservation(
    environment: StartupEnvironment,
): ConstructedProcessRunObservation | undefined {
    const store = parseRecordStore(environment.PROCESS_RUN_RECORD_STORE);
    const retentionDays = parsePositiveInteger(
        environment.PROCESS_RUN_RECORD_RETENTION_DAYS,
        defaultProcessRunRecordRetentionDays,
        "PROCESS_RUN_RECORD_RETENTION_DAYS",
    );
    const content = parseProcessRunRecordContent(
        environment.PROCESS_RUN_RECORD_CONTENT,
    );
    const writeTimeoutMs = parsePositiveInteger(
        environment.PROCESS_RUN_OBSERVATION_TIMEOUT_MS,
        2_000,
        "PROCESS_RUN_OBSERVATION_TIMEOUT_MS",
    );

    const built =
        store === "postgres"
            ? buildPostgresObservation(
                  environment,
                  retentionDays,
                  writeTimeoutMs,
              )
            : buildFileObservation(environment, retentionDays);
    if (!built) return undefined;

    const records = createProcessRunRecords({
        adapter: built.archive,
        content,
    });
    return Object.freeze({
        ...built,
        records: Object.freeze({
            record: async (completion: CompletedProcessRun) => {
                // Publishing the terminal observation after earlier activity
                // writes gives readers a useful consistency boundary: once a
                // Run Record is visible, its Attempt timeline is visible too.
                await built.activities.flush();
                await records.record(completion);
            },
            find: records.find,
        }),
    });
}

function buildFileObservation(
    environment: StartupEnvironment,
    retentionDays: number,
): Omit<ConstructedProcessRunObservation, "records"> | undefined {
    const directory = environment.PROCESS_RUN_RECORD_DIRECTORY?.trim();
    if (!directory) return undefined;

    void pruneProcessRunRecords({ directory, retentionDays }).catch(() => {});
    void pruneProcessRunActivities({ directory, retentionDays }).catch(
        () => {},
    );
    return {
        archive: createJsonlProcessRunRecordArchive({
            directory,
            retentionDays,
        }),
        activities: createJsonlProcessRunActivityArchive({
            directory,
            retentionDays,
        }),
        stats: createJsonlRunObservationStats({ directory, retentionDays }),
    };
}

function buildPostgresObservation(
    environment: StartupEnvironment,
    retentionDays: number,
    writeTimeoutMs: number,
): Omit<ConstructedProcessRunObservation, "records"> {
    const pool = new Pool({
        connectionString: parseObservationDatabaseUrl(environment.DATABASE_URL),
        max: parsePositiveInteger(
            environment.PROCESS_RUN_RECORD_POOL_MAX,
            4,
            "PROCESS_RUN_RECORD_POOL_MAX",
        ),
        connectionTimeoutMillis: parsePositiveInteger(
            environment.ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS,
            5_000,
            "ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS",
        ),
        query_timeout: writeTimeoutMs,
        statement_timeout: writeTimeoutMs,
        application_name: "pipipi-run-observation",
    });
    pool.on("error", () => {
        console.error(
            JSON.stringify({
                event: "postgres_pool_error",
                role: "pipipi-run-observation",
                timestamp: new Date().toISOString(),
            }),
        );
    });
    void pruneProcessRunObservation({ pool, retentionDays }).catch(() => {});
    return {
        archive: createPostgresProcessRunRecordArchive({ pool }),
        activities: createPostgresProcessRunActivityArchive({ pool }),
        stats: createPostgresRunObservationStats({ pool }),
        close: () => pool.end(),
    };
}

function parseRecordStore(value: string | undefined): "file" | "postgres" {
    if (value === undefined || value === "file") return "file";
    if (value === "postgres") return "postgres";
    throw new Error("PROCESS_RUN_RECORD_STORE must be file or postgres");
}

function parseObservationDatabaseUrl(value: string | undefined): string {
    const candidate = value?.trim();
    if (!candidate) {
        throw new Error(
            "DATABASE_URL is required when PROCESS_RUN_RECORD_STORE=postgres",
        );
    }
    try {
        const url = new URL(candidate);
        if (
            (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
            url.hostname.length === 0 ||
            url.pathname.length <= 1
        ) {
            throw new Error();
        }
    } catch {
        throw new Error(
            "DATABASE_URL must be a valid PostgreSQL connection URL",
        );
    }
    return candidate;
}
