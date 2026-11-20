import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([
    "minimal-zine-poster-prompt",
    "composed-task-planner",
    "meme-template-json-compiler",
])(
    "upgrades, repeats, and rolls back %s and its binding together",
    (name) => {
        const temp = mkdtempSync(join(tmpdir(), "poster-sync-test-"));
        const source = join(temp, "source");
        const consumer = join(temp, "consumer");
        const original = resolve(".pi/skills", name);
        const snapshot = join(consumer, ".pi/skills", name);
        const lockPath = join(consumer, "src/agent-runtime/skill-lock.json");
        const git = (cwd: string, ...args: string[]) =>
            execFileSync(
                "git",
                [
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "commit.gpgSign=false",
                    "-c",
                    "tag.gpgSign=false",
                    ...args,
                ],
                { cwd },
            );
        const sync = (version: string) =>
            execFileSync(
                process.execPath,
                [
                    "--import",
                    import.meta.resolve("tsx"),
                    resolve("tools/sync-skill.mjs"),
                    name,
                    version,
                ],
                { cwd: consumer, stdio: "pipe" },
            );
        try {
            cpSync(original, join(source, "skills", name), { recursive: true });
            cpSync(original, snapshot, { recursive: true });
            mkdirSync(dirname(lockPath), { recursive: true });
            git(source, "init", "-q");
            git(source, "add", "skills");
            git(source, "commit", "-qm", "baseline");
            git(source, "tag", `${name}/v1`);
            git(consumer, "init", "-q");
            git(
                consumer,
                "config",
                `url.${source}.insteadOf`,
                "git@github.com:hkai-ai/skills.git",
            );
            const baselineLock = JSON.parse(
                readFileSync(
                    resolve("src/agent-runtime/skill-lock.json"),
                    "utf8",
                ),
            );
            baselineLock.skills[name] = {
                ...baselineLock.skills[name],
                version: "v1",
                commit: git(source, "rev-parse", "HEAD").toString().trim(),
            };
            writeFileSync(
                lockPath,
                `${JSON.stringify(baselineLock, null, 4)}\n`,
            );
            sync("v1");
            const baseline = readFileSync(lockPath, "utf8");
            appendFileSync(
                join(source, "skills", name, "SKILL.md"),
                "\nPilot revision.\n",
            );
            git(source, "commit", "-qam", "candidate");
            git(source, "tag", `${name}/v2`);
            sync("v2");
            expect(
                JSON.parse(readFileSync(lockPath, "utf8")).skills[name].version,
            ).toBe("v2");
            expect(readFileSync(join(snapshot, "SKILL.md"), "utf8")).toContain(
                "Pilot revision.",
            );
            expect(sync("v2").toString()).toContain("已是所选快照");
            sync("v1");
            expect(readFileSync(lockPath, "utf8")).toBe(baseline);
            expect(readFileSync(join(snapshot, "SKILL.md"))).toEqual(
                readFileSync(join(original, "SKILL.md")),
            );
            appendFileSync(join(snapshot, "SKILL.md"), "\nlocal edit\n");
            expect(() => sync("v2")).toThrow();
            expect(readFileSync(lockPath, "utf8")).toBe(baseline);
            expect(readFileSync(join(snapshot, "SKILL.md"), "utf8")).toContain(
                "local edit",
            );
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    },
    60_000,
);
