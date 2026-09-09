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
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const previous = "a".repeat(40);
const candidate = "b".repeat(40);
// Windows 上启动多次 Git Bash 较慢，Linux CI 保持较短的超时。
const timeout = process.platform === "win32" ? 60000 : 30000;
const shellPath = (value: string) =>
    value
        .replaceAll("\\", "/")
        .replace(
            /^([A-Za-z]):/,
            (_, drive: string) => `/${drive.toLowerCase()}`,
        );

describe("生产日常更新", { timeout }, () => {
    it.each(["internal", "canary", "production"])(
        "通过真实 Activate release 更新已有 %s 异步部署",
        async (stage) => {
            const result = await run({ stage });
            expect(result.status, result.stderr).toBe(0);
            expect(result.state).toBe(candidate);
            expect(result.log).toContain(`stage=${stage}`);
            expect(result.log).not.toMatch(
                /--remove-orphans|db:migrate|migrate-and-verify|recover.js/,
            );
        },
    );

    it.each([
        "precheck",
        "migration",
        "partial",
        "api_only",
        "queue",
        "lease",
        "drain",
    ])("%s 门禁失败不替换现有容器", async (failure) => {
        const result = await run({ failure });
        expect(result.status).not.toBe(0);
        expect(result.state).toBe(previous);
        expect(result.log).not.toContain(" up ");
    });

    it.each(["activate", "health", "signal"])(
        "%s 失败恢复全部角色与原 Compose",
        async (failure) => {
            const result = await run({ failure });
            expect(result.status).not.toBe(0);
            expect(result.state).toBe(previous);
            expect(result.log).toContain(`revision=${previous}`);
            expect(result.compose).toBe("old compose\n");
            expect(result.marker).toBe(false);
        },
    );

    it("回滚失败保留停流标记", async () => {
        const result = await run({ failure: "rollback" });
        expect(result.status).not.toBe(0);
        expect(result.marker).toBe(true);
        expect(result.stderr).toContain("rollback failed");
    });

    it("已有同步部署继续使用同步路径", async () => {
        const result = await run({ failure: "sync" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.state).toBe(candidate);
        expect(result.log).not.toContain("compose.production.async.yaml");
        expect(result.log).toContain("run db:migrate");
    });

    it("成功更新也保留人工已有的停流标记", async () => {
        const result = await run({ failure: "marker" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.marker).toBe(true);
    });
});

async function run(options: { stage?: string; failure?: string }) {
    const root = await mkdtemp(path.join(tmpdir(), "pipipi-update-"));
    const shared = path.join(root, "shared");
    const bin = path.join(root, "bin");
    try {
        await mkdir(path.join(shared, "async-control"), { recursive: true });
        await mkdir(bin);
        for (const name of [
            ".env",
            "async-api.env",
            "process-dispatcher.env",
            "process-worker.env",
            "webhook-worker.env",
            "retention-cleaner.env",
            "pg-server.crt",
            "compose.production.yaml",
            "compose.production.async.yaml",
        ]) {
            await writeFile(path.join(shared, name), "old compose\n");
        }
        if (options.failure === "lease")
            await writeFile(
                path.join(shared, "async-control/smoke-lease"),
                "busy",
            );
        if (options.failure === "marker")
            await writeFile(
                path.join(shared, "async-control/intake-disabled"),
                "manual",
            );
        const state = path.join(root, "state");
        const log = path.join(root, "log");
        await writeFile(state, previous);
        await writeFile(log, "");
        await writeFile(path.join(root, "image.gz"), gzipSync("image"));
        await writeFile(path.join(root, "compose.yaml"), "new compose\n");
        await writeFile(
            path.join(root, "compose.async.yaml"),
            "new async compose\n",
        );
        const workflow = (
            await readFile(".github/workflows/production-ci-cd.yml", "utf8")
        ).replaceAll("\r\n", "\n");
        const body = workflow
            .split("<<'REMOTE'\n")[1]
            ?.split("          REMOTE")[0];
        if (!body) throw new Error("缺少生产激活脚本");
        await writeFile(
            path.join(root, "activate.sh"),
            'export PATH="$TEST_BIN:$TEST_BASH_BIN:$PATH"\n' +
                body.replace(/^ {10}/gm, ""),
        );
        await writeFile(
            path.join(root, "update.sh"),
            'export PATH="$TEST_BIN:$TEST_BASH_BIN:$PATH"\n' +
                (
                    await readFile("ops/update-async-release.sh", "utf8")
                ).replaceAll("\r\n", "\n"),
        );
        for (const [name, source] of Object.entries({
            docker: fakeDocker,
            curl: '#!/usr/bin/env bash\nif [ "$TEST_FAILURE" = health ] && [ "$(cat "$TEST_STATE")" = "$TEST_CANDIDATE" ]; then exit 1; fi\nprintf \'%s\\n\' \'# Pipipi Business Process API\' \'# 业务接口文档\'\n',
            flock: "#!/usr/bin/env bash\nexit 0\n",
            install: `#!/usr/bin/env bash\nif [[ " $* " == *" -d "* ]]; then exit 0; fi\ncp "${"$"}{@: -2:1}" "${"$"}{@: -1}"\n`,
        })) {
            await writeFile(path.join(bin, name), source);
            await chmod(path.join(bin, name), 0o755);
        }
        const bash =
            process.platform === "win32"
                ? "C:/Program Files/Git/bin/bash.exe"
                : "bash";
        const result = spawnSync(
            bash,
            [
                shellPath(path.join(root, "activate.sh")),
                shellPath(root),
                candidate,
                shellPath(path.join(root, "image.gz")),
                shellPath(path.join(root, "compose.yaml")),
                shellPath(path.join(root, "update.sh")),
                shellPath(path.join(root, "compose.async.yaml")),
            ],
            {
                encoding: "utf8",
                timeout,
                env: {
                    ...process.env,
                    MSYS2_ENV_CONV_EXCL:
                        "TEST_BIN;TEST_BASH_BIN;TEST_STATE;TEST_LOG",
                    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                    TEST_BIN: shellPath(bin),
                    TEST_BASH_BIN:
                        process.platform === "win32"
                            ? "/c/Program Files/Git/bin"
                            : "/bin",
                    TEST_STATE: shellPath(state),
                    TEST_LOG: shellPath(log),
                    TEST_STAGE: options.stage ?? "internal",
                    TEST_FAILURE: options.failure ?? "",
                    TEST_PREVIOUS: previous,
                    TEST_CANDIDATE: candidate,
                },
            },
        );
        return {
            ...result,
            state: await readFile(state, "utf8"),
            log: await readFile(log, "utf8"),
            compose: await readFile(
                path.join(shared, "compose.production.yaml"),
                "utf8",
            ),
            marker: await readFile(
                path.join(shared, "async-control/intake-disabled"),
            ).then(
                () => true,
                () => false,
            ),
        };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const fakeDocker = String.raw`#!/usr/bin/env bash
set -eu
printf '%s stage=%s revision=%s\n' "$*" "${"$"}{PIPIPI_ASYNC_RELEASE_STAGE:-}" "${"$"}{PIPIPI_REVISION:-}" >> "$TEST_LOG"
state="$(cat "$TEST_STATE")"
case "$1" in
inspect)
    if [ "$TEST_FAILURE" = partial ] && [ "$2" = pipipi-process-worker ]; then exit 1; fi
    if [[ "$TEST_FAILURE" = sync || "$TEST_FAILURE" = api_only ]] && [[ "$2" == pipipi-process-* || "$2" == pipipi-webhook-worker || "$2" == pipipi-retention-cleaner ]]; then exit 1; fi
    case "$*" in
    *Config.Image*) echo "pipipi:$state";;
    *com.pipipi.revision*) echo "$state";;
    *range*.Config.Env*)
        if [ "$TEST_FAILURE" = sync ]; then echo "ASYNC_PROCESS_RUNS_ENABLED=false"; else echo "ASYNC_PROCESS_RUNS_ENABLED=true"; fi
        echo "ASYNC_RELEASE_STAGE=$TEST_STAGE"
        echo 'ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE=/var/lib/pipipi-async-control/intake-disabled'
        echo 'PROCESS_QUEUE_NAME=process-runs'
        if [ "$TEST_FAILURE" = queue ] && [ "$2" = pipipi-process-worker ]; then echo 'PROCESS_QUEUE_PREFIX=wrong'; else echo 'PROCESS_QUEUE_PREFIX=existing'; fi
        echo 'WEBHOOK_QUEUE_NAME=webhooks'
        echo 'WEBHOOK_QUEUE_PREFIX=existing';;
    *State.Running*) echo true;;
    *.Image*) echo "sha256:$state";;
    esac;;
image) echo "sha256:$TEST_CANDIDATE";;
load) cat >/dev/null;;
run)
    if [[ "$*" == *check-deployment-environment* ]] && [ "$TEST_FAILURE" = precheck ]; then exit 1; fi
    if [[ "$*" == *readdirSync* ]]; then
        if [ "$TEST_FAILURE" = migration ] && [[ "$*" == *"pipipi:$TEST_CANDIDATE"* ]]; then printf '%064d\n' 1; else printf '%064d\n' 0; fi
    fi;;
exec) if [ "$TEST_FAILURE" = drain ]; then exit 1; fi; echo 0;;
compose)
    if [[ "$*" == *check-deployment-environment* ]] && [ "$TEST_FAILURE" = precheck ]; then exit 1; fi
    if [[ " $* " == *" up "* ]]; then
        printf '%s' "$PIPIPI_REVISION" > "$TEST_STATE"
        if [ "$TEST_FAILURE" = signal ] && [ "$PIPIPI_REVISION" = "$TEST_CANDIDATE" ]; then kill -TERM "$PPID"; fi
        if [ "$TEST_FAILURE" = rollback ]; then exit 1; fi
        if [ "$TEST_FAILURE" = activate ] && [ "$PIPIPI_REVISION" = "$TEST_CANDIDATE" ]; then exit 1; fi
    fi;;
esac
`;
