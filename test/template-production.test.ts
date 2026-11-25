import { describe, expect, it, vi } from "vitest";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
} from "../src/process-runtime/index.js";
import { PiProductRemixAgent } from "../src/processes/product-remix/agent.pi.js";
import { productRemixProduction } from "../src/processes/product-remix/production.js";
import { PiTemplateAgent } from "../src/processes/template-from-image/agent.pi.js";
import { templateProduction } from "../src/processes/template-from-image/production.js";
import {
    templateMasterProduction,
    templateMasterV2Production,
} from "../src/processes/template-master/production.js";
import { PiMasterVerifier } from "../src/processes/template-master/verifier.js";

vi.mock("../src/processes/template-from-image/agent.pi.js", () => ({
    PiTemplateAgent: vi.fn(
        class {
            compile = vi.fn();
            review = vi.fn();
        },
    ),
}));

vi.mock("../src/processes/product-remix/agent.pi.js", () => ({
    PiProductRemixAgent: vi.fn(
        class {
            plan = vi.fn();
            inspect = vi.fn();
        },
    ),
}));

vi.mock("../src/processes/template-master/verifier.js", () => ({
    PiMasterVerifier: vi.fn(
        class {
            verify = vi.fn();
        },
    ),
}));

const emptyMembers = () => ({
    registry: createProcessRegistry([]),
    attemptRunner: createProcessAttemptRunner(),
});

describe("模板生产模型选择", () => {
    it.each([
        ["openai", undefined, "shared-model"],
        ["openai", "  ", "shared-model"],
        ["openai", " explicit-model ", "explicit-model"],
        ["custom", undefined, "shared-model"],
    ])("%s 下模板覆盖 %s 解析为 %s", (provider, override, expected) => {
        const pi = Object.freeze({ provider, model: "shared-model" });
        templateProduction.build({
            pi,
            environment: { TEMPLATE_MODEL: override },
            skills: [],
            members: emptyMembers(),
            positiveInteger: (_name, fallback) => fallback,
        });
        expect(PiTemplateAgent).toHaveBeenLastCalledWith(
            expect.objectContaining({ provider, model: expected }),
        );
        expect(pi.model).toBe("shared-model");
    });

    it("template-master/v1 未设置 TEMPLATE_MODEL 时沿用 PI_MODEL，不硬编码 gpt-5.4", () => {
        const pi = Object.freeze({ provider: "openai", model: "shared-model" });
        templateMasterProduction.build({
            pi,
            environment: {
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
            },
            skills: [],
            members: emptyMembers(),
            positiveInteger: (_name, fallback) => fallback,
        });
        expect(PiMasterVerifier).toHaveBeenLastCalledWith(
            expect.objectContaining({
                provider: "openai",
                model: "shared-model",
            }),
        );
    });

    it("template-master/v2 不读取 TEMPLATE_MODEL 且不构造 LLM 校验器", () => {
        vi.mocked(PiMasterVerifier).mockClear();
        const registration = templateMasterV2Production.build({
            pi: Object.freeze({ provider: "openai", model: "shared-model" }),
            environment: {
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
            },
            skills: [],
            members: emptyMembers(),
            positiveInteger: (_name, fallback) => fallback,
        });
        expect(registration.identity).toEqual({
            id: "template-master",
            version: "v2",
        });
        expect(templateMasterV2Production.environment).toEqual([
            "CRT_BUSINESS_API_BASE_URL",
        ]);
        expect(PiMasterVerifier).not.toHaveBeenCalled();
    });

    it("product-remix/v1 独立使用 PRODUCT_REMIX_MODEL，不受 TEMPLATE_MODEL 影响且不硬编码 gpt-5.4", () => {
        const pi = Object.freeze({ provider: "openai", model: "shared-model" });
        productRemixProduction.build({
            pi,
            environment: {
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
                TEMPLATE_MODEL: "template-only-model",
            },
            skills: [],
            members: emptyMembers(),
            positiveInteger: (_name, fallback) => fallback,
        });
        expect(PiProductRemixAgent).toHaveBeenLastCalledWith(
            expect.objectContaining({
                provider: "openai",
                model: "shared-model",
            }),
        );

        productRemixProduction.build({
            pi,
            environment: {
                CRT_BUSINESS_API_BASE_URL: "https://business.example",
                PRODUCT_REMIX_MODEL: " remix-explicit-model ",
            },
            skills: [],
            members: emptyMembers(),
            positiveInteger: (_name, fallback) => fallback,
        });
        expect(PiProductRemixAgent).toHaveBeenLastCalledWith(
            expect.objectContaining({
                provider: "openai",
                model: "remix-explicit-model",
            }),
        );
    });
});
