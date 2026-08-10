import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    resolveCrtEvidencePolicy,
    saveCrtEvidence,
} from "../src/business-api/crt-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) =>
                rm(directory, { recursive: true, force: true }),
            ),
    );
});

describe("CRT image evidence policy", () => {
    it("uses a caller-owned development default without exposing it to product input", () => {
        expect(
            resolveCrtEvidencePolicy(
                {},
                {
                    defaultMode: "full",
                    defaultDirectory: "/tmp/crt-evidence",
                },
            ),
        ).toEqual({
            mode: "full",
            directory: resolve("/tmp/crt-evidence"),
        });
    });

    it("allows production composition to disable evidence retention", () => {
        expect(
            resolveCrtEvidencePolicy(
                {
                    CRT_IMAGE_EVIDENCE_MODE: "off",
                    CRT_IMAGE_EVIDENCE_DIRECTORY: "/must/not/be/used",
                },
                {
                    defaultMode: "full",
                    defaultDirectory: "/tmp/crt-evidence",
                },
            ),
        ).toEqual({ mode: "off" });
    });

    it("requires a directory for metadata and full retention", () => {
        expect(() =>
            resolveCrtEvidencePolicy(
                { CRT_IMAGE_EVIDENCE_MODE: "metadata" },
                { defaultMode: "off" },
            ),
        ).toThrow("CRT_IMAGE_EVIDENCE_DIRECTORY is required");
        expect(() =>
            resolveCrtEvidencePolicy(
                { CRT_IMAGE_EVIDENCE_MODE: "everything" },
                { defaultMode: "off" },
            ),
        ).toThrow("CRT_IMAGE_EVIDENCE_MODE must be off, metadata, or full");
    });
});

describe("CRT image evidence artifacts", () => {
    it("writes no evidence directory when retention is off", async () => {
        const root = await createTemporaryDirectory();
        const directory = join(root, "evidence");

        await expect(
            saveCrtEvidence({ mode: "off" }, createEvidenceInput("run-off")),
        ).resolves.toEqual({ mode: "off" });
        await expect(access(directory)).rejects.toThrow();
    });

    it("writes a redacted manifest without pixels in metadata mode", async () => {
        const root = await createTemporaryDirectory();
        const directory = join(root, "evidence");
        const result = await saveCrtEvidence(
            { mode: "metadata", directory },
            createEvidenceInput("run-metadata"),
        );

        expect(result).toMatchObject({
            mode: "metadata",
            runDirectory: join(directory, "run-metadata"),
            manifestFile: join(directory, "run-metadata", "manifest.json"),
        });
        expect(await readdir(join(directory, "run-metadata"))).toEqual([
            "manifest.json",
        ]);
        const manifestText = await readFile(result.manifestFile ?? "", "utf8");
        const manifest = JSON.parse(manifestText) as Record<string, unknown>;
        expect(manifest).toMatchObject({
            schemaVersion: 1,
            process: {
                id: "crt-interface-image",
                version: "v1",
                runId: "run-metadata",
            },
            retention: { mode: "metadata" },
            rendering: {
                provider: "openai",
                model: "gpt-image-2",
                operation: "reference-edit",
                requestId: "req_test",
                usage: { inputTokens: 1479, outputTokens: 189 },
            },
            source: { bytes: 12 },
            raw: { bytes: 9 },
            final: { bytes: 11 },
            omitted: ["credentials", "baseUrl", "prompt", "revisedPrompt"],
        });
        expect(manifestText).not.toContain("private prompt");
        expect(manifestText).not.toContain("revised private prompt");
        expect(manifestText).not.toContain("secret-key");
    });

    it("writes exact source, raw model, final, and manifest files in full mode", async () => {
        const root = await createTemporaryDirectory();
        const directory = join(root, "evidence");
        const input = createEvidenceInput("run-full");
        const result = await saveCrtEvidence(
            { mode: "full", directory },
            input,
        );

        expect(await readdir(join(directory, "run-full"))).toEqual([
            "final-crt.png",
            "manifest.json",
            "raw-gpt-image-2.png",
            "source.png",
        ]);
        await expect(readFile(result.sourceFile ?? "")).resolves.toEqual(
            input.source.bytes,
        );
        await expect(readFile(result.rawFile ?? "")).resolves.toEqual(
            input.raw.bytes,
        );
        await expect(readFile(result.finalFile ?? "")).resolves.toEqual(
            input.final.bytes,
        );
        const manifest = JSON.parse(
            await readFile(result.manifestFile ?? "", "utf8"),
        ) as Record<string, unknown>;
        expect(manifest).toMatchObject({
            retention: { mode: "full" },
            source: { file: "source.png" },
            raw: { file: "raw-gpt-image-2.png" },
            final: { file: "final-crt.png" },
        });
    });
});

async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pipipi-crt-evidence-"));
    temporaryDirectories.push(directory);
    return directory;
}

function createEvidenceInput(runId: string) {
    return {
        runId,
        createdAt: "2026-08-10T04:11:29.000Z",
        provider: "openai",
        model: "gpt-image-2",
        quality: "low" as const,
        palette: "经典" as const,
        aspectRatio: "4:3" as const,
        prompt: "private prompt",
        source: {
            bytes: Buffer.from("source-bytes"),
            contentType: "image/png" as const,
            width: 736,
            height: 1302,
        },
        raw: {
            bytes: Buffer.from("raw-bytes"),
            contentType: "image/png" as const,
            width: 1600,
            height: 1200,
            requestId: "req_test",
            revisedPrompt: "revised private prompt",
            usage: { inputTokens: 1479, outputTokens: 189 },
        },
        final: {
            bytes: Buffer.from("final-bytes"),
            contentType: "image/png" as const,
            width: 1600,
            height: 1200,
            colors: ["#2e382d", "#dee4e0"],
            blockSize: 4,
        },
    };
}
