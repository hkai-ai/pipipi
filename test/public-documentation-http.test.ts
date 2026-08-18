import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createProcessingApplication,
    type ProcessingApplication,
} from "../src/api/application.js";

const runningApplications: ProcessingApplication[] = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("public Agent documentation", () => {
    it("serves the canonical Agent index and singular compatibility path", async () => {
        const execute = vi.fn();
        const application = createProcessingApplication({
            executor: { execute },
            http: { logSink: () => {} },
        });
        runningApplications.push(application);
        const { url } = await application.listen();

        const canonical = await fetch(`${url}/llms.txt`);
        const compatibility = await fetch(`${url}/llm.txt`);
        const canonicalBody = await canonical.text();

        expect(canonical.status).toBe(200);
        expect(canonical.headers.get("content-type")).toBe(
            "text/plain; charset=utf-8",
        );
        expect(canonical.headers.get("cache-control")).toBe(
            "public, max-age=300",
        );
        expect(canonicalBody).toContain("# Pipipi Business Process API");
        expect(canonicalBody).toContain(
            "https://pi.ganjiuwanshi.com/docs/api.md",
        );
        expect(await compatibility.text()).toBe(canonicalBody);
        expect(execute).not.toHaveBeenCalled();
    });

    it("serves the complete API contract as Markdown", async () => {
        const application = createProcessingApplication({
            executor: { execute: vi.fn() },
            http: { logSink: () => {} },
        });
        runningApplications.push(application);
        const { url } = await application.listen();

        const response = await fetch(`${url}/docs/api.md`);
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
            "text/markdown; charset=utf-8",
        );
        expect(body).toContain("# 业务接口文档");
        expect(body).toContain("## 重试判断");
        expect(body).toContain("## Webhook 通知");
    });

    it("packages both documentation sources in the production image", async () => {
        const dockerfile = await readFile("Dockerfile", "utf8");
        const dockerignore = await readFile(".dockerignore", "utf8");

        expect(dockerfile).toContain("COPY --chown=node:node llms.txt");
        expect(dockerfile).toContain(
            "COPY --chown=node:node docs/api.md ./docs/api.md",
        );
        expect(dockerignore).toContain("!llms.txt");
        expect(dockerignore).toContain("!docs/api.md");
    });
});
