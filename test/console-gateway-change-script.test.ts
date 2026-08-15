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
            failureStage: "public_anonymous_probe",
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

    it("rolls back before public verification when the local gateway does not challenge", async () => {
        const fixture = await createFixture({ localAnonymousStatus: 200 });
        const original = await readFile(fixture.config, "utf8");

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "local_anonymous_probe",
            rollbackStatus: "succeeded",
        });
        expect(await readFile(fixture.config, "utf8")).toBe(original);
    });

    it("waits for a reloaded OpenResty worker to start challenging locally", async () => {
        const fixture = await createFixture({
            localAnonymousWarmupAttempts: 1,
        });

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            localAnonymousStatus: [401, 401, 401],
        });
    });

    it("retries a transient local transport failure during reload", async () => {
        const fixture = await createFixture({
            localAnonymousTransportFailures: 1,
        });

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            localAnonymousStatus: [401, 401, 401],
        });
    });

    it("waits for a reloaded OpenResty worker to start challenging publicly", async () => {
        const fixture = await createFixture({
            publicAnonymousWarmupAttempts: 1,
        });

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            anonymousStatus: [401, 401, 401],
        });
    });

    it("retries a transient public transport failure during reload", async () => {
        const fixture = await createFixture({
            publicAnonymousTransportFailures: 1,
        });

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            anonymousStatus: [401, 401, 401],
        });
    });

    it("accepts a pinned legacy revision only when the container label and response contracts agree", async () => {
        const fixture = await createFixture({
            legacyRevision: REVISION,
            legacyStatsContract: true,
            revisionHeader: false,
        });

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            revision: REVISION,
            revisionVerification: "legacy_container_and_contract",
            localAnonymousStatus: [401, 401, 401],
            localAuthenticatedStatus: [200, 200, 200],
        });
    });

    it("accepts the pinned legacy statistics contract without weakening the current contract", async () => {
        const fixture = await createFixture({
            legacyRevision: REVISION,
            legacyStatsContract: true,
            revisionHeader: false,
        });

        const result = runChange(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            revisionVerification: "legacy_container_and_contract",
            authenticatedStatus: [200, 200, 200],
        });
    });

    it("rejects the legacy statistics shape when a current revision header is present", async () => {
        const fixture = await createFixture({ legacyStatsContract: true });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "local_contract_probe",
            rollbackStatus: "succeeded",
        });
    });

    it("rejects a legacy response when the application container revision differs", async () => {
        const fixture = await createFixture({
            applicationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            legacyRevision: REVISION,
            revisionHeader: false,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "precondition",
            rollbackStatus: "not_required",
        });
    });

    it("rolls back when a legacy response body does not satisfy the Console contract", async () => {
        const fixture = await createFixture({
            legacyRevision: REVISION,
            processContractValid: false,
            revisionHeader: false,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "local_contract_probe",
            rollbackStatus: "succeeded",
        });
    });

    it("rolls back if the application revision changes during verification", async () => {
        const fixture = await createFixture({
            changeApplicationRevisionDuringProbe: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "application_revision_consistency",
            rollbackStatus: "succeeded",
        });
    });

    it("rolls back if the application container is replaced during verification", async () => {
        const fixture = await createFixture({
            changeApplicationIdentityDuringProbe: true,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "application_revision_consistency",
            rollbackStatus: "succeeded",
        });
    });

    it("rejects an empty revision header instead of treating it as absent", async () => {
        const fixture = await createFixture({
            emptyRevisionHeader: true,
            legacyRevision: REVISION,
            revisionHeader: false,
        });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "local_revision_probe",
            rollbackStatus: "succeeded",
        });
    });

    it("rejects duplicate revision headers", async () => {
        const fixture = await createFixture({ duplicateRevisionHeader: true });

        const result = runChange(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureStage: "local_revision_probe",
            rollbackStatus: "succeeded",
        });
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
            failureStage: "public_anonymous_probe",
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
        expect(await readFile(fixture.dockerLog, "utf8")).toMatch(
            /^inspect pipipi --format .*com\.pipipi\.revision.*\n$/,
        );
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
            applicationRevision?: string;
            anonymousChallenge?: boolean;
            anonymousStatus?: number;
            changeApplicationIdentityDuringProbe?: boolean;
            changeApplicationRevisionDuringProbe?: boolean;
            changeDuringCollector?: boolean;
            changeBeforeActivation?: boolean;
            changeDuringProbe?: boolean;
            changeCredentialDuringProbe?: boolean;
            danglingAuth?: boolean;
            duplicateRevisionHeader?: boolean;
            emptyRevisionHeader?: boolean;
            failRollback?: boolean;
            failCredentialPreparation?: boolean;
            failConfigRestore?: boolean;
            existingAuth?: boolean;
            legacyRevision?: string;
            legacyStatsContract?: boolean;
            localAnonymousChallenge?: boolean;
            localAnonymousStatus?: number;
            localAnonymousTransportFailures?: number;
            localAnonymousWarmupAttempts?: number;
            probeDelay?: boolean;
            processContractValid?: boolean;
            publicAnonymousWarmupAttempts?: number;
            publicAnonymousTransportFailures?: number;
            revisionHeader?: boolean;
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
if [[ "$*" == *"com.pipipi.revision"* ]]; then
  application_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  if [ "$FAKE_CHANGE_APPLICATION_IDENTITY_DURING_PROBE" = true ] &&
     [ -e "$FAKE_APPLICATION_REVISION_CHANGE_MARKER" ]; then
    application_id="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  fi
  if [ "$FAKE_CHANGE_APPLICATION_REVISION_DURING_PROBE" = true ] &&
     [ -e "$FAKE_APPLICATION_REVISION_CHANGE_MARKER" ]; then
    application_revision="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  else
    application_revision="$FAKE_APP_REVISION"
  fi
  printf '%s|true|%s\n' "$application_id" "$application_revision"
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
output_file="/dev/null"
local_probe=false
arguments=" $* "
if [[ "$arguments" == *" --resolve "* ]]; then local_probe=true; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--config" ]; then authenticated=true; shift 2; continue; fi
  if [ "$1" = "--dump-header" ]; then header_file="$2"; shift 2; continue; fi
  if [ "$1" = "--output" ]; then output_file="$2"; shift 2; continue; fi
  if [ "$1" = "--resolve" ]; then shift 2; continue; fi
  shift
done
if [ "$FAKE_CHANGE_DURING_PROBE" = true ] && [ ! -e "$FAKE_PROBE_CHANGE_MARKER" ]; then
  : > "$FAKE_PROBE_CHANGE_MARKER"
  printf '%s\n' 'server { server_name probe-change.example.com; }' > "$FAKE_CONFIG_PATH"
fi
if [ "$FAKE_CHANGE_APPLICATION_REVISION_DURING_PROBE" = true ] ||
   [ "$FAKE_CHANGE_APPLICATION_IDENTITY_DURING_PROBE" = true ]; then
  : > "$FAKE_APPLICATION_REVISION_CHANGE_MARKER"
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
  : > "$header_file"
  if [ "$FAKE_REVISION_HEADER" = true ]; then
    printf 'x-pipipi-revision: %s\r\n' "$FAKE_REVISION" >> "$header_file"
    if [ "$FAKE_DUPLICATE_REVISION_HEADER" = true ]; then
      printf 'x-pipipi-revision: %s\r\n' "$FAKE_REVISION" >> "$header_file"
    fi
  elif [ "$FAKE_EMPTY_REVISION_HEADER" = true ]; then
    printf 'x-pipipi-revision:\r\n' >> "$header_file"
  fi
  case "$arguments" in
    *'/processes'*)
      printf 'content-type: application/json\r\n' >> "$header_file"
      if [ "$FAKE_PROCESS_CONTRACT_VALID" = true ]; then
        printf '%s' '{"processes":[{"process":"fixture","version":"v1","activities":[]}]}' > "$output_file"
      else
        printf '%s' '{"processes":[]}' > "$output_file"
      fi
      ;;
    *'/stats?hours=1'*)
      printf 'content-type: application/json\r\n' >> "$header_file"
      if [ "$FAKE_LEGACY_STATS_CONTRACT" = true ]; then
        printf '%s' '{"totals":{"succeeded":0,"failed":0},"byProcess":[],"byErrorCode":[],"concurrency":{"active":0,"limit":4},"attemptDurationMs":{"samples":0}}' > "$output_file"
      else
        printf '%s' '{"totals":{"succeeded":0,"failed":0},"byDay":[],"recentFailures":[],"concurrency":{"active":0,"limit":4},"attemptDurationMs":{"samples":0}}' > "$output_file"
      fi
      ;;
    *)
      printf 'content-type: text/html\r\n' >> "$header_file"
      printf '%s' '<title>Business Process 控制台</title><div id="console"></div>' > "$output_file"
      ;;
  esac
  printf '200'
else
  if { [ "$local_probe" = true ] && [ "$FAKE_LOCAL_ANONYMOUS_CHALLENGE" = true ]; } ||
     { [ "$local_probe" = false ] && [ "$FAKE_ANONYMOUS_CHALLENGE" = true ]; }; then
    printf 'WWW-Authenticate: Basic realm="pipipi console"\r\n' > "$header_file"
  fi
  if [ "$local_probe" = true ]; then
    local_attempt=1
    if [ -f "$FAKE_LOCAL_ANONYMOUS_ATTEMPT_FILE" ]; then
      local_attempt=$(( $(cat "$FAKE_LOCAL_ANONYMOUS_ATTEMPT_FILE") + 1 ))
    fi
    printf '%s' "$local_attempt" > "$FAKE_LOCAL_ANONYMOUS_ATTEMPT_FILE"
    if [ "$local_attempt" -le "$FAKE_LOCAL_ANONYMOUS_TRANSPORT_FAILURES" ]; then
      exit 7
    elif [ "$local_attempt" -le "$FAKE_LOCAL_ANONYMOUS_WARMUP_ATTEMPTS" ]; then
      printf '200'
    else
      printf '%s' "$FAKE_LOCAL_ANONYMOUS_STATUS"
    fi
  else
    public_attempt=1
    if [ -f "$FAKE_PUBLIC_ANONYMOUS_ATTEMPT_FILE" ]; then
      public_attempt=$(( $(cat "$FAKE_PUBLIC_ANONYMOUS_ATTEMPT_FILE") + 1 ))
    fi
    printf '%s' "$public_attempt" > "$FAKE_PUBLIC_ANONYMOUS_ATTEMPT_FILE"
    if [ "$public_attempt" -le "$FAKE_PUBLIC_ANONYMOUS_TRANSPORT_FAILURES" ]; then
      exit 7
    elif [ "$public_attempt" -le "$FAKE_PUBLIC_ANONYMOUS_WARMUP_ATTEMPTS" ]; then
      printf '200'
    else
      printf '%s' "$FAKE_ANONYMOUS_STATUS"
    fi
  fi
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
            writeExecutable(
                path.join(binaries, "sleep"),
                `#!/usr/bin/env bash
if [ "\${1:-}" = "0.25" ]; then exit 0; fi
exec /bin/sleep "$@"
`,
            ),
        ]);
        return {
            applicationRevision: options.applicationRevision ?? REVISION,
            anonymousStatus: options.anonymousStatus ?? 401,
            anonymousChallenge: options.anonymousChallenge ?? true,
            changeApplicationRevisionDuringProbe:
                options.changeApplicationRevisionDuringProbe ?? false,
            changeApplicationIdentityDuringProbe:
                options.changeApplicationIdentityDuringProbe ?? false,
            authorization,
            binaries,
            collector,
            config,
            configSha256,
            dockerLog,
            duplicateRevisionHeader: options.duplicateRevisionHeader ?? false,
            emptyRevisionHeader: options.emptyRevisionHeader ?? false,
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
            legacyRevision: options.legacyRevision ?? "none",
            legacyStatsContract: options.legacyStatsContract ?? false,
            localAnonymousChallenge: options.localAnonymousChallenge ?? true,
            localAnonymousStatus: options.localAnonymousStatus ?? 401,
            localAnonymousTransportFailures:
                options.localAnonymousTransportFailures ?? 0,
            localAnonymousWarmupAttempts:
                options.localAnonymousWarmupAttempts ?? 0,
            probeDelay: options.probeDelay ?? false,
            probeMarker,
            processContractValid: options.processContractValid ?? true,
            publicAnonymousWarmupAttempts:
                options.publicAnonymousWarmupAttempts ?? 0,
            publicAnonymousTransportFailures:
                options.publicAnonymousTransportFailures ?? 0,
            revisionHeader: options.revisionHeader ?? true,
            restoreOriginalDuringProbe:
                options.restoreOriginalDuringProbe ?? false,
            signalMarker,
            signalStage: options.signalStage ?? "none",
        };
    }
});

type Fixture = Readonly<{
    applicationRevision: string;
    anonymousChallenge: boolean;
    anonymousStatus: number;
    changeApplicationIdentityDuringProbe: boolean;
    changeApplicationRevisionDuringProbe: boolean;
    authorization: string;
    binaries: string;
    collector: string;
    config: string;
    configSha256: string;
    dockerLog: string;
    duplicateRevisionHeader: boolean;
    emptyRevisionHeader: boolean;
    changeDuringCollector: boolean;
    changeBeforeActivation: boolean;
    changeDuringProbe: boolean;
    changeCredentialDuringProbe: boolean;
    failRollback: boolean;
    failCredentialPreparation: boolean;
    failConfigRestore: boolean;
    htpasswd: string;
    legacyRevision: string;
    legacyStatsContract: boolean;
    localAnonymousChallenge: boolean;
    localAnonymousStatus: number;
    localAnonymousTransportFailures: number;
    localAnonymousWarmupAttempts: number;
    probeDelay: boolean;
    probeMarker: string;
    processContractValid: boolean;
    publicAnonymousWarmupAttempts: number;
    publicAnonymousTransportFailures: number;
    revisionHeader: boolean;
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
        "pipipi",
        fixture.legacyRevision,
    ];
}

function changeEnv(fixture: Fixture) {
    return {
        ...process.env,
        FAKE_ANONYMOUS_STATUS: String(fixture.anonymousStatus),
        FAKE_APP_REVISION: fixture.applicationRevision,
        FAKE_APPLICATION_REVISION_CHANGE_MARKER: `${fixture.probeMarker}-application-revision`,
        FAKE_ANONYMOUS_CHALLENGE: String(fixture.anonymousChallenge),
        FAKE_LOCAL_ANONYMOUS_CHALLENGE: String(fixture.localAnonymousChallenge),
        FAKE_LOCAL_ANONYMOUS_STATUS: String(fixture.localAnonymousStatus),
        FAKE_LEGACY_STATS_CONTRACT: String(fixture.legacyStatsContract),
        FAKE_LOCAL_ANONYMOUS_TRANSPORT_FAILURES: String(
            fixture.localAnonymousTransportFailures,
        ),
        FAKE_LOCAL_ANONYMOUS_ATTEMPT_FILE: `${fixture.probeMarker}-local-anonymous-attempt`,
        FAKE_LOCAL_ANONYMOUS_WARMUP_ATTEMPTS: String(
            fixture.localAnonymousWarmupAttempts,
        ),
        FAKE_CHANGE_DURING_COLLECTOR: String(fixture.changeDuringCollector),
        FAKE_CHANGE_BEFORE_ACTIVATION: String(fixture.changeBeforeActivation),
        FAKE_CHANGE_APPLICATION_IDENTITY_DURING_PROBE: String(
            fixture.changeApplicationIdentityDuringProbe,
        ),
        FAKE_CHANGE_APPLICATION_REVISION_DURING_PROBE: String(
            fixture.changeApplicationRevisionDuringProbe,
        ),
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
        FAKE_DUPLICATE_REVISION_HEADER: String(fixture.duplicateRevisionHeader),
        FAKE_EMPTY_REVISION_HEADER: String(fixture.emptyRevisionHeader),
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
        FAKE_PROCESS_CONTRACT_VALID: String(fixture.processContractValid),
        FAKE_PUBLIC_ANONYMOUS_ATTEMPT_FILE: `${fixture.probeMarker}-public-anonymous-attempt`,
        FAKE_PUBLIC_ANONYMOUS_WARMUP_ATTEMPTS: String(
            fixture.publicAnonymousWarmupAttempts,
        ),
        FAKE_PUBLIC_ANONYMOUS_TRANSPORT_FAILURES: String(
            fixture.publicAnonymousTransportFailures,
        ),
        FAKE_RESTORE_ORIGINAL_DURING_PROBE: String(
            fixture.restoreOriginalDuringProbe,
        ),
        FAKE_REVISION: REVISION,
        FAKE_REVISION_HEADER: String(fixture.revisionHeader),
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
    for (let attempt = 0; attempt < 250; attempt += 1) {
        try {
            await access(file);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    throw new Error("Timed out waiting for the probe marker");
}
