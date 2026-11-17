/** 通过生产数据库运行调用方密钥管理命令，错误输出不回显参数或连接凭证。 */

import { parseConnectionUrl } from "../app/config.js";
import { createRuntimePool } from "../app/postgres-pool.js";
import { runCallerApiKeys } from "../caller-api-keys/cli.js";
import { createPostgresCallerApiKeyStore } from "../caller-api-keys/postgres.js";

try {
    const connectionString = parseConnectionUrl(process.env.DATABASE_URL, {
        protocols: ["postgres:", "postgresql:"],
        requirePath: true,
        missingMessage: "DATABASE_URL is required",
        invalidMessage: "DATABASE_URL must be a PostgreSQL connection URL",
    });
    const pool = createRuntimePool({
        environment: process.env,
        connectionString,
        applicationName: "pipipi-caller-api-keys",
    });
    try {
        console.log(
            JSON.stringify(
                await runCallerApiKeys(
                    process.argv.slice(2),
                    createPostgresCallerApiKeyStore({ pool }),
                ),
            ),
        );
    } finally {
        await pool.end();
    }
} catch {
    console.error(
        "Caller API Key command failed. Check database access and command options: issue --caller-id ID --label LABEL [--expires-at ISO] [--actor ID]; list [--caller-id ID]; revoke --key-id ID [--actor ID].",
    );
    process.exitCode = 1;
}
