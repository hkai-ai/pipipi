import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createProductionSkillBindings } from "../src/app/runtime-skills.js";

const skillPathVariables = [
    "PI_SKILL_DIRECTORY",
    "PI_POSTER_SKILL_DIRECTORY",
    "PI_CRT_SKILL_DIRECTORY",
    "PI_PALE_WATERCOLOR_SKILL_DIRECTORY",
    "PI_RAW_HUMANISM_SKILL_DIRECTORY",
    "PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY",
] as const;

describe("production Runtime Skill bindings", () => {
    it("binds every Process only to its fixed installed Skill versions", () => {
        const bindings = createProductionSkillBindings({}, process.cwd());

        expect(
            Array.from(bindings)
                .filter(([process]) => process.id === "template-from-image")
                .map(([, refs]) =>
                    refs.map(({ name, version }) => `${name}@${version}`),
                ),
        ).toEqual([
            ["meme-template-json-compiler@v1.13"],
            ["meme-template-json-compiler@v1.13"],
            ["print-design-template-compiler@v1"],
        ]);
        expect(
            Object.fromEntries(
                Array.from(bindings)
                    .filter(([process]) => process.id !== "template-from-image")
                    .map(([process, refs]) => [
                        process.id,
                        refs.map(({ name, version }) => `${name}@${version}`),
                    ]),
            ),
        ).toEqual({
            "template-image-plan": ["template-image-preparer@v3"],
            "dopamine-photo-poster": ["dopamine-photo-poster-prompt@v1"],
            "photo-doodle-collage": ["photo-doodle-collage-prompt@v1"],
            "photo-fashion-manga": ["photo-fashion-manga-prompt@v1"],
            "manga-panels": ["manga-panels-prompt@v1"],
            "memory-checklist-photo-poster": [
                "memory-checklist-photo-poster-prompt@v1",
            ],
            "risograph-album": ["risograph-album-prompt@v1"],
            "character-emoji": [
                "character-emoji-planner@v18",
                "character-emoji-single@v4",
                "character-emoji-comic@v6",
            ],
            "mono-color-photo-poster": ["mono-color-photo-poster-prompt@v1"],
            "travel-abstraction-photo-poster": [
                "travel-abstraction-photo-poster-prompt@v1",
            ],
            "crayon-photo-poster": ["crayon-photo-poster-prompt@v1"],
            "monochrome-photo-poster": ["monochrome-photo-poster-prompt@v1"],
            "woodcut-photo-poster": ["woodcut-photo-poster-prompt@v1"],
            "minimal-zine-poster": ["minimal-zine-poster-prompt@v1"],
            "crt-interface-image": ["tait-crt-interface-prompt@v1"],
            "news-image-pale-watercolor": [
                "news-image-pale-watercolor-prompt@v1",
            ],
            "news-image-raw-humanism": ["news-image-raw-humanism-prompt@v1"],
            "news-image-narrative-monument": [
                "news-image-narrative-monument-prompt@v1",
            ],
        });
    });

    it("makes API deployment preflight fail safely on an invalid Skill override", () => {
        const environment = cleanEnvironment();
        environment.CRT_BUSINESS_API_BASE_URL = "https://images.example";
        environment.PI_POSTER_SKILL_DIRECTORY = "/missing/poster-snapshot";

        const result = runPreflight("api", environment);

        expect(result.status).toBe(1);
        expect(result.stderr.trim()).toBe(
            '{"event":"deployment_runtime_skill_check_failed","role":"api"}',
        );
        expect(result.stderr).not.toContain("/missing/poster-snapshot");
    });

    it("keeps non-Agent deployment roles independent from Runtime Skills", () => {
        const environment = cleanEnvironment();
        environment.DATABASE_URL =
            "postgres://service:placeholder@db.example/pipipi";
        environment.PI_POSTER_SKILL_DIRECTORY = "/missing/poster-snapshot";

        const result = runPreflight("retention-cleaner", environment);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
            '"event":"deployment_environment_check_passed"',
        );
    });
});

function cleanEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...process.env };
    for (const name of skillPathVariables) delete environment[name];
    return environment;
}

function runPreflight(role: string, environment: NodeJS.ProcessEnv) {
    return spawnSync(
        process.execPath,
        ["--import", "tsx", "src/bin/check-deployment-environment.ts", role],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: environment,
        },
    );
}
