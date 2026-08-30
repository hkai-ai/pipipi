/** 验证 production Agent catalog、固定配置 revision 与旧 revision 保留规则 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { defineAgentRegistration } from "../src/agent-conversations/registration.js";
import {
    createProductionAgentRuntime,
    productionAgentCatalog,
} from "../src/agents/catalog.js";
import {
    designAssistantIdentity,
    designAssistantSkill,
} from "../src/agents/design-assistant.js";
import { assertAgentRegistrationRevisions } from "../src/agents/postgres.js";
import { createProductionRuntime } from "../src/app/business-processes.js";
import { createProcessAttemptRunner } from "../src/process-runtime/index.js";

const environment = Object.freeze({
    BUSINESS_API_BASE_URL: "https://business.example",
    PI_PROVIDER: "openai",
    PI_MODEL: "gpt-5.6-terra",
});

describe("Production Agent catalog", () => {
    it("contains only the exact design-assistant/v1 Registration", () => {
        const runtime = createRuntime(environment);

        expect(productionAgentCatalog).toEqual([designAssistantIdentity]);
        expect(runtime.registry.list()).toEqual([
            runtime.designAssistant.registration,
        ]);
        expect(runtime.registry.find(designAssistantIdentity)).toBe(
            runtime.designAssistant.registration,
        );
        expect(
            runtime.registry.find({ id: "design-assistant", version: "v2" }),
        ).toBeUndefined();
        expect(
            runtime.registry.find({ id: "unknown-agent", version: "v1" }),
        ).toBeUndefined();
    });

    it("binds the reviewed Skill digest and computes a deterministic behavior revision", () => {
        const first = createRuntime(environment);
        const second = createRuntime(environment);
        const changedModel = createRuntime({
            ...environment,
            PI_MODEL: "gpt-5.6-sol",
        });
        const skillContents = readFileSync(
            ".pi/skills/design-assistant/SKILL.md",
        );

        expect(createHash("sha256").update(skillContents).digest("hex")).toBe(
            designAssistantSkill.sha256,
        );
        expect(first.designAssistant.registration.revision).toMatch(
            /^[0-9a-f]{64}$/,
        );
        expect(second.designAssistant.registration.revision).toBe(
            first.designAssistant.registration.revision,
        );
        expect(changedModel.designAssistant.registration.revision).not.toBe(
            first.designAssistant.registration.revision,
        );
        expect(first.designAssistant.configuration).toMatchObject({
            identity: designAssistantIdentity,
            runtimeSkills: [
                {
                    name: designAssistantSkill.name,
                    version: designAssistantSkill.version,
                    sha256: designAssistantSkill.sha256,
                },
            ],
            contextPolicy: {
                source: "successful-public-turns",
                maxHistoryTurns: 16,
            },
            memoryPolicy: {
                scope: "conversation",
                crossConversation: false,
            },
            toolLimits: {
                maxCallsPerTurn: 6,
                maxPricedCallsPerTurn: 1,
                maxPricedCallsPerConversation: 10,
            },
            limits: { maxTurns: 50 },
            outputPolicy: { format: "content-blocks-v1" },
        });
    });

    it("keeps an explicitly retained revision executable without making it current", () => {
        const current = createRuntime(environment);
        const retained = defineAgentRegistration({
            ...designAssistantIdentity,
            revision: "retained-revision",
            agent: {
                respond: async () => ({
                    content: [{ type: "text", text: "retained" }],
                }),
            },
        });
        const runtime = createRuntime(environment, { retained: [retained] });

        expect(runtime.registry.find(designAssistantIdentity)?.revision).toBe(
            current.designAssistant.registration.revision,
        );
        expect(
            runtime.registry.findRevision(
                designAssistantIdentity,
                "retained-revision",
            ),
        ).toBe(retained);
        expect(runtime.registry.list()).toHaveLength(1);
    });

    it("fails readiness when an active Conversation revision was not retained", async () => {
        const current = createRuntime(environment);
        const pool = {
            query: async () => ({
                rows: [
                    {
                        agent_id: designAssistantIdentity.id,
                        agent_version: designAssistantIdentity.version,
                        config_revision: "missing-revision",
                    },
                ],
            }),
        } as unknown as Pool;

        await expect(
            assertAgentRegistrationRevisions({
                pool,
                registry: current.registry,
            }),
        ).rejects.toThrow(
            "An active Agent Conversation requires an unavailable Registration revision",
        );
    });
});

function createRuntime(
    startupEnvironment: Readonly<Record<string, string | undefined>>,
    retainedRegistrations?: Parameters<
        typeof createProductionAgentRuntime
    >[0]["retainedRegistrations"],
) {
    const processes = createProductionRuntime(startupEnvironment);
    return createProductionAgentRuntime({
        environment: startupEnvironment,
        processRegistry: processes.registry,
        attemptRunner: createProcessAttemptRunner(),
        ...(retainedRegistrations ? { retainedRegistrations } : {}),
    });
}
