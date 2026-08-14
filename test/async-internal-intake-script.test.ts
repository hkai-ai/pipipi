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

const REVISION = "d".repeat(40);
const realFlockAvailable =
    spawnSync("sh", ["-c", "command -v flock"], {
        encoding: "utf8",
    }).status === 0;

describe("Async internal intake control script", () => {
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

    it("closes and reopens only the intake marker for the active internal revision", async () => {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-intake-script-"),
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
            executable(path.join(binaries, "curl"), fakeCurl),
            executable(path.join(binaries, "flock"), "#!/bin/sh\nexit 0\n"),
            executable(path.join(binaries, "nohup"), "#!/bin/sh\nexit 0\n"),
        ]);

        const closed = run(appRoot, binaries, "closed");
        expect(closed.status, closed.stderr).toBe(0);
        expect(JSON.parse(closed.stdout)).toMatchObject({
            event: "async_internal_intake_changed",
            revision: REVISION,
            state: "closed",
        });
        const marker = path.join(
            appRoot,
            "shared",
            "async-control",
            "intake-disabled",
        );
        expect(await readFile(marker, "utf8")).toBe(
            `${REVISION}:test-control\n`,
        );

        const opened = run(appRoot, binaries, "open");
        expect(opened.status, opened.stderr).toBe(0);
        await expect(readFile(marker, "utf8")).rejects.toThrow();
    });

    it("does not overwrite or reopen intake owned by another operation", async () => {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-intake-script-owner-"),
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
            executable(path.join(binaries, "curl"), fakeCurl),
            executable(path.join(binaries, "flock"), "#!/bin/sh\nexit 0\n"),
            executable(path.join(binaries, "nohup"), "#!/bin/sh\nexit 0\n"),
        ]);

        expect(run(appRoot, binaries, "closed").status).toBe(0);
        const foreignOpen = run(appRoot, binaries, "open", "other-control");
        expect(foreignOpen.status).not.toBe(0);
        const marker = path.join(
            appRoot,
            "shared",
            "async-control",
            "intake-disabled",
        );
        expect(await readFile(marker, "utf8")).toBe(
            `${REVISION}:test-control\n`,
        );
    });

    it.skipIf(!realFlockAvailable)(
        "releases the real Linux deployment lock while auto-restore sleeps",
        async () => {
            const directory = await mkdtemp(
                path.join(tmpdir(), "pipipi-intake-script-lock-"),
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
                executable(path.join(binaries, "curl"), fakeCurl),
            ]);

            const closed = run(appRoot, binaries, "closed", "lock-test", "3");
            expect(closed.status, closed.stderr).toBe(0);
            const opened = run(appRoot, binaries, "open", "lock-test", "3");
            expect(opened.status, opened.stderr).toBe(0);
        },
    );
});

function run(
    appRoot: string,
    binaries: string,
    state: "closed" | "open",
    controlId = "test-control",
    autoRestoreSeconds = "600",
) {
    return spawnSync(
        "bash",
        [
            "ops/set-async-internal-intake.sh",
            appRoot,
            REVISION,
            state,
            autoRestoreSeconds,
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
if [ "$1" = "exec" ]; then
    printf '503'
elif [ "$1" != "inspect" ]; then
    exit 2
elif [[ " $* " == *"com.pipipi.revision"* ]]; then
    printf '%s\n' "$FAKE_REVISION"
elif [[ " $* " == *"range .Config.Env"* ]]; then
    printf '%s\n' \
        'ASYNC_RELEASE_STAGE=internal' \
        'ASYNC_PROCESS_RUNS_ENABLED=true' \
        'ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE=/var/lib/pipipi-async-control/intake-disabled'
fi
`;

const fakeCurl = "#!/usr/bin/env bash\nset -eu\n";
