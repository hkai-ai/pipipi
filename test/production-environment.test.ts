import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePositiveInteger } from "../src/app/config.js";
import { createProductionSkillBindings } from "../src/app/runtime-skills.js";
import { productionCatalog } from "../src/processes/catalog.js";
import type { ProductionEnvironment } from "../src/processes/production.js";

const baseEnvironment: ProductionEnvironment = Object.freeze({
    BUSINESS_API_BASE_URL: "https://business.example",
});

/**
 * Production Compose fixes this on the container and the release runbook
 * forbids it in `.env`, so the `.env` tooling deliberately does not list it.
 */
const composeOwned: ReadonlySet<string> = new Set([
    "CRT_BUSINESS_API_BASE_URL",
]);

const declared = productionCatalog.map((process) => ({
    id: process.id,
    variables: [...process.environment],
}));

describe("production Process environment declarations", () => {
    it.each(productionCatalog.map((process) => [process.id, process] as const))(
        "%s declares exactly the variables it reads",
        (_id, process) => {
            const read = new Set<string>();
            const environment = new Proxy(baseEnvironment, {
                get(target, key) {
                    if (typeof key === "string") read.add(key);
                    return Reflect.get(target, key);
                },
            });
            const skills =
                createProductionSkillBindings(baseEnvironment)[process.id] ??
                [];

            process.installedSkills(environment);
            const registration = process.build({
                environment,
                pi: {},
                skills,
                positiveInteger: (name, fallback) =>
                    parsePositiveInteger(environment[name], fallback, name),
            });

            expect(registration.identity.id).toBe(process.id);
            expect([...read].sort()).toEqual([...process.environment].sort());
            expect(new Set(process.environment).size).toBe(
                process.environment.length,
            );
        },
    );

    it("documents every declared variable in .env.example", () => {
        const documented = new Set(
            readFileSync(".env.example", "utf8")
                .split("\n")
                .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
                .filter((name): name is string => name !== undefined),
        );

        expect(missingFrom(documented)).toEqual([]);
    });

    it("lets the async production tooling pass every declared variable through", () => {
        const inspection = readFileSync(
            "ops/inspect-async-production-prerequisites.sh",
            "utf8",
        );
        const provisioning = readFileSync(
            "ops/provision-async-production-environments.sh",
            "utf8",
        );
        const lists = {
            "inspect api": shellWords(
                /\bapi\)\s*allowed="([^"]*)"/.exec(inspection)?.[1],
            ),
            "inspect process-worker": shellWords(
                /\bprocess-worker\)\s*allowed="([^"]*)"/.exec(inspection)?.[1],
            ),
            "provision agent_keys": shellWords(
                /agent_keys=\(([^)]*)\)/.exec(provisioning)?.[1],
            ),
        };

        for (const [name, list] of Object.entries(lists)) {
            expect(list.size, name).toBeGreaterThan(0);
            expect(missingFrom(list, composeOwned), name).toEqual([]);
        }
    });
});

function missingFrom(
    known: ReadonlySet<string>,
    ignored: ReadonlySet<string> = new Set(),
): string[] {
    return declared.flatMap(({ id, variables }) =>
        variables
            .filter((name) => !ignored.has(name) && !known.has(name))
            .map((name) => `${id}: ${name}`),
    );
}

function shellWords(block: string | undefined): Set<string> {
    return new Set(block?.split(/\s+/).filter(Boolean) ?? []);
}
