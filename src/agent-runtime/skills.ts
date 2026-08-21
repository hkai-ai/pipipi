/** Runtime Skill 精确加载 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    loadSkillsFromDir,
    stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skillVersionPattern = /^v(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,2}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export type SkillRef = Readonly<{
    name: string;
    path: string;
    version?: string;
    sha256?: string;
}>;

export type InstalledSkillRef = Readonly<{
    name: string;
    path: string;
    version: string;
    sha256: string;
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
        if ((ref.version === undefined) !== (ref.sha256 === undefined)) {
            throw new Error(
                `Runtime Skill "${ref.name}" version and SHA-256 must be configured together`,
            );
        }
        if (
            ref.version !== undefined &&
            !skillVersionPattern.test(ref.version)
        ) {
            throw new Error(`Runtime Skill "${ref.name}" version is invalid`);
        }
        if (ref.sha256 !== undefined && !sha256Pattern.test(ref.sha256)) {
            throw new Error(`Runtime Skill "${ref.name}" SHA-256 is invalid`);
        }
        names.add(ref.name);
        return Object.freeze({
            name: ref.name,
            path: resolve(cwd, ref.path),
            ...(ref.version ? { version: ref.version } : {}),
            ...(ref.sha256 ? { sha256: ref.sha256 } : {}),
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
        const source = readFileSync(skill.filePath, "utf8");
        if (
            ref.sha256 &&
            createHash("sha256").update(source).digest("hex") !== ref.sha256
        ) {
            throw new Error(
                `Runtime Skill "${ref.name}@${ref.version}" failed its SHA-256 integrity check`,
            );
        }
        const body = stripFrontmatter(source).trim();
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
