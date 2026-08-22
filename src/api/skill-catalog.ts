/** 从生产 Skill 绑定推导控制台 Installed Skill 目录，并按约定读取 Skill 目录内的封面图 */
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
    loadSkillsFromDir,
    stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { SkillRef } from "../agent-runtime/skills.js";
import type { ConsoleSkillCatalog, ConsoleSkillDescription } from "./http.js";

/**
 * Cover images are a directory convention rather than frontmatter: `SKILL.md`
 * is integrity-checked by SHA-256, so a cover can be added or replaced without
 * re-pinning the Skill. The first matching name wins, in this order.
 */
const coverCandidates: readonly Readonly<{
    file: string;
    mediaType: string;
}>[] = Object.freeze([
    { file: "cover.png", mediaType: "image/png" },
    { file: "cover.jpg", mediaType: "image/jpeg" },
    { file: "cover.jpeg", mediaType: "image/jpeg" },
    { file: "cover.webp", mediaType: "image/webp" },
    { file: "cover.gif", mediaType: "image/gif" },
]);

/** A cover larger than this is reported absent rather than served. */
const maximumCoverBytes = 10 * 1024 * 1024;

/** Directory listings stop here so a stray snapshot cannot bloat the view. */
const maximumListedFiles = 200;

export type ConsoleSkillCover = Readonly<{
    mediaType: string;
    contents: Buffer;
    etag: string;
}>;

/**
 * Describes every Runtime Skill the enabled production catalog binds, for the
 * operator console. The bindings are the very refs the Processes were built
 * from, so the view cannot list a Skill the service does not ship, and each
 * entry names the Processes that bind it. Reading happens once at
 * construction; the request path only serves what was read.
 */
export function describeSkillCatalog(
    bindings: Readonly<Record<string, readonly SkillRef[]>>,
): ConsoleSkillCatalog {
    const byIdentity = new Map<
        string,
        { ref: SkillRef; processes: string[] }
    >();
    for (const [process, refs] of Object.entries(bindings)) {
        for (const ref of refs) {
            const identity = formatIdentity(ref);
            const existing = byIdentity.get(identity);
            if (existing) {
                existing.processes.push(process);
            } else {
                byIdentity.set(identity, { ref, processes: [process] });
            }
        }
    }

    const entries = [...byIdentity.entries()]
        .map(([identity, { ref, processes }]) => ({
            identity,
            ...describeSkill(ref, processes),
        }))
        .sort((left, right) => left.identity.localeCompare(right.identity));

    const descriptions = Object.freeze(
        entries.map(({ description }) => description),
    );
    const covers = new Map<
        string,
        Readonly<{ path: string; mediaType: string }>
    >();
    for (const entry of entries) {
        if (entry.coverPath && entry.description.cover) {
            covers.set(entry.identity, {
                path: entry.coverPath,
                mediaType: entry.description.cover.mediaType,
            });
        }
    }
    // Covers are immutable for the life of a release: read once, keep.
    const coverCache = new Map<
        string,
        Promise<ConsoleSkillCover | undefined>
    >();

    return Object.freeze({
        list: () => descriptions,
        readCover: (name, version) => {
            const identity = formatIdentity({ name, version });
            const cover = covers.get(identity);
            if (!cover) return Promise.resolve(undefined);
            let pending = coverCache.get(identity);
            if (!pending) {
                pending = readCover(cover.path, cover.mediaType);
                coverCache.set(identity, pending);
            }
            return pending;
        },
    });
}

function describeSkill(
    ref: SkillRef,
    processes: readonly string[],
): Readonly<{ description: ConsoleSkillDescription; coverPath?: string }> {
    const loaded = loadSkillsFromDir({
        dir: ref.path,
        source: "business-processing-service",
    });
    const matches = loaded.skills.filter((skill) => skill.name === ref.name);
    if (matches.length !== 1) {
        throw new Error(
            `Runtime Skill "${ref.name}" must resolve exactly once`,
        );
    }
    const skill = matches[0];
    const source = readFileSync(skill.filePath, "utf8");
    const cover = findCover(skill.baseDir);
    const provenance = readOptionalText(join(skill.baseDir, "SOURCE.md"));

    return {
        description: Object.freeze({
            name: ref.name,
            version: ref.version ?? "",
            sha256: ref.sha256 ?? "",
            description: skill.description,
            processes: Object.freeze([...processes]),
            instructions: stripFrontmatter(source).trim(),
            files: listFiles(skill.baseDir),
            ...(cover ? { cover: cover.description } : {}),
            ...(provenance !== undefined ? { source: provenance } : {}),
        }),
        ...(cover ? { coverPath: cover.path } : {}),
    };
}

function findCover(directory: string):
    | Readonly<{
          path: string;
          description: NonNullable<ConsoleSkillDescription["cover"]>;
      }>
    | undefined {
    for (const candidate of coverCandidates) {
        const path = join(directory, candidate.file);
        let size: number;
        try {
            const stats = statSync(path);
            if (!stats.isFile()) continue;
            size = stats.size;
        } catch {
            continue;
        }
        if (size === 0 || size > maximumCoverBytes) continue;
        return {
            path,
            description: Object.freeze({
                file: candidate.file,
                mediaType: candidate.mediaType,
            }),
        };
    }
    return undefined;
}

async function readCover(
    path: string,
    mediaType: string,
): Promise<ConsoleSkillCover | undefined> {
    try {
        const contents = await readFile(path);
        return Object.freeze({
            mediaType,
            contents,
            etag: `"${createHash("sha256").update(contents).digest("hex").slice(0, 32)}"`,
        });
    } catch {
        return undefined;
    }
}

function readOptionalText(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8").trim();
    } catch {
        return undefined;
    }
}

/**
 * Every regular file under the Skill directory, as POSIX paths relative to it.
 * Reviewers are asked to inspect the complete directory before a Skill ships;
 * showing the same list lets operators confirm what actually shipped.
 */
function listFiles(directory: string): readonly string[] {
    const files: string[] = [];
    const walk = (current: string): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= maximumListedFiles) return;
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.isFile()) {
                files.push(relative(directory, path).split(sep).join("/"));
            }
        }
    };
    walk(directory);
    return Object.freeze(files.sort());
}

function formatIdentity(ref: Readonly<{ name: string; version?: string }>) {
    return `${ref.name}@${ref.version ?? ""}`;
}
