import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 自动备份在 postgres 容器内执行的那段脚本：取出原文，用桩 psql/pg_dump 真跑。
// 11-17 首次自动迁移发布失败于此：生产 URL 的 sslrootcert 是百分号编码的。
let dir = "";
let script = "";
const calls = () => path.join(dir, "calls.log");

async function run(url: string, mode: "size" | "dump", stub = "") {
    await writeFile(
        path.join(dir, "psql"),
        `#!/bin/sh\nprintf '%s\\n' "$1" >> "${calls()}"\n${stub}\necho 4242\n`,
    );
    await writeFile(
        path.join(dir, "pg_dump"),
        `#!/bin/sh\nprintf '%s\\n' "$1" >> "${calls()}"\n${stub}\nprintf DUMP\n`,
    );
    await chmod(path.join(dir, "psql"), 0o755);
    await chmod(path.join(dir, "pg_dump"), 0o755);
    await rm(calls(), { force: true });
    const result = spawnSync("sh", ["-c", script, "sh", mode], {
        encoding: "utf8",
        env: { PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: url },
    });
    const called = await readFile(calls(), "utf8").catch(() => "");
    return { ...result, called };
}

const base = "postgres://u:secret-password@db.internal:5432/app";

describe("自动备份的容器内连接脚本", () => {
    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "pg-client-"));
        const source = await readFile("ops/update-async-release.sh", "utf8");
        const match = source.match(
            /# BEGIN pg container\n([\s\S]*?)# END pg container/,
        );
        if (!match) throw new Error("容器脚本标记缺失");
        script = match[1];
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it.each([
        [
            "百分号编码",
            "?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=%2Fetc%2Fpipipi%2Fpg-server.crt",
        ],
        [
            "小写编码",
            "?sslmode=verify-ca&sslrootcert=%2fetc%2fpipipi%2fpg-server.crt&uselibpqcompat=true",
        ],
        [
            "明文",
            "?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=/etc/pipipi/pg-server.crt",
        ],
    ])("接受 %s 的固定 CA，并剔除 node-pg 专用参数", async (_, query) => {
        const result = await run(base + query, "size");
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe("4242");
        expect(result.called).not.toContain("uselibpqcompat");
        expect(result.called).toContain("sslmode=verify-ca");
        expect(result.called.trim()).not.toMatch(/[?&]$/);
    });

    it("dump 原样输出备份内容", async () => {
        const result = await run(
            `${base}?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=%2Fetc%2Fpipipi%2Fpg-server.crt`,
            "dump",
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("DUMP");
    });

    it.each([
        [
            "?sslmode=require&sslrootcert=/etc/pipipi/pg-server.crt",
            "URL_NOT_VERIFY_CA",
        ],
        ["?sslmode=verify-ca&sslrootcert=/tmp/other.crt", "URL_NOT_FIXED_CA"],
    ])("URL 不合规时不连接并给出类别 (%s)", async (query, code) => {
        const result = await run(base + query, "size");
        expect(result.status).not.toBe(0);
        expect(result.stderr.trim()).toBe(`PG_ERROR=${code}`);
        expect(result.called).toBe("");
    });

    it.each([
        [
            'psql: error: connection to server at "db.internal" (10.0.0.1), port 5432 failed: SSL error: certificate verify failed',
            "TLS_FAILED",
        ],
        [
            'psql: error: connection to server at "db.internal" failed: FATAL:  password authentication failed for user "u"',
            "AUTH_FAILED",
        ],
        [
            'psql: error: could not translate host name "db.internal" to address',
            "NETWORK_FAILED",
        ],
        [
            "pg_dump: error: aborting because of server version mismatch",
            "VERSION_MISMATCH",
        ],
    ])("libpq 报错只输出类别，不回显原文 (%s)", async (message, code) => {
        const result = await run(
            `${base}?sslmode=verify-ca&sslrootcert=/etc/pipipi/pg-server.crt`,
            "size",
            `echo '${message}' >&2; exit 2`,
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr.trim()).toBe(`PG_ERROR=${code}`);
        expect(result.stderr).not.toContain("db.internal");
    });
});
