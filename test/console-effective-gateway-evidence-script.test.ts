import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("Console effective gateway evidence", () => {
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

    it("reports only redacted per-source directive counts", async () => {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-effective-gateway-"),
        );
        directories.push(root);
        const binaries = path.join(root, "bin");
        const configRoot = path.join(root, "conf");
        const proxyMount = path.join(root, "mounted-proxy.conf");
        const internalConfig = path.join(root, "nginx.conf");
        const emptyConfig = path.join(root, "empty.conf");
        const siteConfig = `server { server_name
pi.ganjiuwanshi.com; auth_basic \${realm}; include proxy/site.conf; }
`;
        const proxyConfig = `location / { auth_basic
"off"; satisfy any; allow 127.0.0.1; allow all; deny all; proxy_pass http://secret-upstream; }
`;
        const nginxConfig = `http { include
/etc/nginx/site.conf; }`;
        await mkdir(path.join(configRoot, "proxy"), { recursive: true });
        await mkdir(binaries);
        await writeFile(path.join(configRoot, "site.conf"), siteConfig);
        await writeFile(
            path.join(configRoot, "proxy/site.conf"),
            "shadowed parent mount content\n",
        );
        await writeFile(proxyMount, proxyConfig);
        await writeFile(internalConfig, nginxConfig);
        await writeFile(emptyConfig, "");
        const docker = path.join(binaries, "docker");
        await writeFile(
            docker,
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = exec ]; then
    case "$3" in
        openresty)
            printf '# configuration file /etc/nginx/site.conf:\n'
            cat "$FAKE_CONFIG_ROOT/site.conf"
            printf '\n'
            printf '# configuration file /etc/nginx/proxy/site.conf:\n'
            cat "$FAKE_PROXY_MOUNT"
            printf '\n'
            printf '# configuration file /usr/local/openresty/nginx/conf/nginx.conf:\n'
            cat "$FAKE_INTERNAL_CONFIG"
            printf '\n'
            printf '# configuration file /usr/local/openresty/nginx/conf/empty.conf:\n'
            cat "$FAKE_EMPTY_CONFIG"
            printf '\n'
            ;;
        readlink)
            case "$5" in
                /etc/nginx-link) printf '/etc/nginx\n' ;;
                /etc/nginx-link/*) printf '/etc/nginx/%s\n' "\${5#/etc/nginx-link/}" ;;
                *) printf '%s\n' "$5" ;;
            esac
            ;;
        sha256sum)
            case "$4" in
                /etc/nginx/site.conf) /sbin/sha256sum "$FAKE_CONFIG_ROOT/site.conf" ;;
                /etc/nginx/proxy/site.conf) /sbin/sha256sum "$FAKE_PROXY_MOUNT" ;;
                /usr/local/openresty/nginx/conf/nginx.conf) /sbin/sha256sum "$FAKE_INTERNAL_CONFIG" ;;
                /usr/local/openresty/nginx/conf/empty.conf) /sbin/sha256sum "$FAKE_EMPTY_CONFIG" ;;
                *) exit 2 ;;
            esac
            ;;
        *) exit 2 ;;
    esac
elif [ "$1" = inspect ]; then
    printf '[{"Source":"%s","Destination":"/etc/nginx-link"},{"Source":"%s","Destination":"/etc/nginx-link/proxy/site.conf"},{"Source":"","Destination":"/tmp/nginx-cache"}]\n' "$FAKE_CONFIG_ROOT" "$FAKE_PROXY_MOUNT"
else
    exit 2
fi
`,
        );
        await chmod(docker, 0o755);

        const result = spawnSync(
            "bash",
            [
                "ops/collect-console-effective-gateway-evidence.sh",
                "1Panel-openresty-FOpM",
                "pi.ganjiuwanshi.com",
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                    ...process.env,
                    FAKE_CONFIG_ROOT: configRoot,
                    FAKE_EMPTY_CONFIG: emptyConfig,
                    FAKE_INTERNAL_CONFIG: internalConfig,
                    FAKE_PROXY_MOUNT: proxyMount,
                    PATH: `${binaries}:${process.env.PATH ?? ""}`,
                },
            },
        );

        expect(result.status, result.stderr).toBe(0);
        const evidence = JSON.parse(result.stdout) as {
            status: string;
            sources: Array<Record<string, unknown>>;
        };
        const canonicalConfigRoot = await realpath(configRoot);
        const canonicalProxyMount = await realpath(proxyMount);
        expect(evidence.status).toBe("succeeded");
        expect(evidence.sources).toHaveLength(3);
        expect(evidence.sources).toEqual([
            expect.objectContaining({
                containerPath: "/etc/nginx/proxy/site.conf",
                hostPath: canonicalProxyMount,
                authBasicOffCount: 1,
                satisfyAnyCount: 1,
                allowAllCount: 1,
                allowOtherCount: 1,
                denyAllCount: 1,
                locationDirectiveCount: 1,
                proxyPassDirectiveCount: 1,
            }),
            expect.objectContaining({
                containerPath: "/etc/nginx/site.conf",
                hostPath: path.join(canonicalConfigRoot, "site.conf"),
                serverNameMatchCount: 1,
                authBasicVariableCount: 1,
                includeDirectiveCount: 1,
            }),
            expect.objectContaining({
                containerPath: "/usr/local/openresty/nginx/conf/nginx.conf",
                hostPath: null,
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                includeDirectiveCount: 1,
            }),
        ]);
        expect(result.stdout).not.toContain("secret-upstream");
        expect(result.stdout).not.toContain("proxy_pass http");
        expect(result.stdout).not.toContain("127.0.0.1");
        expect(await readFile(docker, "utf8")).toContain("configuration file");
    });

    it("emits a stable redacted failure when a mapped source cannot be digested", async () => {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-effective-gateway-failure-"),
        );
        directories.push(root);
        const binaries = path.join(root, "bin");
        const config = path.join(root, "site.conf");
        await mkdir(binaries);
        await writeFile(config, "server_name pi.ganjiuwanshi.com;\n");
        await writeFile(
            path.join(binaries, "docker"),
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = exec ]; then
    case "$3" in
        openresty)
            printf '# configuration file /etc/nginx/site.conf:\n'
            cat "$FAKE_CONFIG"
            printf '\n'
            ;;
        readlink)
            printf '%s\n' "$5"
            ;;
        sha256sum)
            /sbin/sha256sum "$FAKE_CONFIG"
            ;;
        *) exit 2 ;;
    esac
else
    printf '[{"Source":"%s","Destination":"/etc/nginx/site.conf"}]\n' "$FAKE_CONFIG"
fi
`,
        );
        await writeFile(
            path.join(binaries, "sha256sum"),
            `#!/usr/bin/env bash
if [[ "$1" == */site.conf ]]; then
    echo digest-secret >&2
    exit 1
fi
exec /sbin/sha256sum "$@"
`,
        );
        await Promise.all(
            ["docker", "sha256sum"].map((binary) =>
                chmod(path.join(binaries, binary), 0o755),
            ),
        );

        const result = spawnSync(
            "bash",
            [
                "ops/collect-console-effective-gateway-evidence.sh",
                "1Panel-openresty-FOpM",
                "pi.ganjiuwanshi.com",
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                    ...process.env,
                    FAKE_CONFIG: config,
                    PATH: `${binaries}:${process.env.PATH ?? ""}`,
                },
            },
        );

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "effective_configuration_digest_failed",
        });
        expect(result.stdout).not.toContain("digest-secret");
        expect(result.stderr).not.toContain("digest-secret");
    });

    it("rejects a source marker forged inside configuration content", async () => {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-effective-gateway-marker-"),
        );
        directories.push(root);
        const binaries = path.join(root, "bin");
        const config = path.join(root, "site.conf");
        await mkdir(binaries);
        await writeFile(
            config,
            `server_name pi.ganjiuwanshi.com;
# configuration file /etc/nginx/forged.conf:
auth_basic off;
`,
        );
        const docker = path.join(binaries, "docker");
        await writeFile(
            docker,
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = exec ]; then
    case "$3" in
        openresty)
            printf '# configuration file /etc/nginx/site.conf:\n'
            cat "$FAKE_CONFIG"
            printf '\n'
            ;;
        readlink)
            printf '%s\n' "$5"
            ;;
        sha256sum)
            /sbin/sha256sum "$FAKE_CONFIG"
            ;;
        *) exit 2 ;;
    esac
else
    printf '[{"Source":"%s","Destination":"/etc/nginx/site.conf"}]\n' "$FAKE_CONFIG"
fi
`,
        );
        await chmod(docker, 0o755);

        const result = spawnSync(
            "bash",
            [
                "ops/collect-console-effective-gateway-evidence.sh",
                "1Panel-openresty-FOpM",
                "pi.ganjiuwanshi.com",
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                    ...process.env,
                    FAKE_CONFIG: config,
                    PATH: `${binaries}:${process.env.PATH ?? ""}`,
                },
            },
        );

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "effective_configuration_source_marker_invalid",
        });
        expect(result.stdout).not.toContain("auth_basic off");
    });

    it("rejects an unmapped container source changed after the second dump", async () => {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-effective-gateway-drift-"),
        );
        directories.push(root);
        const binaries = path.join(root, "bin");
        const config = path.join(root, "internal.conf");
        const digestCount = path.join(root, "digest-count");
        await mkdir(binaries);
        await writeFile(config, "location / {}\n");
        const docker = path.join(binaries, "docker");
        await writeFile(
            docker,
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = exec ]; then
    case "$3" in
        openresty)
            printf '# configuration file /usr/local/openresty/nginx/conf/internal.conf:\n'
            cat "$FAKE_CONFIG"
            printf '\n'
            ;;
        readlink)
            printf '%s\n' "$5"
            ;;
        sha256sum)
            count=0
            if [ -f "$FAKE_DIGEST_COUNT" ]; then count="$(< "$FAKE_DIGEST_COUNT")"; fi
            count=$((count + 1))
            printf '%s\n' "$count" > "$FAKE_DIGEST_COUNT"
            if [ "$count" -eq 1 ]; then
                /sbin/sha256sum "$FAKE_CONFIG"
            else
                printf '%064d  %s\n' 0 "$4"
            fi
            ;;
        *) exit 2 ;;
    esac
else
    printf '[]\n'
fi
`,
        );
        await chmod(docker, 0o755);

        const result = spawnSync(
            "bash",
            [
                "ops/collect-console-effective-gateway-evidence.sh",
                "1Panel-openresty-FOpM",
                "pi.ganjiuwanshi.com",
            ],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                    ...process.env,
                    FAKE_CONFIG: config,
                    FAKE_DIGEST_COUNT: digestCount,
                    PATH: `${binaries}:${process.env.PATH ?? ""}`,
                },
            },
        );

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "effective_configuration_changed",
        });
    });
});
