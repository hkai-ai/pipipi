/** Process 模块自带的生产装配契约：声明安装的 Runtime Skill、启用条件与依赖的 Member Process，并从启动环境构造自己的 Registration */
import type { OpenAIApiMode } from "../agent-runtime/pi.js";
import type { InstalledSkillRef, SkillRef } from "../agent-runtime/skills.js";
import {
    createProcessRegistry,
    type ProcessAttemptRunner,
    type ProcessIdentity,
    type ProcessRegistration,
    type ProcessRegistry,
} from "../process-runtime/index.js";

export type ProductionEnvironment = Readonly<
    Record<string, string | undefined>
>;

/** Pi model selection shared by every Agent-backed production Process. */
export type PiAgentConfig = Readonly<{
    provider?: string;
    model?: string;
    openAIBaseUrl?: string;
    openAIApiMode?: OpenAIApiMode;
    agentDir?: string;
}>;

/**
 * The already-built Processes a composing Process may run, together with the
 * governed entry point for running them. The Composition Root builds the
 * Attempt Runner with the shared log Sink and default time limit, so a Step
 * run through it lands in the same timeline as a top-level Run would.
 */
export type ProductionMembers = Readonly<{
    registry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
}>;

/** What the Composition Root hands one Process so it can build itself. */
export type ProductionContext = Readonly<{
    environment: ProductionEnvironment;
    pi: PiAgentConfig;
    /** This Process's installed Skills, resolved to exact versions. */
    skills: readonly SkillRef[];
    /** Exactly the Members this Process declared; empty when it declared none. */
    members: ProductionMembers;
    /** Reads an optional positive-integer variable, naming it on error. */
    positiveInteger: (name: string, fallback: number) => number;
}>;

/**
 * One production Process as the explicit catalog lists it. `installedSkills`
 * runs before any Adapter exists so deployment preflight can validate every
 * Skill; `build` runs once at startup and must return a Registration whose id
 * equals `id`. `environment` names every startup variable the Process itself
 * reads through `enabled`, `installedSkills` or `build` (the shared Pi
 * selection is the Composition Root's); tests hold `.env.example` and the
 * deployment tooling to that list.
 *
 * `enabled` lets a release ship a Process switched off: a disabled Process is
 * neither built nor has its Skills validated. `members` names the other
 * catalog entries this Process runs; they are built first and handed over in
 * `context.members`. A Member must itself declare no Members, so composition
 * stays one level deep.
 */
export type ProductionProcess = Readonly<{
    id: string;
    environment: readonly string[];
    enabled: (environment: ProductionEnvironment) => boolean;
    members: readonly ProcessIdentity[];
    installedSkills: (
        environment: ProductionEnvironment,
    ) => readonly InstalledSkillRef[];
    build: (context: ProductionContext) => ProcessRegistration;
}>;

export function defineProductionProcess(options: {
    id: string;
    environment?: readonly string[];
    enabled?: ProductionProcess["enabled"];
    members?: readonly ProcessIdentity[];
    installedSkills?: ProductionProcess["installedSkills"];
    build: ProductionProcess["build"];
}): ProductionProcess {
    const members = Object.freeze(
        (options.members ?? []).map(({ id, version }) =>
            Object.freeze({ id, version }),
        ),
    );
    const seen = new Set<string>();
    for (const member of members) {
        const identity = formatIdentity(member);
        if (member.id === options.id) {
            throw new Error(
                `Production Process "${options.id}" cannot be its own Member`,
            );
        }
        if (seen.has(identity)) {
            throw new Error(
                `Production Process "${options.id}" declares Member "${identity}" twice`,
            );
        }
        seen.add(identity);
    }
    return Object.freeze({
        id: options.id,
        environment: Object.freeze([...(options.environment ?? [])]),
        enabled: options.enabled ?? (() => true),
        members,
        installedSkills: options.installedSkills ?? (() => noSkills),
        build: options.build,
    });
}

/** The catalog entries this environment switches on, in catalog order. */
export function enabledProductionProcesses(
    catalog: readonly ProductionProcess[],
    environment: ProductionEnvironment,
): readonly ProductionProcess[] {
    return Object.freeze(
        catalog.filter((process) => process.enabled(environment)),
    );
}

export type ProductionBuildOptions = Readonly<{
    catalog: readonly ProductionProcess[];
    environment: ProductionEnvironment;
    pi: PiAgentConfig;
    /** Resolved Skill refs keyed by Process id; absent means no Skills. */
    skills: Readonly<Record<string, readonly SkillRef[]>>;
    positiveInteger: ProductionContext["positiveInteger"];
    /** Runs Member Steps under the same governance as top-level Attempts. */
    attemptRunner: ProcessAttemptRunner;
}>;

/**
 * Builds every enabled catalog entry in two phases: first the Processes that
 * declare no Members, then the Processes that compose them. A Member must be
 * an enabled, Member-free entry of the same catalog; anything else fails at
 * startup rather than at the first request.
 */
export function buildProductionRegistrations(
    options: ProductionBuildOptions,
): readonly ProcessRegistration[] {
    const enabled = enabledProductionProcesses(
        options.catalog,
        options.environment,
    );
    const standalone = enabled.filter(
        (process) => process.members.length === 0,
    );
    const composing = enabled.filter((process) => process.members.length > 0);
    const emptyMembers: ProductionMembers = Object.freeze({
        registry: createProcessRegistry([]),
        attemptRunner: options.attemptRunner,
    });

    const build = (
        process: ProductionProcess,
        members: ProductionMembers,
    ): ProcessRegistration => {
        const registration = process.build({
            environment: options.environment,
            pi: options.pi,
            skills: options.skills[process.id] ?? [],
            members,
            positiveInteger: options.positiveInteger,
        });
        if (registration.identity.id !== process.id) {
            throw new Error(
                `Production Process "${process.id}" built Registration "${registration.identity.id}"`,
            );
        }
        return registration;
    };

    const built = standalone.map((process) => build(process, emptyMembers));
    const builtRegistry = createProcessRegistry(built);
    const composed = composing.map((process) => {
        const memberRegistrations = process.members.map((member) => {
            const registration = builtRegistry.find(member);
            if (!registration) {
                throw new Error(
                    `Production Process "${process.id}" declares Member "${formatIdentity(member)}" which is not an enabled standalone Process`,
                );
            }
            return registration;
        });
        return build(
            process,
            Object.freeze({
                registry: createProcessRegistry(memberRegistrations),
                attemptRunner: options.attemptRunner,
            }),
        );
    });

    return Object.freeze([...built, ...composed]);
}

function formatIdentity(identity: ProcessIdentity): string {
    return `${identity.id}/${identity.version}`;
}

const noSkills: readonly InstalledSkillRef[] = Object.freeze([]);
