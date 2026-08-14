import { Pool } from "pg";
import { auditProductionDatabase } from "../app/production-database-audit.js";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

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
