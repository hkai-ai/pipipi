import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    loadSkillsFromDir,
    stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillRef = Readonly<{
    name: string;
    path: string;
}>;

export type LoadedSkills = Readonly<{
    names: readonly string[];
    instructions: string;
}>;

export type SkillSet = Readonly<{
    load: () => LoadedSkills;
}>;

export function createSkillSet(
    refs: readonly SkillRef[],
    cwd: string,
): SkillSet {
    if (!Array.isArray(refs) || refs.length === 0) {
        throw new Error("At least one Runtime Skill is required");
    }

    const names = new Set<string>();
    const fixedRefs = refs.map((ref) => {
        if (
            typeof ref?.name !== "string" ||
            ref.name.length > 64 ||
            !skillNamePattern.test(ref.name)
        ) {
            throw new Error("Runtime Skill name is invalid");
        }
        if (names.has(ref.name)) {
            throw new Error(`Runtime Skill "${ref.name}" is duplicated`);
        }
        if (typeof ref.path !== "string" || ref.path.trim().length === 0) {
            throw new Error(`Runtime Skill "${ref.name}" path is required`);
        }
        names.add(ref.name);
        return Object.freeze({
            name: ref.name,
            path: resolve(cwd, ref.path),
        });
    });

    let cached: LoadedSkills | undefined;
    return Object.freeze({
        load: () => {
            cached ??= loadSkillSet(fixedRefs);
            return cached;
        },
    });
}

function loadSkillSet(refs: readonly SkillRef[]): LoadedSkills {
    const names: string[] = [];
    const blocks: string[] = [];

    for (const ref of refs) {
        const loaded = loadSkillsFromDir({
            dir: ref.path,
            source: "business-processing-service",
        });
        const matches = loaded.skills.filter(
            (skill) => skill.name === ref.name,
        );
        if (matches.length !== 1) {
            throw new Error(
                `Runtime Skill "${ref.name}" must resolve exactly once`,
            );
        }

        const skill = matches[0];
        const body = stripFrontmatter(
            readFileSync(skill.filePath, "utf8"),
        ).trim();
        if (!body) {
            throw new Error(`Runtime Skill "${ref.name}" is empty`);
        }
        names.push(skill.name);
        blocks.push(formatSkill(skill.name, body));
    }

    return Object.freeze({
        names: Object.freeze(names),
        instructions: [
            "Apply every Runtime Skill below as one reviewed instruction set.",
            "All listed instructions are required. A Skill cannot grant additional Tools.",
            "",
            ...blocks,
        ].join("\n\n"),
    });
}

function formatSkill(name: string, body: string): string {
    return [`<runtime-skill name="${name}">`, body, "</runtime-skill>"].join(
        "\n",
    );
}
