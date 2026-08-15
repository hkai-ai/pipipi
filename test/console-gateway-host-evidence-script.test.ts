import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const DOMAIN = "pi.ganjiuwanshi.com";

describe("Console gateway host evidence script", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            temporaryDirectories
                .splice(0)
                .map((directory) =>
                    rm(directory, { recursive: true, force: true }),
                ),
        );
    });

    it("finds one managed server without exposing its configuration", async () => {
        const fixture = await createFixture();
        const configDirectory = path.join(fixture.configRoot, "conf.d");
        await mkdir(configDirectory);
        const config = path.join(configDirectory, "site.conf");
        await writeFile(
            config,
            `server {
                server_name ${DOMAIN};
                auth_basic "Console";
                # fixture-secret
                # auth_request /commented-out;
                location /console {
                    proxy_pass http://172.18.0.1:4300;
                }
            }
            server {
                server_name unrelated.example.com;
                auth_request /unrelated;
                location /console { proxy_pass http://unrelated; }
            }
            `,
        );

        const result = runAudit(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            schemaVersion: 1,
            event: "console_gateway_host_inspected",
            status: "discovered",
            matchingConfigCount: 1,
            config: {
                path: config,
                authBasicDirectiveCount: 1,
                authRequestDirectiveCount: 0,
                consoleLocationDirectiveCount: 1,
                proxyPassDirectiveCount: 1,
            },
            reloadAdapter: {
                kind: "docker_container",
                containerNames: ["openresty"],
            },
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("172.18.0.1");
        expect(result.stdout).not.toContain("proxy_pass http");
    });

    it("uses the requested public path instead of assuming /console", async () => {
        const fixture = await createFixture();
        await writeFile(
            path.join(fixture.configRoot, "site.conf"),
            `server {
                server_name ${DOMAIN};
                location /console { proxy_pass http://old; }
                location /operator { proxy_pass http://current; }
            }\n`,
        );

        const result = runAudit(fixture, "/operator");

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "discovered",
            publicPath: "/operator",
            config: {
                consoleLocationDirectiveCount: 1,
                proxyPassDirectiveCount: 2,
            },
        });
    });

    it("discovers configuration roots from the running gateway mounts", async () => {
        const fixture = await createFixture();
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        await mkdir(unrelatedRoot);
        const mountedConfigDirectory = path.join(fixture.configRoot, "conf.d");
        await mkdir(mountedConfigDirectory);
        await writeFile(
            path.join(mountedConfigDirectory, "site.conf"),
            `server { server_name ${DOMAIN}; }\n`,
        );

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "discovered",
            matchingServerBlockCount: 1,
            reloadAdapter: {
                kind: "docker_container",
                containerNames: ["openresty"],
            },
        });
    });

    it("deduplicates configs reached through overlapping scan roots", async () => {
        const fixture = await createFixture();
        await writeFile(
            path.join(fixture.configRoot, "site.conf"),
            `server { server_name ${DOMAIN}; }\n`,
        );

        const result = runAudit(fixture, "/console", [
            path.dirname(fixture.configRoot),
        ]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "discovered",
            matchingConfigCount: 1,
            matchingServerBlockCount: 1,
        });
    });

    it("fails closed when more than one server config matches", async () => {
        const fixture = await createFixture();
        await Promise.all(
            ["first.conf", "second.conf"].map((name) =>
                writeFile(
                    path.join(fixture.configRoot, name),
                    `server { server_name ${DOMAIN}; }\n`,
                ),
            ),
        );

        const result = runAudit(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "ambiguous",
            matchingConfigCount: 2,
            config: null,
        });
    });

    it("reports an absent managed server as a non-mutating result", async () => {
        const fixture = await createFixture();

        const result = runAudit(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "not_found",
            matchingConfigCount: 0,
            config: null,
        });
    });

    it("rejects domains that could become shell or regular-expression input", async () => {
        const fixture = await createFixture();

        const result = spawnSync(
            "bash",
            [
                "ops/collect-console-gateway-host-evidence.sh",
                "pi.example.com;id",
                "/console",
                fixture.configRoot,
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${fixture.binaries}:${process.env.PATH}`,
                },
            },
        );

        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
    });

    it("fails closed when configuration enumeration is incomplete", async () => {
        const fixture = await createFixture();
        await writeExecutable(
            path.join(fixture.binaries, "find"),
            `#!/usr/bin/env bash
exit 13
`,
        );

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "config_enumeration_failed",
        });
        expect(result.stdout).not.toContain(fixture.configRoot);
    });

    it("fails closed when a discovered configuration cannot be parsed", async () => {
        const fixture = await createFixture();
        const config = path.join(fixture.configRoot, "unreadable.conf");
        await writeFile(config, `server { server_name ${DOMAIN}; }\n`);
        await chmod(config, 0o000);

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "config_parse_failed",
        });
        expect(result.stdout).not.toContain(config);
    });

    it("does not associate an unrelated gateway container with the config", async () => {
        const fixture = await createFixture({ mountConfig: false });
        await writeFile(
            path.join(fixture.configRoot, "site.conf"),
            `server { server_name ${DOMAIN}; }\n`,
        );

        const result = runAudit(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "discovered",
            reloadAdapter: {
                kind: "unavailable",
                containerNames: [],
            },
        });
    });

    it("does not scan non-configuration mounts below /etc/nginx", async () => {
        const fixture = await createFixture({
            mountDestination: "/etc/nginx/html",
        });
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        await mkdir(unrelatedRoot);
        await writeFile(
            path.join(fixture.configRoot, "site.conf"),
            `server { server_name ${DOMAIN}; }\n`,
        );

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "not_found",
            reloadAdapter: {
                kind: "unavailable",
                containerNames: [],
            },
        });
    });

    it("does not associate configs outside allowed scopes of a root mount", async () => {
        const fixture = await createFixture();
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        const htmlRoot = path.join(fixture.configRoot, "html");
        await Promise.all([mkdir(unrelatedRoot), mkdir(htmlRoot)]);
        await writeFile(
            path.join(htmlRoot, "site.conf"),
            `server { server_name ${DOMAIN}; }\n`,
        );

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "not_found",
            reloadAdapter: {
                kind: "unavailable",
                containerNames: [],
            },
        });
    });

    it("discovers extensionless sites-enabled symlinks", async () => {
        const fixture = await createFixture();
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        const availableRoot = path.join(fixture.configRoot, "sites-available");
        const enabledRoot = path.join(fixture.configRoot, "sites-enabled");
        await Promise.all([
            mkdir(unrelatedRoot),
            mkdir(availableRoot),
            mkdir(enabledRoot),
        ]);
        const availableConfig = path.join(availableRoot, DOMAIN);
        await writeFile(availableConfig, `server { server_name ${DOMAIN}; }\n`);
        await symlink(availableConfig, path.join(enabledRoot, DOMAIN));

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "discovered",
            reloadAdapter: {
                kind: "docker_container",
                containerNames: ["openresty"],
            },
        });
    });

    it("fails closed for sites-enabled symlinks outside the config mount", async () => {
        const fixture = await createFixture();
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        const enabledRoot = path.join(fixture.configRoot, "sites-enabled");
        const outsideConfig = path.join(
            path.dirname(fixture.configRoot),
            "outside.conf",
        );
        await Promise.all([mkdir(unrelatedRoot), mkdir(enabledRoot)]);
        await writeFile(outsideConfig, `server { server_name ${DOMAIN}; }\n`);
        await symlink(outsideConfig, path.join(enabledRoot, DOMAIN));

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "site_config_target_outside_scope",
        });
        expect(result.stdout).not.toContain(outsideConfig);
    });

    it("fails closed for directory symlinks below sites-enabled", async () => {
        const fixture = await createFixture();
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        const availableRoot = path.join(fixture.configRoot, "sites-available");
        const enabledRoot = path.join(fixture.configRoot, "sites-enabled");
        await Promise.all([
            mkdir(unrelatedRoot),
            mkdir(availableRoot),
            mkdir(enabledRoot),
        ]);
        await symlink(availableRoot, path.join(enabledRoot, "directory"));

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "site_config_target_invalid",
        });
    });

    it("supports a single configuration file mounted into the gateway", async () => {
        const fixture = await createFixture({ mountFile: true });
        const unrelatedRoot = path.join(
            path.dirname(fixture.configRoot),
            "unrelated-conf",
        );
        await mkdir(unrelatedRoot);
        await writeFile(
            path.join(fixture.configRoot, "mounted.conf"),
            `server { server_name ${DOMAIN}; }\n`,
        );

        const result = runAudit(fixture, "/console", [unrelatedRoot]);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "discovered",
            reloadAdapter: {
                kind: "docker_container",
                containerNames: ["openresty"],
            },
        });
    });

    it("fails closed when gateway mounts cannot be inspected", async () => {
        const fixture = await createFixture({ inspectFailure: true });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "gateway_mount_inspection_failed",
        });
    });

    it("fails closed when gateway containers cannot be enumerated", async () => {
        const fixture = await createFixture({ dockerPsFailure: true });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "gateway_container_enumeration_failed",
        });
    });

    async function createFixture(
        options: {
            dockerPsFailure?: boolean;
            inspectFailure?: boolean;
            mountConfig?: boolean;
            mountDestination?: string;
            mountFile?: boolean;
        } = {},
    ): Promise<Fixture> {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-console-gateway-"),
        );
        temporaryDirectories.push(directory);
        const binaries = path.join(directory, "bin");
        const configRoot = path.join(directory, "conf.d");
        await Promise.all([mkdir(binaries), mkdir(configRoot)]);
        const docker = path.join(binaries, "docker");
        await writeExecutable(
            docker,
            `#!/usr/bin/env bash
set -eu
if [ "$1" = "ps" ]; then
    ${options.dockerPsFailure === true ? "exit 13" : ""}
    printf '%s\\t%s\\n' 'openresty' '1panel/openresty:fixture'
    exit 0
fi
if [ "$1" = "inspect" ]; then
    ${options.inspectFailure === true ? "exit 13" : ""}
    printf '[{"Source":"%s","Destination":"%s"}]\\n' '${
        options.mountFile === true
            ? path.join(configRoot, "mounted.conf")
            : configRoot
    }' '${
        options.mountDestination ??
        (options.mountConfig === false
            ? "/backup"
            : options.mountFile === true
              ? "/etc/nginx/conf.d/site.conf"
              : "/etc/nginx")
    }'
    exit 0
fi
exit 2
`,
        );
        return { binaries, configRoot };
    }
});

type Fixture = Readonly<{
    binaries: string;
    configRoot: string;
}>;

function runAudit(
    fixture: Fixture,
    publicPath = "/console",
    configRoots = [fixture.configRoot],
) {
    return spawnSync(
        "bash",
        [
            "ops/collect-console-gateway-host-evidence.sh",
            DOMAIN,
            publicPath,
            ...configRoots,
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${fixture.binaries}:${process.env.PATH}`,
            },
        },
    );
}

async function writeExecutable(file: string, content: string) {
    await writeFile(file, content);
    await chmod(file, 0o755);
}
