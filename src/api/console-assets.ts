import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Serves the built console.
 *
 * Only two shapes are reachable: the document itself and one file inside the
 * build's `assets` directory. Names are matched against a strict pattern rather
 * than resolved as paths, so no request can walk out of the build output.
 */
export type ConsoleAssets = Readonly<{
    writeDocument: (
        response: ServerResponse,
        basePath: string,
    ) => Promise<void>;
    writeAsset: (response: ServerResponse, name: string) => Promise<boolean>;
}>;

const assetName = /^[A-Za-z0-9._-]+$/;

const mediaTypes: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
};

export function createConsoleAssets(options: {
    directory: string;
}): ConsoleAssets {
    const directory = options.directory;
    // The build output is immutable for the life of a release, so each file is
    // read once and kept.
    const cache = new Map<string, Buffer>();

    const read = async (path: string): Promise<Buffer | undefined> => {
        const cached = cache.get(path);
        if (cached) return cached;
        try {
            const contents = await readFile(path);
            cache.set(path, contents);
            return contents;
        } catch {
            return undefined;
        }
    };

    return Object.freeze({
        writeDocument: async (response, basePath) => {
            const document = await read(join(directory, "index.html"));
            if (!document) {
                writeText(
                    response,
                    500,
                    "Console assets are missing from this build",
                );
                return;
            }
            // Assets are emitted with relative URLs; the base tag makes them
            // resolve under the deployed console path, whatever it is, and
            // whether or not the request carried a trailing slash.
            const body = document
                .toString("utf8")
                .replace("<head>", `<head><base href="${basePath}/">`);
            response.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "x-robots-tag": "noindex, nofollow",
                "content-security-policy":
                    "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
            });
            response.end(body);
        },

        writeAsset: async (response, name) => {
            if (!assetName.test(name)) return false;
            const extension = name.slice(name.lastIndexOf("."));
            const mediaType = mediaTypes[extension];
            if (!mediaType) return false;

            const contents = await read(join(directory, "assets", name));
            if (!contents) return false;

            response.writeHead(200, {
                "content-type": mediaType,
                // File names carry a content hash, so they never change meaning.
                "cache-control": "public, max-age=31536000, immutable",
            });
            response.end(contents);
            return true;
        },
    });
}

function writeText(
    response: ServerResponse,
    status: number,
    message: string,
): void {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(message);
}
