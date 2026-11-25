import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessingApplication } from "../src/api/application.js";
import {
    buildOpenApiDocument,
    buildProcessOpenApiSlice,
    openApiComponentPrefix,
} from "../src/api/openapi.js";
import { constructProcessingService } from "../src/app/api.js";
import { createProductionRuntime } from "../src/app/business-processes.js";

const runningApplications: ProcessingApplication[] = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

const fullRegistry = createProductionRuntime({
    CRT_BUSINESS_API_BASE_URL: "https://business.example",
    COMPOSED_TASK_ENABLED: "true",
}).registry;

const templateV4Draft = JSON.parse(
    readFileSync("test/fixtures/template-v4-candidate.json", "utf8"),
).draft;

const validInputs: Readonly<Record<string, Record<string, unknown>>> = {
    "character-emoji/v2": {
        cast: [{ character: "DeepSeek", appearance: "Chibi" }],
        idea: "用一卷长代码表达只改一行",
    },
    "character-emoji/v3": {
        cast: [{ character: "DeepSeek", appearance: "Chibi" }],
        idea: "用一卷长代码表达只改一行",
    },
    "character-emoji/v4": {
        mode: "single",
        cast: [
            {
                character: "RainFox",
                appearance: "Ink",
                displayName: "雨狐",
                persona: "喜欢收集雨滴",
                referenceImageUrl:
                    "https://assets.memebuy.cn/maker/characters/community/scenes/rain-fox/ink-ad7bad7bad7bad7b.png",
            },
        ],
        idea: "给云撑伞",
    },
    "composed-task/v1": {
        goal: "为雨天旧书店做一张安静的海报",
    },
    "crayon-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "crt-interface-image/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
        palette: "经典",
        aspectRatio: "4:3",
    },
    "dopamine-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "manga-panels/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "memory-checklist-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "minimal-zine-poster/v1": {
        brief: "为雨天旧书店做一张安静的海报",
    },
    "mono-color-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "mono-color-photo-poster/v2": {
        sourceImageUrl: "https://assets.example.com/source.png",
        primaryInk: "#123456",
        accentInk: "#abcdef",
        typography: "literary",
        composition: "frame",
        emphasis: "bold",
        texture: "light",
    },
    "monochrome-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "news-image-narrative-monument/v1": { title: "标题", summary: "摘要" },
    "news-image-pale-watercolor/v1": { title: "标题", summary: "摘要" },
    "news-image-raw-humanism/v1": { title: "标题", summary: "摘要" },
    "photo-doodle-collage/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "photo-fashion-manga/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "product-remix/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
        userText: "把文字改成 HAPPY BIRTHDAY",
        budget: { maxAttempts: 3, maxUsd: 1 },
    },
    "risograph-album/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
    "template-from-image/v1": {
        imageUrl: "https://assets.example.com/source.png",
    },
    "template-from-image/v2": {
        imageUrl: "https://assets.example.com/source.png",
    },
    "template-from-image/v3": {
        imageUrl: "https://assets.example.com/source.png",
    },
    "template-master/v1": {
        imageUrl: "https://assets.example.com/source.png",
        template: templateV4Draft,
        condition: {
            marks: [],
            carrier: "flat_artwork",
            sharpness: "clear",
            compressionArtifacts: false,
            notes: [],
        },
        budget: { maxAttempts: 4, maxUsd: 1 },
    },
    "template-master/v2": {
        imageUrl: "https://assets.example.com/source.png",
        operation: "remove_watermark",
        transparent: false,
        watermarkNote: "去掉右下角白色署名",
    },
    "travel-abstraction-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
        phrase: "QUIET PAWS",
    },
    "woodcut-photo-poster/v1": {
        sourceImageUrl: "https://assets.example.com/source.png",
    },
};

function collectRefs(node: unknown, refs: string[] = []): string[] {
    if (!node || typeof node !== "object") return refs;
    if (Array.isArray(node)) {
        for (const item of node) collectRefs(item, refs);
        return refs;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === "string") refs.push(record.$ref);
    for (const value of Object.values(record)) collectRefs(value, refs);
    return refs;
}

function resolvePointer(root: unknown, pointer: string): unknown {
    if (!pointer.startsWith("#/")) return undefined;
    let current: unknown = root;
    for (const segment of pointer.slice(2).split("/")) {
        const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
        if (
            !current ||
            typeof current !== "object" ||
            !(key in (current as Record<string, unknown>))
        ) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function createAjv(components: Record<string, unknown>): Ajv2020 {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const [name, format] of Object.entries(fullFormats)) {
        ajv.addFormat(name, format);
    }
    ajv.addSchema({
        $id: "urn:pipipi:openapi-test",
        components: { schemas: components },
    });
    return ajv;
}

describe("OpenAPI 3.1 contract derivation", () => {
    const document = buildOpenApiDocument(fullRegistry, {
        defaultProcessTimeoutMs: 240_000,
    });
    const serialized = JSON.stringify(document);
    const components = (
        document.components as Record<string, Record<string, unknown>>
    ).schemas;
    const ajv = createAjv(components);

    it("emits valid OpenAPI 3.1.0 metadata with zero broken $ref pointers", () => {
        expect(document.openapi).toBe("3.1.0");
        expect(document.jsonSchemaDialect).toBe(
            "https://json-schema.org/draft/2020-12/schema",
        );

        const refs = collectRefs(document);
        expect(refs.length).toBeGreaterThan(200);
        const broken = refs.filter(
            (ref) => resolvePointer(document, ref) === undefined,
        );
        expect(broken).toEqual([]);
    });

    it("emits self-contained per-process slices with zero broken $ref pointers", () => {
        for (const registration of fullRegistry.list()) {
            const slice = buildProcessOpenApiSlice(registration, 240_000);
            const broken = collectRefs(slice).filter(
                (ref) => resolvePointer(slice, ref) === undefined,
            );
            expect(
                broken,
                `${registration.identity.id}/${registration.identity.version}`,
            ).toEqual([]);
            expect(slice).not.toHaveProperty("skills");
            expect(slice).not.toHaveProperty("activities");
        }
    });

    it("does not leak internal Runtime Skill names or operational routes", () => {
        for (const registration of fullRegistry.list()) {
            for (const skill of registration.skills) {
                expect(serialized, `leaked skill ${skill.name}`).not.toContain(
                    skill.name,
                );
            }
        }
        const paths = Object.keys(document.paths as Record<string, unknown>);
        expect(paths).not.toContain("/healthz");
        expect(paths).not.toContain("/readyz");
        expect(paths).not.toContain("/internal/eval/execute");
        expect(paths.some((path) => path.startsWith("/console"))).toBe(false);
    });

    it("matches every production Process Registration under Ajv Draft 2020-12", () => {
        const validateEnvelope = ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/ExecuteProcessRequest",
        });

        for (const registration of fullRegistry.list()) {
            const key = `${registration.identity.id}/${registration.identity.version}`;
            const input = validInputs[key];
            expect(input, `missing fixture for ${key}`).toBeDefined();
            expect(registration.accept(input).accepted, key).toBe(true);

            const prefix = openApiComponentPrefix(
                registration.identity.id,
                registration.identity.version,
            );
            const validateInput = ajv.compile({
                $ref: `urn:pipipi:openapi-test#/components/schemas/${prefix}Input`,
            });
            expect(validateInput(input), `${key} input`).toBe(true);
            expect(
                validateEnvelope({
                    process: registration.identity.id,
                    version: registration.identity.version,
                    input,
                }),
                `${key} envelope`,
            ).toBe(true);

            const extra = { ...input, __undocumented__: true };
            expect(registration.accept(extra).accepted, `${key} zod`).toBe(
                false,
            );
            expect(validateInput(extra), `${key} ajv`).toBe(false);

            // Output schema compiles cleanly with hoisted $defs.
            ajv.compile({
                $ref: `urn:pipipi:openapi-test#/components/schemas/${prefix}Output`,
            });
        }

        ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/ExecuteProcessSuccessResponse",
        });
        ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/ProcessRunView",
        });
        ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/WebhookProcessRunEvent",
        });
    });

    it("enforces enriched JSON Schema constraints directly in OpenAPI", () => {
        const validateProductRemix = ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/ProductRemixV1Input",
        });
        expect(
            validateProductRemix({
                sourceImageUrl: "https://assets.example.com/a.png",
                referenceImageUrl: "https://assets.example.com/b.png",
                referenceImageUrls: ["https://assets.example.com/c.png"],
                userText: "改文字",
                budget: { maxAttempts: 2, maxUsd: 1 },
            }),
        ).toBe(false);
        expect(
            validateProductRemix({
                sourceImageUrl: "https://assets.example.com/a.png",
                userText: "改文字",
                imageSize: "large",
                budget: { maxAttempts: 2, maxUsd: 1 },
            }),
        ).toBe(false);

        const validateComposed = ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/ComposedTaskV1Input",
        });
        const tooManyMaterials = Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]),
        );
        expect(
            validateComposed({
                goal: "完成海报",
                material: tooManyMaterials,
            }),
        ).toBe(false);

        const validateEmojiV4 = ajv.compile({
            $ref: "urn:pipipi:openapi-test#/components/schemas/CharacterEmojiV4Input",
        });
        expect(
            validateEmojiV4({
                mode: "single",
                cast: [
                    {
                        character: "Rain:Fox",
                        appearance: "Ink",
                        displayName: "雨狐",
                        persona: "喜欢收集雨滴",
                        referenceImageUrl:
                            "https://assets.memebuy.cn/maker/characters/community/scenes/rain-fox/ink-ad7bad7bad7bad7b.png",
                    },
                ],
                idea: "给云撑伞",
            }),
        ).toBe(false);
    });
});

describe("OpenAPI HTTP endpoints", () => {
    it("serves /openapi.json and /openapi/processes/{process}/{version}.json", async () => {
        const constructed = constructProcessingService({
            CRT_BUSINESS_API_BASE_URL: "https://business.example",
            PROCESS_TIMEOUT_MS: "240000",
        });
        runningApplications.push(constructed.application);
        const { url } = await constructed.application.listen();

        const full = await fetch(`${url}/openapi.json`);
        expect(full.status).toBe(200);
        expect(full.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
        );
        expect(full.headers.get("cache-control")).toBe("public, max-age=300");
        const doc = (await full.json()) as {
            openapi: string;
            "x-pipipi-processes": Array<{
                process: string;
                version: string;
                timeoutMs: number;
            }>;
        };
        expect(doc.openapi).toBe("3.1.0");
        const poster = doc["x-pipipi-processes"].find(
            (entry) =>
                entry.process === "minimal-zine-poster" &&
                entry.version === "v1",
        );
        expect(poster?.timeoutMs).toBe(240_000);
        expect(
            doc["x-pipipi-processes"].some(
                (entry) => entry.process === "composed-task",
            ),
        ).toBe(false);

        const slice = await fetch(
            `${url}/openapi/processes/product-remix/v1.json`,
        );
        expect(slice.status).toBe(200);
        expect(slice.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
        );
        const sliceBody = (await slice.json()) as {
            process: string;
            version: string;
            timeoutMs: number;
            inputSchema: Record<string, unknown>;
            outputSchema: Record<string, unknown>;
        };
        expect(sliceBody.process).toBe("product-remix");
        expect(sliceBody.version).toBe("v1");
        expect(sliceBody.timeoutMs).toBe(660_000);
        expect(sliceBody.inputSchema).toBeDefined();
        expect(sliceBody.outputSchema).toBeDefined();

        const missing = await fetch(
            `${url}/openapi/processes/composed-task/v1.json`,
        );
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
            status: "failed",
            error: {
                code: "PROCESS_NOT_FOUND",
                message: "Process version not found",
            },
        });
    });
});
