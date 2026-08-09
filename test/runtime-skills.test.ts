import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillSet } from "../src/processes/content/skills.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots
            .splice(0)
            .map((root) => rm(root, { recursive: true, force: true })),
    );
});

describe("Runtime Skill set", () => {
    it("requires at least one binding", () => {
        expect(() => createSkillSet([], process.cwd())).toThrow(
            "At least one Runtime Skill is required",
        );
    });

    it("loads every bound Skill in declared order", async () => {
        const root = await createTempRoot();
        await Promise.all([
            writeSkill(root, "clarity", "clarity", "Keep the wording clear."),
            writeSkill(
                root,
                "integrity",
                "integrity",
                "Preserve facts and intent.",
            ),
            writeSkill(root, "unused", "unused", "Do not load this Skill."),
        ]);

        const loaded = createSkillSet(
            [
                { name: "integrity", path: root },
                { name: "clarity", path: root },
            ],
            process.cwd(),
        ).load();

        expect(loaded.names).toEqual(["integrity", "clarity"]);
        expect(loaded.instructions).toContain("Preserve facts and intent.");
        expect(loaded.instructions).toContain("Keep the wording clear.");
        expect(loaded.instructions).not.toContain("Do not load this Skill.");
        expect(loaded.instructions.indexOf("integrity")).toBeLessThan(
            loaded.instructions.indexOf("clarity"),
        );
    });

    it("rejects duplicate bindings before loading files", () => {
        expect(() =>
            createSkillSet(
                [
                    { name: "clarity", path: "/first" },
                    { name: "clarity", path: "/second" },
                ],
                process.cwd(),
            ),
        ).toThrow('Runtime Skill "clarity" is duplicated');
    });

    it("requires each bound name to resolve exactly once", async () => {
        const root = await createTempRoot();
        await writeSkill(root, "other", "other", "Other instructions.");

        const skills = createSkillSet(
            [{ name: "missing", path: root }],
            process.cwd(),
        );

        expect(() => skills.load()).toThrow(
            'Runtime Skill "missing" must resolve exactly once',
        );
    });

    it("rejects two files that resolve to the same bound name", async () => {
        const root = await createTempRoot();
        await Promise.all([
            writeSkill(root, "first", "clarity", "First instructions."),
            writeSkill(root, "second", "clarity", "Second instructions."),
        ]);

        const skills = createSkillSet(
            [{ name: "clarity", path: root }],
            process.cwd(),
        );

        expect(() => skills.load()).toThrow(
            'Runtime Skill "clarity" must resolve exactly once',
        );
    });

    it("loads the two Skills bound to content-processing/v1", () => {
        const loaded = createSkillSet(
            [
                {
                    name: "content-optimization",
                    path: ".pi/skills/content-optimization",
                },
                {
                    name: "content-integrity",
                    path: ".pi/skills/content-integrity",
                },
            ],
            process.cwd(),
        ).load();

        expect(loaded.names).toEqual([
            "content-optimization",
            "content-integrity",
        ]);
    });
});

async function createTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "runtime-skills-"));
    temporaryRoots.push(root);
    return root;
}

async function writeSkill(
    root: string,
    directory: string,
    name: string,
    body: string,
): Promise<void> {
    const path = join(root, directory);
    await mkdir(path);
    await writeFile(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n\n${body}\n`,
    );
}
