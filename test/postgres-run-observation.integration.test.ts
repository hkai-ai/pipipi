import path from "node:path";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    createPostgresProcessRunActivityArchive,
    createPostgresProcessRunRecordArchive,
    createPostgresRunObservationStats,
    pruneProcessRunObservation,
} from "../src/app/postgres-run-observation.js";
import { auditProductionDatabase } from "../src/app/production-database-audit.js";
import {
    describeRunObservationContract,
    processRunActivity,
    processRunRecord,
} from "./support/run-observation-contract.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (process.env.RUN_POSTGRES_INTEGRATION === "1" && !databaseUrl) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL is required for PostgreSQL integration tests",
    );
}

const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;

postgresDescribe("PostgreSQL Run observation", () => {
    let pool: Pool;

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        pool = new Pool({ connectionString: databaseUrl, max: 4 });
        await migrate(databaseUrl as string);
    }, 30_000);

    beforeEach(async () => {
        await pool.query(
            "TRUNCATE process_run_activities, process_run_records",
        );
    });

    afterAll(async () => {
        await pool?.end();
    });

    describeRunObservationContract(async () => {
        const activities = createPostgresProcessRunActivityArchive({ pool });
        return {
            archive: createPostgresProcessRunRecordArchive({ pool }),
            activities,
            stats: createPostgresRunObservationStats({ pool }),
            settle: activities.flush,
        };
    });

    it("survives an independent adapter instance", async () => {
        await createPostgresProcessRunRecordArchive({ pool }).store(
            processRunRecord({ runId: "across-instances" }),
        );

        expect(
            await createPostgresProcessRunRecordArchive({ pool }).find(
                "across-instances",
            ),
        ).toMatchObject({ runId: "across-instances" });
    });

    it("deletes records and activities outside the retention window", async () => {
        const archive = createPostgresProcessRunRecordArchive({ pool });
        const activities = createPostgresProcessRunActivityArchive({ pool });
        const now = new Date("2026-08-11T10:00:00.000Z");

        for (const [runId, at] of [
            ["old", "2026-07-01T00:00:00.000Z"],
            ["recent", "2026-08-11T00:00:00.000Z"],
        ] as const) {
            await archive.store(processRunRecord({ runId, recordedAt: at }));
            activities.record(processRunActivity({ runId, timestamp: at }));
        }
        await activities.flush();

        await pruneProcessRunObservation({ pool, retentionDays: 7, now });

        expect(await archive.find("old")).toBeUndefined();
        expect(await archive.find("recent")).toBeDefined();
        expect(await activities.findByRun("old")).toEqual([]);
        expect(await activities.findByRun("recent")).toHaveLength(1);
    });

    it("rejects a record whose status and failure code disagree", async () => {
        await expect(
            pool.query(
                `insert into process_run_records
                   (run_id, recorded_at, status, error_code)
                 values ('bad', now(), 'succeeded', 'DEPENDENCY_FAILURE')`,
            ),
        ).rejects.toThrow(/process_run_records_error_code_check/);
    });

    it("executes the live identity audit and rejects the non-TLS test session", async () => {
        await expect(auditProductionDatabase(pool)).rejects.toThrow(
            "Production database session must use TLS",
        );
    });
});

async function migrate(url: string) {
    return runner({
        databaseUrl: url,
        direction: "up",
        dir: path.resolve("migrations"),
        migrationsTable: "pgmigrations",
        count: Number.POSITIVE_INFINITY,
        advisoryLockMode: "wait",
        log: () => {},
    });
}

function assertTestDatabase(url: string): void {
    const databaseName = new URL(url).pathname.slice(1);
    if (!databaseName.endsWith("_test")) {
        throw new Error(
            "PostgreSQL integration tests require a database name ending in _test",
        );
    }
}
