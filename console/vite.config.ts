import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * The console is served same-origin by the API, so assets are emitted with
 * relative URLs and the serving layer injects a `<base>` matching the deployed
 * `CONSOLE_BASE_PATH`. That keeps the base path a deployment decision rather
 * than something baked into the build.
 */
export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    base: "./",
    build: {
        outDir: fileURLToPath(new URL("../dist/console", import.meta.url)),
        emptyOutDir: true,
        // One operator page: a single bundle beats a waterfall of chunks.
        modulePreload: false,
    },
    esbuild: {
        jsx: "automatic",
        jsxImportSource: "preact",
    },
    server: {
        // `npm run dev:console` talks to a locally running API.
        proxy: {
            "/console/runs": "http://127.0.0.1:4300",
            "/console/processes": "http://127.0.0.1:4300",
            "/console/stats": "http://127.0.0.1:4300",
            "/process-runs": "http://127.0.0.1:4300",
        },
    },
});
