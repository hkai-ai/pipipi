/** 连接数据库审计异步冒烟测试状态，支持等待投递覆盖完成 */
import { Pool } from "pg";
import { parseConnectionUrl } from "../app/config.js";
import {
    auditAsyncSmokeState,
    waitForAsyncSmokeDeliveryCoverage,
} from "../release/async-smoke-state.js";

const arguments_ = process.argv.slice(2);
const waitForDeliveries = arguments_[0] === "--wait-for-deliveries";
const runIds = waitForDeliveries ? arguments_.slice(1) : arguments_;
const pool = new Pool({
    connectionString: parseConnectionUrl(process.env.DATABASE_URL, {
        protocols: ["postgres:", "postgresql:"],
        missingMessage: "DATABASE_URL is required for the async smoke audit",
        invalidMessage: "DATABASE_URL must be a valid PostgreSQL URL",
        requirePath: true,
    }),
    max: 1,
    application_name: "pipipi-async-smoke-audit",
});

try {
    const read = () => auditAsyncSmokeState({ database: pool, runIds });
    console.log(
        JSON.stringify(
            waitForDeliveries
                ? await waitForAsyncSmokeDeliveryCoverage({ read })
                : await read(),
        ),
    );
} finally {
    await pool.end();
}
