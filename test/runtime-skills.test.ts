import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInstalledSkillCatalog } from "../src/agent-runtime/catalog.js";
import { createSkillSet } from "../src/agent-runtime/skills.js";
import {
    contentToolName,
    createContentSkillRefs,
} from "../src/processes/content/skills.js";
import {
    createCrtSkillRefs,
    crtSkillName,
} from "../src/processes/crt/skills.js";
import {
    createNarrativeMonumentSkillRefs,
    createPaleWatercolorSkillRefs,
    createRawHumanismSkillRefs,
} from "../src/processes/news-image/skills.js";
import {
    createPosterSkillRefs,
    posterSkillName,
} from "../src/processes/poster/skills.js";

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
        const refs = createContentSkillRefs();
        const loaded = createSkillSet(refs, process.cwd()).load();

        expect(loaded.names).toEqual([
            "content-optimization",
            "content-integrity",
        ]);
        expect(loaded.instructions).toContain(contentToolName);
        expect(loaded.instructions).toContain(
            "Preserve names, numbers, dates, links, claims, and the author's intent.",
        );

        const dockerfile = readFileSync("Dockerfile", "utf8");
        const dockerignore = readFileSync(".dockerignore", "utf8");
        for (const ref of refs) {
            expect(dockerfile).toContain(
                `COPY --chown=node:node ${ref.path} ./${ref.path}`,
            );
            expect(dockerignore).toContain(`!${ref.path}/**`);
        }
    });

    it("only lets production configuration replace the optimization path", () => {
        const defaults = createContentSkillRefs();
        expect(
            createContentSkillRefs({
                optimizationPath: "/reviewed/content-optimization",
            }),
        ).toEqual([
            {
                ...defaults[0],
                path: "/reviewed/content-optimization",
            },
            defaults[1],
        ]);
    });

    it("loads the reviewed prompt-only Skill for minimal-zine-poster/v1", () => {
        const refs = createPosterSkillRefs();
        const loaded = createSkillSet(refs, process.cwd()).load();

        expect(loaded.names).toEqual([posterSkillName]);
        expect(loaded.instructions).toContain(
            "This Runtime Skill performs prompt compilation only.",
        );
        expect(loaded.instructions).toContain(
            "Do not generate an image, invoke a Tool, read files, access the network",
        );
        expect(loaded.instructions).toContain(
            "exactly four compact paragraphs",
        );

        const ref = refs[0];
        expect(ref).toBeDefined();
        if (!ref) throw new Error("Poster Skill ref is unavailable");
        expect(readdirSync(ref.path).sort()).toEqual([
            "LICENSE",
            "SKILL.md",
            "SOURCE.md",
        ]);
        expect(readFileSync("Dockerfile", "utf8")).toContain(
            `COPY --chown=node:node ${ref.path} ./${ref.path}`,
        );
        expect(readFileSync(".dockerignore", "utf8")).toContain(
            `!${ref.path}/**`,
        );
    });

    it("records the immutable upstream poster Skill hash", () => {
        const upstream = readFileSync(
            ".agents/skills/gc-minimal-zine-poster-v0-1/SKILL.md",
            "utf8",
        ).replace(/\r\n/gu, "\n");
        const digest = createHash("sha256").update(upstream).digest("hex");
        const lock = JSON.parse(readFileSync("skills-lock.json", "utf8")) as {
            skills: Record<string, { computedHash?: string }>;
        };
        const provenance = readFileSync(
            ".pi/skills/minimal-zine-poster-prompt/SOURCE.md",
            "utf8",
        );

        expect(lock.skills["gc-minimal-zine-poster-v0-1"]?.computedHash).toBe(
            digest,
        );
        expect(provenance).toContain(digest);
    });

    it("only lets production configuration replace the poster Skill path", () => {
        const [installed] = createPosterSkillRefs();
        expect(
            createPosterSkillRefs({ path: "/reviewed/poster-prompt" }),
        ).toEqual([
            {
                ...installed,
                path: "/reviewed/poster-prompt",
            },
        ]);
    });

    it("loads the reviewed prompt-only Skill for crt-interface-image/v1", () => {
        const refs = createCrtSkillRefs();
        const loaded = createSkillSet(refs, process.cwd()).load();

        expect(loaded.names).toEqual([crtSkillName]);
        expect(loaded.instructions).toContain(
            "This Runtime Skill performs prompt compilation only.",
        );
        expect(loaded.instructions).toContain(
            "Do not inspect an image, invoke a Tool, read files, access the network",
        );
        expect(loaded.instructions).toContain("tait-crt-interface-skill");

        const ref = refs[0];
        expect(ref).toBeDefined();
        if (!ref) throw new Error("CRT Skill ref is unavailable");
        expect(readdirSync(ref.path).sort()).toEqual(["SKILL.md", "SOURCE.md"]);
        expect(readFileSync("Dockerfile", "utf8")).toContain(
            `COPY --chown=node:node ${ref.path} ./${ref.path}`,
        );
        expect(readFileSync(".dockerignore", "utf8")).toContain(
            `!${ref.path}/**`,
        );
    });

    it("records the immutable upstream CRT Skill identity and license gate", () => {
        const digest =
            "b3f9bbab118e839a5ae7e79f3406e8bebd3383e3f3ad18c8ed91b9efa30c04a9";
        const lock = JSON.parse(readFileSync("skills-lock.json", "utf8")) as {
            skills: Record<string, { computedHash?: string }>;
        };
        const provenance = readFileSync(
            ".pi/skills/tait-crt-interface-prompt/SOURCE.md",
            "utf8",
        );

        expect(lock.skills["tait-crt-interface-skill"]?.computedHash).toBe(
            digest,
        );
        expect(provenance).toContain(
            "972a99bc85f725537bddadae6a6cea53516470f2",
        );
        expect(provenance).toContain(digest);
        expect(provenance).toContain("not declared (`NOASSERTION`)");
    });

    it("only lets production configuration replace the CRT Skill path", () => {
        const [installed] = createCrtSkillRefs();
        expect(createCrtSkillRefs({ path: "/reviewed/crt-prompt" })).toEqual([
            {
                ...installed,
                path: "/reviewed/crt-prompt",
            },
        ]);
    });
});

describe("Installed Runtime Skill catalog", () => {
    it("validates all code-defined production installations", () => {
        const catalog = createInstalledSkillCatalog(
            [
                ...createContentSkillRefs(),
                ...createPosterSkillRefs(),
                ...createCrtSkillRefs(),
                ...createPaleWatercolorSkillRefs(),
                ...createRawHumanismSkillRefs(),
                ...createNarrativeMonumentSkillRefs(),
            ],
            process.cwd(),
        );

        expect(
            catalog.list().map(({ name, version }) => `${name}@${version}`),
        ).toEqual([
            "content-integrity@v1",
            "content-optimization@v1",
            "minimal-zine-poster-prompt@v1",
            "news-image-narrative-monument-prompt@v1",
            "news-image-pale-watercolor-prompt@v1",
            "news-image-raw-humanism-prompt@v1",
            "tait-crt-interface-prompt@v1",
        ]);
    });

    it("validates installations eagerly and resolves exact versions", async () => {
        const root = await createTempRoot();
        await Promise.all([
            writeSkill(root, "clarity", "clarity", "Keep wording clear."),
            writeSkill(root, "integrity", "integrity", "Preserve facts."),
        ]);
        const clarity = installedSkill(root, "clarity", "clarity");
        const integrity = installedSkill(root, "integrity", "integrity");

        const catalog = createInstalledSkillCatalog(
            [integrity, clarity],
            process.cwd(),
        );

        expect(catalog.list()).toEqual([
            {
                name: "clarity",
                version: "v1",
                sha256: clarity.sha256,
            },
            {
                name: "integrity",
                version: "v1",
                sha256: integrity.sha256,
            },
        ]);
        expect(
            catalog.resolve([
                { name: "integrity", version: "v1" },
                { name: "clarity", version: "v1" },
            ]),
        ).toEqual([
            { ...integrity, path: join(root, "integrity") },
            { ...clarity, path: join(root, "clarity") },
        ]);
    });

    it("rejects modified installed content during construction", async () => {
        const root = await createTempRoot();
        await writeSkill(root, "clarity", "clarity", "Keep wording clear.");
        const installed = installedSkill(root, "clarity", "clarity");

        expect(() =>
            createInstalledSkillCatalog(
                [{ ...installed, sha256: "0".repeat(64) }],
                process.cwd(),
            ),
        ).toThrow(
            'Runtime Skill "clarity@v1" failed its SHA-256 integrity check',
        );
    });

    it("rejects unavailable versions without falling back", async () => {
        const root = await createTempRoot();
        await writeSkill(root, "clarity", "clarity", "Keep wording clear.");
        const catalog = createInstalledSkillCatalog(
            [installedSkill(root, "clarity", "clarity")],
            process.cwd(),
        );

        expect(() =>
            catalog.resolve([{ name: "clarity", version: "v2" }]),
        ).toThrow('Installed Runtime Skill "clarity@v2" is unavailable');
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

function installedSkill(root: string, directory: string, name: string) {
    const path = join(root, directory);
    const source = readFileSync(join(path, "SKILL.md"), "utf8");
    return {
        name,
        version: "v1",
        sha256: createHash("sha256").update(source).digest("hex"),
        path,
    } as const;
}
