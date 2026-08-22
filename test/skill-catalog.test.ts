import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledSkillRef } from "../src/agent-runtime/skills.js";
import { describeSkillCatalog } from "../src/api/skill-catalog.js";
import { createProductionSkillBindings } from "../src/app/runtime-skills.js";

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

describe("console Skill catalog", () => {
    it("describes each bound Skill once with the Processes that bind it", async () => {
        const root = await fixtureRoot();
        const illustrated = await writeSkill(root, {
            name: "illustrated-style",
            description: "Compile an illustrated editorial prompt.",
            body: "# Illustrated\n\nCompile only.",
            extras: {
                "cover.png": Buffer.from("png-bytes"),
                "SOURCE.md": "# Source\n\nUpstream: example\n",
                "reference/notes.txt": "notes",
            },
        });
        const plain = await writeSkill(root, {
            name: "plain-style",
            description: "Plain text processing.",
            body: "Plain body.",
        });

        const catalog = describeSkillCatalog({
            "process-a": [illustrated, plain],
            "process-b": [illustrated],
        });
        const skills = catalog.list();

        expect(skills.map((skill) => `${skill.name}@${skill.version}`)).toEqual(
            ["illustrated-style@v1", "plain-style@v1"],
        );
        expect(skills[0]).toEqual({
            name: "illustrated-style",
            version: "v1",
            sha256: illustrated.sha256,
            description: "Compile an illustrated editorial prompt.",
            processes: ["process-a", "process-b"],
            instructions: "# Illustrated\n\nCompile only.",
            files: [
                "SKILL.md",
                "SOURCE.md",
                "cover.png",
                "reference/notes.txt",
            ],
            cover: { file: "cover.png", mediaType: "image/png" },
            source: "# Source\n\nUpstream: example",
        });
        expect(skills[1]).toEqual({
            name: "plain-style",
            version: "v1",
            sha256: plain.sha256,
            description: "Plain text processing.",
            processes: ["process-a"],
            instructions: "Plain body.",
            files: ["SKILL.md"],
        });
    });

    it("serves a shipped cover with its media type and a stable ETag", async () => {
        const root = await fixtureRoot();
        const bytes = Buffer.from("webp-bytes");
        const skill = await writeSkill(root, {
            name: "webp-style",
            description: "Has a WebP cover.",
            body: "Body.",
            extras: { "cover.webp": bytes },
        });

        const catalog = describeSkillCatalog({ "process-a": [skill] });
        const cover = await catalog.readCover("webp-style", "v1");

        expect(cover?.mediaType).toBe("image/webp");
        expect(cover?.contents.equals(bytes)).toBe(true);
        expect(cover?.etag).toMatch(/^"[a-f0-9]{32}"$/);
        expect(await catalog.readCover("webp-style", "v1")).toBe(cover);
    });

    it("reports no cover for a Skill without one or outside the catalog", async () => {
        const root = await fixtureRoot();
        const skill = await writeSkill(root, {
            name: "bare-style",
            description: "No cover.",
            body: "Body.",
        });

        const catalog = describeSkillCatalog({ "process-a": [skill] });

        expect(catalog.list()[0]?.cover).toBeUndefined();
        expect(await catalog.readCover("bare-style", "v1")).toBeUndefined();
        expect(await catalog.readCover("bare-style", "v2")).toBeUndefined();
        expect(await catalog.readCover("unknown", "v1")).toBeUndefined();
    });

    it("prefers the first cover candidate and ignores an empty file", async () => {
        const root = await fixtureRoot();
        const skill = await writeSkill(root, {
            name: "ordered-style",
            description: "Two covers.",
            body: "Body.",
            extras: {
                "cover.png": Buffer.alloc(0),
                "cover.jpg": Buffer.from("jpg-bytes"),
            },
        });

        const catalog = describeSkillCatalog({ "process-a": [skill] });

        expect(catalog.list()[0]?.cover).toEqual({
            file: "cover.jpg",
            mediaType: "image/jpeg",
        });
    });

    it("describes every Runtime Skill the production catalog installs", () => {
        const catalog = describeSkillCatalog(
            createProductionSkillBindings({}, process.cwd()),
        );
        const skills = catalog.list();

        expect(skills.map((skill) => skill.name)).toEqual([
            "content-integrity",
            "content-optimization",
            "minimal-zine-poster-prompt",
            "news-image-narrative-monument-prompt",
            "news-image-pale-watercolor-prompt",
            "news-image-raw-humanism-prompt",
            "tait-crt-interface-prompt",
        ]);
        for (const skill of skills) {
            expect(skill.version).toMatch(/^v\d+/);
            expect(skill.sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(skill.description.length).toBeGreaterThan(0);
            expect(skill.instructions.length).toBeGreaterThan(0);
            expect(skill.instructions).not.toMatch(/^---/);
            expect(skill.processes.length).toBeGreaterThan(0);
            expect(skill.files).toContain("SKILL.md");
        }
    });
});

async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pipipi-skill-catalog-"));
    temporaryDirectories.push(root);
    return root;
}

async function writeSkill(
    root: string,
    options: Readonly<{
        name: string;
        description: string;
        body: string;
        extras?: Readonly<Record<string, string | Buffer>>;
    }>,
): Promise<InstalledSkillRef> {
    const directory = join(root, options.name);
    await mkdir(directory, { recursive: true });
    const source = [
        "---",
        `name: ${options.name}`,
        `description: ${options.description}`,
        "---",
        "",
        options.body,
        "",
    ].join("\n");
    await writeFile(join(directory, "SKILL.md"), source);
    for (const [file, contents] of Object.entries(options.extras ?? {})) {
        const path = join(directory, file);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, contents);
    }
    return {
        name: options.name,
        path: directory,
        version: "v1",
        sha256: createHash("sha256").update(source).digest("hex"),
    };
}
