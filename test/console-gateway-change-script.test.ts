import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const DOMAIN = "pi.ganjiuwanshi.com";
const REVISION = "712b25fef1e48ad08145e6027680ee3a5766f69c";
const ORIGINAL_CONFIG = `server {\n    server_name ${DOMAIN};\n    location / { proxy_pass http://fixture; }\n}\n`;

describe("Console gateway authentication change", () => {
    const directories: string[] = [];

    afterEach(async () => {
        const { rm } = await import("node:fs/promises");
        await Promise.all(
            directories
                .splice(0)
                .map((directory) =>
                    rm(directory, { recursive: true, force: true }),
                ),
        );
    });

    it("protects only the Console URI and emits redacted evidence", async () => {
        const fixture = await createFixture();

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        const config = await readFile(fixture.config, "utf8");
        expect(config).toContain("set $pipipi_console_realm off;");
        expect(config).toContain("if ($uri ~ ^/console(?:/|$)) {");
        expect(config).toContain("auth_basic $pipipi_console_realm;");
        expect(config).toContain(
            "auth_basic_user_file /etc/nginx/conf.d/.pipipi-console.htpasswd;",
        );
        expect(config).toContain("location / { proxy_pass http://fixture; }");
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "console_gateway_auth_changed",
            status: "succeeded",
            revision: REVISION,
            anonymousStatus: [401, 401, 401],
            authenticatedStatus: [200, 200, 200],
            rollbackStatus: "not_required",
        });
        expect(result.stdout).not.toContain("fixture-password");
        expect(await readFile(fixture.dockerLog, "utf8")).toContain(
            "exec openresty openresty -t",
        );
        expect(await readFile(fixture.dockerLog, "utf8")).toContain(
            "chmod 640 /etc/nginx/conf.d/.pipipi-console-auth.",
        );
    });

    it("rolls back when an upstream 403 has no Basic challenge", async () => {
        const fixture = await createFixture({
            anonymousChallenge: false,
            anonymousStatus: 403,
        });
        const original = await readFile(fixture.config, "utf8");

        const result = runChange(fixture);

        expect(
            result.status,
            JSON.stringify({ stdout: result.stdout, stderr: result.stderr }),
        ).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "console_gateway_auth_change_failed",
            status: "failed",
            failureStage: "anonymous_probe",
            rollbackStatus: "succeeded",
        });
        expect(await readFile(fixture.config, "utf8")).toBe(original);
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        const { access } = await import("node:fs/promises");
        await expect(access(authFile)).rejects.toThrow();
        const dockerLog = await readFile(fixture.dockerLog, "utf8");
        expect(dockerLog.match(/openresty -s reload/g)).toHaveLength(2);
    });

    it("reports a failed rollback without exposing credentials", async () => {
        const fixture = await createFixture({
            anonymousStatus: 200,
            failRollback: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "console_gateway_auth_change_failed",
            failureStage: "anonymous_probe",
            rollbackStatus: "failed",
        });
        expect(result.stdout).not.toContain("fixture-password");
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        expect(await readFile(authFile, "utf8")).toContain("operator:$apr1$");
    });

    it("restores an existing root-managed credential file", async () => {
        const fixture = await createFixture({
            anonymousStatus: 200,
            existingAuth: true,
        });
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        const original = await readFile(authFile, "utf8");

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            rollbackStatus: "succeeded",
        });
        expect(await readFile(authFile, "utf8")).toBe(original);
    });

    it("refuses a config changed while evidence is collected", async () => {
        const fixture = await createFixture({ changeDuringCollector: true });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "console_gateway_auth_change_failed",
            failureStage: "precondition",
            rollbackStatus: "not_required",
        });
        expect(await readFile(fixture.dockerLog, "utf8")).toBe("");
    });

    it("fails closed without replacing a dangling credential symlink", async () => {
        const fixture = await createFixture({ danglingAuth: true });
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "precondition",
            rollbackStatus: "not_required",
        });
        expect(await readlink(authFile)).toBe("missing-credential");
    });

    it("does not expose a partially prepared credential", async () => {
        const fixture = await createFixture({
            failCredentialPreparation: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "credential_installation",
            rollbackStatus: "not_required",
        });
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        const { access } = await import("node:fs/promises");
        await expect(access(authFile)).rejects.toThrow();
    });

    it("preserves a 1Panel change made before activation", async () => {
        const fixture = await createFixture({ changeBeforeActivation: true });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "credential_installation",
            rollbackStatus: "not_required",
        });
        expect(await readFile(fixture.config, "utf8")).toContain(
            "external-change.example.com",
        );
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        const { access } = await import("node:fs/promises");
        await expect(access(authFile)).rejects.toThrow();
    });

    it("fails if 1Panel changes the config during public probes", async () => {
        const fixture = await createFixture({ changeDuringProbe: true });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "configuration_consistency",
            rollbackStatus: "failed",
        });
        expect(await readFile(fixture.config, "utf8")).toContain(
            "probe-change.example.com",
        );
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        expect(await readFile(authFile, "utf8")).toContain("operator:$apr1$");
    });

    it("reloads an externally restored original config before removing credentials", async () => {
        const fixture = await createFixture({
            restoreOriginalDuringProbe: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "configuration_consistency",
            rollbackStatus: "succeeded",
        });
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        const { access } = await import("node:fs/promises");
        await expect(access(authFile)).rejects.toThrow();
        expect(
            (await readFile(fixture.dockerLog, "utf8")).match(
                /openresty -s reload/g,
            ),
        ).toHaveLength(2);
    });

    it("retains the new credential when config restoration fails", async () => {
        const fixture = await createFixture({
            anonymousStatus: 200,
            failConfigRestore: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            rollbackStatus: "failed",
        });
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        expect(await readFile(authFile, "utf8")).toContain("operator:$apr1$");
        expect(await readFile(fixture.config, "utf8")).toContain(
            "auth_basic $pipipi_console_realm;",
        );
    });

    it("fails if the credential drifts during public probes", async () => {
        const fixture = await createFixture({
            changeCredentialDuringProbe: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "credential_consistency",
            rollbackStatus: "failed",
        });
        expect(await readFile(fixture.config, "utf8")).not.toContain(
            "auth_basic $pipipi_console_realm;",
        );
        const authFile = path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        );
        expect(await readFile(authFile, "utf8")).toBe("external-credential\n");
    });

    it("rolls back when SSH hangup interrupts an in-flight probe", async () => {
        const fixture = await createFixture({ probeDelay: true });
        const original = await readFile(fixture.config, "utf8");
        const child = spawn("bash", changeArgs(fixture), {
            cwd: process.cwd(),
            env: changeEnv(fixture),
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        await waitForFile(fixture.probeMarker);
        child.kill("SIGHUP");
        const status = await new Promise<number | null>((resolve) => {
            child.on("close", resolve);
        });

        expect(status).not.toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({
            event: "console_gateway_auth_change_failed",
            rollbackStatus: "succeeded",
        });
        expect(await readFile(fixture.config, "utf8")).toBe(original);
    });

    it.each([
        ["install", "not_required"],
        ["auth-mv", "succeeded"],
        ["config-mv", "succeeded"],
    ] as const)(
        "rolls back when SSH hangup interrupts %s",
        async (signalStage, rollbackStatus) => {
            const fixture = await createFixture({ signalStage });
            const original = await readFile(fixture.config, "utf8");
            const child = spawn("bash", changeArgs(fixture), {
                cwd: process.cwd(),
                env: changeEnv(fixture),
            });
            let stdout = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                stdout += chunk;
            });
            await waitForFile(fixture.signalMarker);
            child.kill("SIGHUP");
            const status = await new Promise<number | null>((resolve) => {
                child.on("close", resolve);
            });

            expect(status).not.toBe(0);
            expect(JSON.parse(stdout)).toMatchObject({
                event: "console_gateway_auth_change_failed",
                rollbackStatus,
            });
            expect(await readFile(fixture.config, "utf8")).toBe(original);
            const authFile = path.join(
                path.dirname(fixture.config),
                ".pipipi-console.htpasswd",
            );
            const { access } = await import("node:fs/promises");
            await expect(access(authFile)).rejects.toThrow();
        },
    );

    async function createFixture(
        options: {
            anonymousChallenge?: boolean;
            anonymousStatus?: number;
            changeDuringCollector?: boolean;
            changeBeforeActivation?: boolean;
            changeDuringProbe?: boolean;
            changeCredentialDuringProbe?: boolean;
            danglingAuth?: boolean;
            failRollback?: boolean;
            failCredentialPreparation?: boolean;
            failConfigRestore?: boolean;
            existingAuth?: boolean;
            probeDelay?: boolean;
            restoreOriginalDuringProbe?: boolean;
            signalStage?: "install" | "auth-mv" | "config-mv";
        } = {},
    ): Promise<Fixture> {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-gateway-change-"),
        );
        directories.push(directory);
        const binaries = path.join(directory, "bin");
        const configDirectory = path.join(directory, "conf.d");
        await Promise.all([mkdir(binaries), mkdir(configDirectory)]);
        const config = path.join(configDirectory, `${DOMAIN}.conf`);
        await writeFile(config, ORIGINAL_CONFIG);
        const configSha256 = createHash("sha256")
            .update(await readFile(config))
            .digest("hex");
        if (options.existingAuth === true) {
            await writeFile(
                path.join(configDirectory, ".pipipi-console.htpasswd"),
                "previous:$apr1$old$previoushash\n",
            );
        }
        if (options.danglingAuth === true) {
            await symlink(
                "missing-credential",
                path.join(configDirectory, ".pipipi-console.htpasswd"),
            );
        }
        const htpasswd = path.join(directory, "htpasswd");
        const authorization = path.join(directory, "authorization");
        const collector = path.join(directory, "collector");
        const dockerLog = path.join(directory, "docker.log");
        const probeMarker = path.join(directory, "probe-started");
        const signalMarker = path.join(directory, "signal-stage-started");
        await writeFile(dockerLog, "");
        await Promise.all([
            writeFile(htpasswd, "operator:$apr1$salt$fixturehash\n"),
            writeFile(
                authorization,
                `Basic ${Buffer.from("operator:fixture-password").toString("base64")}\n`,
            ),
            writeExecutable(
                collector,
                `#!/usr/bin/env bash
jq -n --arg path "$FAKE_CONFIG_PATH" --arg sha256 "$FAKE_CONFIG_SHA256" '{
  status: "discovered",
  matchingServerBlockCount: 1,
  config: {path: $path, sha256: $sha256, authBasicDirectiveCount: 0, authRequestDirectiveCount: 0},
  reloadAdapter: {kind: "docker_container", containerNames: ["openresty"], configPath: "/etc/nginx/conf.d/site.conf"}
}'
if [ "$FAKE_CHANGE_DURING_COLLECTOR" = true ]; then
  printf '%s\n' 'server { server_name changed.example.com; }' > "$FAKE_CONFIG_PATH"
fi
`,
            ),
            writeExecutable(
                path.join(binaries, "docker"),
                `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "\${3:-}" = "sh" ]; then printf '%s\n' 'www-data'; exit 0; fi
if [ "\${3:-}" = "id" ]; then printf '%s\n' '101'; exit 0; fi
if [ "\${3:-}" = "stat" ]; then
  if [ "$FAKE_CHANGE_BEFORE_ACTIVATION" = true ]; then
    printf '%s\n' 'server { server_name external-change.example.com; }' > "$FAKE_CONFIG_PATH"
  fi
  printf '%s\n' '640:101'
  exit 0
fi
if [ "$FAKE_FAIL_ROLLBACK" = true ] && [[ "$*" == *"openresty -s reload"* ]]; then
  reloads="$(grep -c 'openresty -s reload' "$FAKE_DOCKER_LOG")"
  if [ "$reloads" -ge 2 ]; then exit 13; fi
fi
exit 0
`,
            ),
            writeExecutable(
                path.join(binaries, "curl"),
                `#!/usr/bin/env bash
authenticated=false
header_file=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--config" ]; then authenticated=true; shift 2; continue; fi
  if [ "$1" = "--dump-header" ]; then header_file="$2"; shift 2; continue; fi
  shift
done
if [ "$FAKE_CHANGE_DURING_PROBE" = true ] && [ ! -e "$FAKE_PROBE_CHANGE_MARKER" ]; then
  : > "$FAKE_PROBE_CHANGE_MARKER"
  printf '%s\n' 'server { server_name probe-change.example.com; }' > "$FAKE_CONFIG_PATH"
fi
if [ "$FAKE_RESTORE_ORIGINAL_DURING_PROBE" = true ] && [ ! -e "$FAKE_ORIGINAL_CHANGE_MARKER" ]; then
  : > "$FAKE_ORIGINAL_CHANGE_MARKER"
  printf '%s' "$FAKE_ORIGINAL_CONFIG" > "$FAKE_CONFIG_PATH"
fi
if [ "$FAKE_CHANGE_CREDENTIAL_DURING_PROBE" = true ] && [ ! -e "$FAKE_CREDENTIAL_CHANGE_MARKER" ]; then
  : > "$FAKE_CREDENTIAL_CHANGE_MARKER"
  printf '%s\n' 'external-credential' > "$FAKE_AUTH_HOST"
fi
if [ "$FAKE_PROBE_DELAY" = true ]; then
  : > "$FAKE_PROBE_MARKER"
  sleep 1
fi
if [ "$authenticated" = true ]; then
  printf 'x-pipipi-revision: %s\r\n' "$FAKE_REVISION" > "$header_file"
  printf '200'
else
  if [ "$FAKE_ANONYMOUS_CHALLENGE" = true ]; then
    printf 'WWW-Authenticate: Basic realm="pipipi console"\r\n' > "$header_file"
  fi
  printf '%s' "$FAKE_ANONYMOUS_STATUS"
fi
`,
            ),
            writeExecutable(
                path.join(binaries, "install"),
                `#!/usr/bin/env bash
if [ "$FAKE_SIGNAL_STAGE" = install ]; then
  : > "$FAKE_SIGNAL_MARKER"
  sleep 1
fi
if [ "$FAKE_FAIL_CREDENTIAL_PREPARATION" = true ]; then
  for argument in "$@"; do destination="$argument"; done
  printf '%s' 'partial-credential' > "$destination"
  exit 13
fi
exec /usr/bin/install "$@"
`,
            ),
            writeExecutable(
                path.join(binaries, "mv"),
                `#!/usr/bin/env bash
for argument in "$@"; do destination="$argument"; done
if { [ "$FAKE_SIGNAL_STAGE" = auth-mv ] && [[ "$destination" == */.pipipi-console.htpasswd ]]; } ||
   { [ "$FAKE_SIGNAL_STAGE" = config-mv ] && [ "$destination" = "$FAKE_CONFIG_PATH" ]; }; then
  : > "$FAKE_SIGNAL_MARKER"
  sleep 1
fi
exec /bin/mv "$@"
`,
            ),
            writeExecutable(
                path.join(binaries, "cp"),
                `#!/usr/bin/env bash
for argument in "$@"; do destination="$argument"; done
if [ "$FAKE_FAIL_CONFIG_RESTORE" = true ] && [ "$destination" = "$FAKE_CONFIG_PATH" ]; then
  exit 13
fi
exec /bin/cp "$@"
`,
            ),
        ]);
        return {
            anonymousStatus: options.anonymousStatus ?? 401,
            anonymousChallenge: options.anonymousChallenge ?? true,
            authorization,
            binaries,
            collector,
            config,
            configSha256,
            dockerLog,
            changeDuringCollector: options.changeDuringCollector ?? false,
            changeBeforeActivation: options.changeBeforeActivation ?? false,
            changeDuringProbe: options.changeDuringProbe ?? false,
            changeCredentialDuringProbe:
                options.changeCredentialDuringProbe ?? false,
            failRollback: options.failRollback ?? false,
            failCredentialPreparation:
                options.failCredentialPreparation ?? false,
            failConfigRestore: options.failConfigRestore ?? false,
            htpasswd,
            probeDelay: options.probeDelay ?? false,
            probeMarker,
            restoreOriginalDuringProbe:
                options.restoreOriginalDuringProbe ?? false,
            signalMarker,
            signalStage: options.signalStage ?? "none",
        };
    }
});

type Fixture = Readonly<{
    anonymousChallenge: boolean;
    anonymousStatus: number;
    authorization: string;
    binaries: string;
    collector: string;
    config: string;
    configSha256: string;
    dockerLog: string;
    changeDuringCollector: boolean;
    changeBeforeActivation: boolean;
    changeDuringProbe: boolean;
    changeCredentialDuringProbe: boolean;
    failRollback: boolean;
    failCredentialPreparation: boolean;
    failConfigRestore: boolean;
    htpasswd: string;
    probeDelay: boolean;
    probeMarker: string;
    restoreOriginalDuringProbe: boolean;
    signalMarker: string;
    signalStage: "install" | "auth-mv" | "config-mv" | "none";
}>;

function runChange(fixture: Fixture) {
    return spawnSync("bash", changeArgs(fixture), {
        cwd: process.cwd(),
        encoding: "utf8",
        env: changeEnv(fixture),
    });
}

function changeArgs(fixture: Fixture) {
    return [
        "ops/apply-console-gateway-auth.sh",
        DOMAIN,
        "/console",
        `https://${DOMAIN}/console`,
        REVISION,
        fixture.config,
        fixture.configSha256,
        "openresty",
        "/etc/nginx/conf.d/site.conf",
        fixture.htpasswd,
        fixture.authorization,
        fixture.collector,
    ];
}

function changeEnv(fixture: Fixture) {
    return {
        ...process.env,
        FAKE_ANONYMOUS_STATUS: String(fixture.anonymousStatus),
        FAKE_ANONYMOUS_CHALLENGE: String(fixture.anonymousChallenge),
        FAKE_CHANGE_DURING_COLLECTOR: String(fixture.changeDuringCollector),
        FAKE_CHANGE_BEFORE_ACTIVATION: String(fixture.changeBeforeActivation),
        FAKE_CHANGE_DURING_PROBE: String(fixture.changeDuringProbe),
        FAKE_CHANGE_CREDENTIAL_DURING_PROBE: String(
            fixture.changeCredentialDuringProbe,
        ),
        FAKE_AUTH_HOST: path.join(
            path.dirname(fixture.config),
            ".pipipi-console.htpasswd",
        ),
        FAKE_CONFIG_PATH: fixture.config,
        FAKE_CONFIG_SHA256: fixture.configSha256,
        FAKE_CREDENTIAL_CHANGE_MARKER: `${fixture.probeMarker}-credential`,
        FAKE_DOCKER_LOG: fixture.dockerLog,
        FAKE_FAIL_ROLLBACK: String(fixture.failRollback),
        FAKE_FAIL_CREDENTIAL_PREPARATION: String(
            fixture.failCredentialPreparation,
        ),
        FAKE_FAIL_CONFIG_RESTORE: String(fixture.failConfigRestore),
        FAKE_ORIGINAL_CHANGE_MARKER: `${fixture.probeMarker}-original`,
        FAKE_ORIGINAL_CONFIG: ORIGINAL_CONFIG,
        FAKE_PROBE_DELAY: String(fixture.probeDelay),
        FAKE_PROBE_CHANGE_MARKER: `${fixture.probeMarker}-changed`,
        FAKE_PROBE_MARKER: fixture.probeMarker,
        FAKE_RESTORE_ORIGINAL_DURING_PROBE: String(
            fixture.restoreOriginalDuringProbe,
        ),
        FAKE_REVISION: REVISION,
        FAKE_SIGNAL_MARKER: fixture.signalMarker,
        FAKE_SIGNAL_STAGE: fixture.signalStage,
        PATH: `${fixture.binaries}:${process.env.PATH}`,
    };
}

async function writeExecutable(file: string, content: string) {
    await writeFile(file, content);
    await chmod(file, 0o755);
}

async function waitForFile(file: string) {
    const { access } = await import("node:fs/promises");
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(file);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    throw new Error("Timed out waiting for the probe marker");
}
