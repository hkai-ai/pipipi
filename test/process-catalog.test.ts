import { describe, expect, it } from "vitest";
import { createProductionRuntime } from "../src/app/business-processes.js";
import { describeProcessCatalog } from "../src/app/process-catalog.js";
import type { ProcessRegistry } from "../src/process-runtime/index.js";

const registry: ProcessRegistry = createProductionRuntime({
    BUSINESS_API_BASE_URL: "https://business.example",
}).registry;

/**
 * One accepted input per production Process. They keep the drift checks below
 * honest: a Schema change that these no longer satisfy is a contract change.
 */
const validInputs: Readonly<Record<string, Record<string, unknown>>> = {
    "content-processing": { content: "整理这段业务内容" },
    "titled-content-processing": {
        title: "季度业务简报",
        body: "整理这段内容",
    },
    "minimal-zine-poster": { brief: "为雨天旧书店做一张安静的海报" },
    "crt-interface-image": {
        sourceImageUrl: "https://assets.example.com/source.png",
        palette: "经典",
        aspectRatio: "4:3",
    },
    "news-image-narrative-monument": { title: "标题", summary: "摘要" },
    "news-image-pale-watercolor": { title: "标题", summary: "摘要" },
    "news-image-raw-humanism": { title: "标题", summary: "摘要" },
};

type JsonSchemaObject = Readonly<{
    properties?: Record<string, { enum?: readonly unknown[] }>;
    required?: readonly string[];
    additionalProperties?: boolean;
}>;

describe("Process catalog description", () => {
    it("describes every registered Process version once, ordered", () => {
        const catalog = describeProcessCatalog(registry);

        expect(
            catalog.map((entry) => `${entry.process}/${entry.version}`),
        ).toEqual([
            "content-processing/v1",
            "crt-interface-image/v1",
            "minimal-zine-poster/v1",
            "news-image-narrative-monument/v1",
            "news-image-pale-watercolor/v1",
            "news-image-raw-humanism/v1",
            "titled-content-processing/v1",
        ]);
    });

    it("reports the fixed activity names and retry policy", () => {
        const crt = describeProcessCatalog(registry).find(
            (entry) => entry.process === "crt-interface-image",
        );

        expect(crt?.activities).toEqual([
            "crt_prompt_compilation",
            "crt_rendering",
        ]);
        // The described policy is the Registration-level one. CRT's retry of a
        // side-effect-free Agent compile happens inside the Registration and is
        // deliberately not reported as an Attempt.
        expect(crt?.retry).toEqual({
            maximumAttempts: 1,
            retryableErrorCodes: [],
        });
    });

    it("derives an input and output Schema for every Process", () => {
        for (const entry of describeProcessCatalog(registry)) {
            expect(entry.input, `${entry.process} input`).toBeDefined();
            expect(entry.output, `${entry.process} output`).toBeDefined();
        }
    });

    it("documents the caller-visible constraints of the CRT input", () => {
        const crt = describeProcessCatalog(registry).find(
            (entry) => entry.process === "crt-interface-image",
        );
        const input = crt?.input as JsonSchemaObject;

        expect(input.properties?.palette?.enum).toContain("经典");
        expect(input.properties?.aspectRatio?.enum).toEqual([
            "3:4",
            "4:3",
            "9:16",
            "16:9",
        ]);
        // grain carries a default, so it is described but not required.
        expect(input.required).not.toContain("grain");
    });

    describe("agrees with what the Registration actually accepts", () => {
        for (const entry of describeProcessCatalog(registry)) {
            const registration = registry.find({
                id: entry.process,
                version: entry.version,
            });
            const valid = validInputs[entry.process];
            const input = entry.input as JsonSchemaObject;

            it(`${entry.process} accepts the documented shape`, () => {
                expect(valid, "test fixture missing").toBeDefined();
                expect(registration?.accept(valid).accepted).toBe(true);
            });

            it(`${entry.process} requires every field marked required`, () => {
                for (const field of input.required ?? []) {
                    const withoutField = { ...valid };
                    delete withoutField[field];
                    expect(
                        registration?.accept(withoutField).accepted,
                        `${field} is documented as required`,
                    ).toBe(false);
                }
            });

            it(`${entry.process} rejects undocumented fields when the Schema is closed`, () => {
                if (input.additionalProperties !== false) return;
                expect(
                    registration?.accept({
                        ...valid,
                        undocumentedField: "x",
                    }).accepted,
                ).toBe(false);
            });

            it(`${entry.process} rejects values outside a documented enum`, () => {
                for (const [field, property] of Object.entries(
                    input.properties ?? {},
                )) {
                    if (!property.enum) continue;
                    expect(
                        registration?.accept({
                            ...valid,
                            [field]: "not-a-listed-value",
                        }).accepted,
                        `${field} is documented as an enum`,
                    ).toBe(false);
                }
            });
        }
    });
});

describe("Process Registry listing", () => {
    it("returns the same Registration instances that find returns", () => {
        for (const registration of registry.list()) {
            expect(registry.find(registration.identity)).toBe(registration);
        }
    });

    it("exposes the Schemas used for validation", () => {
        const registration = registry.find({
            id: "content-processing",
            version: "v1",
        });

        expect(
            registration?.inputSchema.safeParse({ content: "内容" }).success,
        ).toBe(true);
        expect(registration?.inputSchema.safeParse({}).success).toBe(false);
    });
});
