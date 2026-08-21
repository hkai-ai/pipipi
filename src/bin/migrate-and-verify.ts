import path from "node:path";
import { runner } from "node-pg-migrate";
import { applyMigrationsAndVerify } from "../release/migration-verification.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const result = await applyMigrationsAndVerify(() =>
    runner({
        databaseUrl,
        direction: "up",
        dir: path.resolve("migrations"),
        migrationsTable: "pgmigrations",
        count: Infinity,
        advisoryLockMode: "wait",
        log: () => {},
    }),
);

console.log(
    JSON.stringify({
        event: "database_migration_verified",
        ...result,
    }),
);
