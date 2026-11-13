/** 只读投影数据库中指定异步运行的实际排队和执行状态。 */
import type { Pool } from "pg";
import type { ProcessRunStatus } from "../store/index.js";

export type RunQueueState = Readonly<{
    status: ProcessRunStatus;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
}>;

export function postgresQueueState(pool: Pool) {
    return async (runId: string): Promise<RunQueueState | undefined> => {
        // 同步与成员运行允许非 UUID，其活动仍然可查。
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId))
            return;
        const { rows } = await pool.query<{
            status: RunQueueState["status"];
            created_at: Date;
            started_at: Date | null;
            finished_at: Date | null;
        }>(
            `select status, created_at, started_at, finished_at from process_runs where run_id = $1`,
            [runId],
        );
        const row = rows[0];
        if (!row) return;
        return {
            status: row.status,
            createdAt: row.created_at.toISOString(),
            ...(row.started_at && {
                startedAt: row.started_at.toISOString(),
            }),
            ...(row.finished_at && {
                finishedAt: row.finished_at.toISOString(),
            }),
        };
    };
}
