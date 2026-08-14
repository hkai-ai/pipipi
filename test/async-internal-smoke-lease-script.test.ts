import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REVISION = "e".repeat(40);

describe("Async internal smoke lease script", () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            directories
                .splice(0)
                .map((directory) =>
                    rm(directory, { recursive: true, force: true }),
                ),
        );
    });

    it("acquires and releases only its own revision-bound lease", async () => {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-smoke-lease-"),
        );
        directories.push(directory);
        const appRoot = path.join(directory, "app");
        const binaries = path.join(directory, "bin");
        await Promise.all([
            mkdir(path.join(appRoot, "shared"), { recursive: true }),
            mkdir(binaries),
        ]);
        await Promise.all([
            executable(path.join(binaries, "docker"), fakeDocker),
            executable(path.join(binaries, "flock"), "#!/bin/sh\nexit 0\n"),
            executable(path.join(binaries, "nohup"), "#!/bin/sh\nexit 0\n"),
        ]);

        const acquired = run(appRoot, binaries, "acquired", "smoke-one");
        expect(acquired.status, acquired.stderr).toBe(0);
        const lease = path.join(
            appRoot,
            "shared",
            "async-control",
            "smoke-lease",
        );
        expect(await readFile(lease, "utf8")).toBe(`${REVISION}:smoke-one\n`);

        const foreignRelease = run(appRoot, binaries, "released", "smoke-two");
        expect(foreignRelease.status).not.toBe(0);
        expect(await readFile(lease, "utf8")).toBe(`${REVISION}:smoke-one\n`);

        const released = run(appRoot, binaries, "released", "smoke-one");
        expect(released.status, released.stderr).toBe(0);
        await expect(readFile(lease, "utf8")).rejects.toThrow();
    });
});

function run(
    appRoot: string,
    binaries: string,
    state: "acquired" | "released",
    controlId: string,
) {
    return spawnSync(
        "bash",
        [
            "ops/set-async-internal-smoke-lease.sh",
            appRoot,
            REVISION,
            state,
            "1500",
            controlId,
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${binaries}:${process.env.PATH}`,
                FAKE_REVISION: REVISION,
            },
        },
    );
}

async function executable(file: string, source: string): Promise<void> {
    await writeFile(file, source);
    await chmod(file, 0o755);
}

const fakeDocker = String.raw`#!/usr/bin/env bash
set -eu
if [ "$1" != "inspect" ]; then exit 2; fi
if [[ " $* " == *"range .Config.Env"* ]]; then
    printf '%s\n' 'ASYNC_RELEASE_STAGE=internal' 'ASYNC_PROCESS_RUNS_ENABLED=true'
else
    printf '%s\n' "$FAKE_REVISION"
fi
`;
