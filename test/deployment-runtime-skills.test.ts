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
            Object.fromEntries(
                Object.entries(bindings).map(([process, refs]) => [
                    process,
                    refs.map(({ name, version }) => `${name}@${version}`),
                ]),
            ),
        ).toEqual({
            "content-processing": [
                "content-optimization@v1",
                "content-integrity@v1",
            ],
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
        environment.BUSINESS_API_BASE_URL = "https://business.example";
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
