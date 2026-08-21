/** 缓存并按固定路径提供随版本发布的只读文档（如 llms.txt） */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type PublicDocument = Readonly<{
    file: string;
    contentType: string;
}>;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const publicDocuments: Readonly<Record<string, PublicDocument>> = {
    "/llms.txt": {
        file: "llms.txt",
        contentType: "text/plain; charset=utf-8",
    },
    "/llm.txt": {
        file: "llms.txt",
        contentType: "text/plain; charset=utf-8",
    },
    "/docs/api.md": {
        file: "docs/api.md",
        contentType: "text/markdown; charset=utf-8",
    },
};

/** Serves the immutable documentation shipped with the current release. */
export function createPublicDocumentation(options: { root?: string } = {}) {
    const root = options.root ?? repositoryRoot;
    const cache = new Map<string, Promise<Buffer>>();

    const contents = (file: string): Promise<Buffer> => {
        const existing = cache.get(file);
        if (existing) return existing;
        const pending = readFile(join(root, file));
        cache.set(file, pending);
        return pending;
    };

    return async function handlePublicDocumentation(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<boolean> {
        if (request.method !== "GET") return false;
        const document = publicDocuments[request.url ?? ""];
        if (!document) return false;

        const body = await contents(document.file);
        response.writeHead(200, {
            "content-type": document.contentType,
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
        });
        response.end(body);
        return true;
    };
}
