import { Pool } from "pg";
import {
    auditProductionDatabase,
    parseProductionDatabaseAuditConnection,
} from "../app/production-database-audit.js";

const connectionString = parseProductionDatabaseAuditConnection(
    process.env.DATABASE_URL,
);

const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    application_name: "pipipi-production-database-audit",
});

try {
    const evidence = await auditProductionDatabase(pool);
    console.log(JSON.stringify(evidence));
} finally {
    await pool.end();
}
