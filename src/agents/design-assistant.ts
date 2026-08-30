/** 定义 design-assistant/v1 的固定生产策略、Runtime Skill、Process Tool 与确定性 revision */
import { createHash } from "node:crypto";
import { PiInteractiveAgent } from "../agent-conversations/agent.pi.js";
import {
    type AgentRegistration,
    type AgentRegistrationLimits,
    defineAgentRegistration,
} from "../agent-conversations/registration.js";
import type { AgentToolLimits } from "../agent-conversations/tools.js";
import { createInstalledSkillCatalog } from "../agent-runtime/catalog.js";
import type { OpenAIApiMode } from "../agent-runtime/pi.js";
import type { ProcessToolSpec } from "../agent-runtime/process-tools.js";
import type { InstalledSkillRef } from "../agent-runtime/skills.js";
import type {
    ProcessAttemptRunner,
    ProcessRegistry,
} from "../process-runtime/index.js";

export const designAssistantIdentity = Object.freeze({
    id: "design-assistant",
    version: "v1",
});
export const designAssistantRetentionMs = 30 * 24 * 60 * 60 * 1_000;
export const designAssistantDeletionGraceMs = 24 * 60 * 60 * 1_000;
export const designAssistantSkill = Object.freeze({
    name: "design-assistant",
    version: "v1",
    sha256: "a158d3625caf77e24fe6ccf2642c31e259cd2c7bdffdd15c4bca1f5a89d7b4b2",
    path: ".pi/skills/design-assistant",
});

const instructions = Object.freeze([
    "Help the user make a design decision or create one bounded template artefact.",
    "Use only the public Conversation context, attached images and approved Process Tools.",
    "Return only strict JSON content blocks accepted by the server.",
]);

const limits: AgentRegistrationLimits = Object.freeze({
    maxTurns: 50,
    maxInputBytes: 24_000,
    maxOutputBytes: 48_000,
    maxContextTokens: 32_000,
    maxHistoryTurns: 16,
    maxSummaryTokens: 4_000,
    historyPageSize: 50,
    maxImagesPerTurn: 4,
    maxImageBytes: 10_485_760,
    maxImageTotalBytes: 20_971_520,
    maxImageWidth: 8_192,
    maxImageHeight: 8_192,
});

const toolLimits: AgentToolLimits = Object.freeze({
    maxCallsPerTurn: 6,
    maxPricedCallsPerTurn: 1,
    maxPricedCallsPerConversation: 10,
});

const processTools: readonly ProcessToolSpec[] = Object.freeze([
    Object.freeze({
        process: "content-processing",
        version: "v1",
        toolName: "advise_design",
        description:
            "Analyse a design brief or produce reusable text and template structure.",
        sideEffect: "none" as const,
    }),
    Object.freeze({
        process: "minimal-zine-poster",
        version: "v1",
        toolName: "create_zine_poster",
        description:
            "Create one paid minimal zine poster artefact from a complete brief.",
        sideEffect: "priced" as const,
    }),
]);

export type DesignAssistantEnvironment = Readonly<
    Record<string, string | undefined>
>;

export type DesignAssistantRuntime = Readonly<{
    registration: AgentRegistration;
    ready: () => Promise<void>;
    configuration: Readonly<Record<string, unknown>>;
}>;

export function createDesignAssistantRuntime(options: {
    environment: DesignAssistantEnvironment;
    processRegistry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
    cwd?: string;
}): DesignAssistantRuntime {
    const provider = required(options.environment.PI_PROVIDER, "PI_PROVIDER");
    const model = required(options.environment.PI_MODEL, "PI_MODEL");
    const openAIApiMode = parseApiMode(options.environment.OPENAI_API_MODE);
    const installed = skillRef(
        options.environment.PI_DESIGN_ASSISTANT_SKILL_DIRECTORY,
    );
    const skills = createInstalledSkillCatalog(
        [installed],
        options.cwd ?? process.cwd(),
    ).resolve([
        {
            name: designAssistantSkill.name,
            version: designAssistantSkill.version,
        },
    ]);
    const configuration = Object.freeze({
        schemaVersion: 1,
        identity: designAssistantIdentity,
        instructions,
        runtimeSkills: Object.freeze([
            Object.freeze({
                name: installed.name,
                version: installed.version,
                sha256: installed.sha256,
            }),
        ]),
        contextPolicy: Object.freeze({
            source: "successful-public-turns",
            maxTokens: limits.maxContextTokens,
            maxHistoryTurns: limits.maxHistoryTurns,
            maxSummaryTokens: limits.maxSummaryTokens,
        }),
        memoryPolicy: Object.freeze({
            scope: "conversation",
            authority: "session-history",
            summary: "derived",
            crossConversation: false,
        }),
        processTools,
        modelPolicy: Object.freeze({
            provider,
            model,
            apiMode: openAIApiMode,
            endpointDigest: digest(
                options.environment.OPENAI_BASE_URL?.trim() ?? "default",
            ),
            session: "request-local",
        }),
        limits,
        toolLimits,
        outputPolicy: Object.freeze({
            format: "content-blocks-v1",
            toolTextMustBeVerbatim: true,
            imageRequiresOwnedResourceProof: true,
        }),
        retention: Object.freeze({
            idleMs: designAssistantRetentionMs,
            deletionGraceMs: designAssistantDeletionGraceMs,
        }),
    });
    const agent = new PiInteractiveAgent({
        skills,
        instructions,
        provider,
        model,
        openAIBaseUrl: options.environment.OPENAI_BASE_URL,
        openAIApiMode,
        agentDir: options.environment.PI_AGENT_DIR,
    });
    const registration = defineAgentRegistration({
        ...designAssistantIdentity,
        revision: digest(stableJson(configuration)),
        agent,
        limits,
        processTools: {
            specs: processTools,
            registry: options.processRegistry,
            attemptRunner: options.attemptRunner,
        },
        toolLimits,
    });
    return Object.freeze({
        registration,
        ready: () => agent.ready(),
        configuration,
    });
}

function skillRef(path: string | undefined): InstalledSkillRef {
    return Object.freeze({
        ...designAssistantSkill,
        path: path?.trim() || designAssistantSkill.path,
    });
}

function required(value: string | undefined, name: string): string {
    const candidate = value?.trim();
    if (!candidate) {
        throw new Error(
            `${name} is required when Agent Conversations are enabled`,
        );
    }
    return candidate;
}

function parseApiMode(value: string | undefined): OpenAIApiMode {
    if (value === undefined || value === "chat-completions") {
        return "chat-completions";
    }
    if (value === "responses") return value;
    throw new Error("OPENAI_API_MODE must be responses or chat-completions");
}

function digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
