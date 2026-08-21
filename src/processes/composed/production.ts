/** composed-task/v1 的生产装配：按开关启用，绑定 Planner Skill，把已构造的 Member 包装成 Step Tool */
import {
    defineProductionProcess,
    type ProductionEnvironment,
} from "../production.js";
import { PiComposedAgent } from "./agent.pi.js";
import { composedMembers, memberIdentities } from "./members.js";
import { createComposedRegistration } from "./registration.js";
import { createComposedSkillRefs } from "./skills.js";
import { createProcessToolSet } from "./tools.js";

export const composedProduction = defineProductionProcess({
    id: "composed-task",
    environment: [
        "COMPOSED_TASK_ENABLED",
        "COMPOSED_TASK_MAX_STEPS",
        "COMPOSED_TASK_MAX_PRICED_STEPS",
        "COMPOSED_TASK_TIMEOUT_MS",
        "PI_COMPOSED_SKILL_DIRECTORY",
    ],
    enabled: (environment) =>
        parseFlag(environment.COMPOSED_TASK_ENABLED, "COMPOSED_TASK_ENABLED"),
    members: memberIdentities(composedMembers),
    installedSkills: (environment) =>
        createComposedSkillRefs({
            path: environment.PI_COMPOSED_SKILL_DIRECTORY,
        }),
    build: ({ environment, pi, skills, members, positiveInteger }) =>
        createComposedRegistration({
            agent: new PiComposedAgent({ skills, ...pi }),
            toolSet: createProcessToolSet({
                members: composedMembers,
                registry: members.registry,
                attemptRunner: members.attemptRunner,
            }),
            limits: {
                maxSteps: positiveInteger("COMPOSED_TASK_MAX_STEPS", 6),
                maxPricedSteps: parseNonNegativeInteger(
                    environment,
                    "COMPOSED_TASK_MAX_PRICED_STEPS",
                    2,
                ),
                timeoutMs: positiveInteger("COMPOSED_TASK_TIMEOUT_MS", 600_000),
            },
        }),
});

function parseFlag(value: string | undefined, name: string): boolean {
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error(`${name} must be true or false`);
}

function parseNonNegativeInteger(
    environment: ProductionEnvironment,
    name: string,
    fallback: number,
): number {
    const value = environment[name];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return parsed;
}
