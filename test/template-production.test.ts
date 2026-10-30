import { describe, expect, it, vi } from "vitest";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
} from "../src/process-runtime/index.js";
import { PiTemplateAgent } from "../src/processes/template-from-image/agent.pi.js";
import { templateProduction } from "../src/processes/template-from-image/production.js";

vi.mock("../src/processes/template-from-image/agent.pi.js", () => ({
    PiTemplateAgent: vi.fn(
        class {
            compile = vi.fn();
            review = vi.fn();
        },
    ),
}));

describe("模板生产模型选择", () => {
    it.each([
        ["openai", undefined, "gpt-5.4"],
        ["openai", "  ", "gpt-5.4"],
        ["openai", " explicit-model ", "explicit-model"],
        ["custom", undefined, "shared-model"],
    ])("%s 下模板覆盖 %s 解析为 %s", (provider, override, expected) => {
        const pi = Object.freeze({ provider, model: "shared-model" });
        templateProduction.build({
            pi,
            environment: { TEMPLATE_MODEL: override },
            skills: [],
            members: {
                registry: createProcessRegistry([]),
                attemptRunner: createProcessAttemptRunner(),
            },
            positiveInteger: (_name, fallback) => fallback,
        });
        expect(PiTemplateAgent).toHaveBeenLastCalledWith(
            expect.objectContaining({ provider, model: expected }),
        );
        expect(pi.model).toBe("shared-model");
    });
});
