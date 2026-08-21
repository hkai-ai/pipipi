/** Process 模块自带的生产装配契约：声明安装的 Runtime Skill，并从启动环境构造自己的 Registration */
import type { OpenAIApiMode } from "../agent-runtime/pi.js";
import type { InstalledSkillRef, SkillRef } from "../agent-runtime/skills.js";
import type { ProcessRegistration } from "../process-runtime/index.js";

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

/** What the Composition Root hands one Process so it can build itself. */
export type ProductionContext = Readonly<{
    environment: ProductionEnvironment;
    pi: PiAgentConfig;
    /** This Process's installed Skills, resolved to exact versions. */
    skills: readonly SkillRef[];
    /** Reads an optional positive-integer variable, naming it on error. */
    positiveInteger: (name: string, fallback: number) => number;
}>;

/**
 * One production Process as the explicit catalog lists it. `installedSkills`
 * runs before any Adapter exists so deployment preflight can validate every
 * Skill; `build` runs once at startup and must return a Registration whose id
 * equals `id`.
 */
export type ProductionProcess = Readonly<{
    id: string;
    installedSkills: (
        environment: ProductionEnvironment,
    ) => readonly InstalledSkillRef[];
    build: (context: ProductionContext) => ProcessRegistration;
}>;

export function defineProductionProcess(options: {
    id: string;
    installedSkills?: ProductionProcess["installedSkills"];
    build: ProductionProcess["build"];
}): ProductionProcess {
    return Object.freeze({
        id: options.id,
        installedSkills: options.installedSkills ?? (() => noSkills),
        build: options.build,
    });
}

const noSkills: readonly InstalledSkillRef[] = Object.freeze([]);
