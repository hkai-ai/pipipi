/** 构建同源运维控制台并配置本地 API 开发代理。 */
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { createDevelopmentGateway } from "./development-gateway.js";

/**
 * The console is served same-origin by the API, so assets are emitted with
 * relative URLs and the serving layer injects a `<base>` matching the deployed
 * `CONSOLE_BASE_PATH`. That keeps the base path a deployment decision rather
 * than something baked into the build.
 */
export default defineConfig(({ command, mode }) => {
    const environment = {
        ...loadEnv(mode, process.cwd(), ""),
        ...process.env,
    };
    const developmentGateway = createDevelopmentGateway({
        command,
        mode,
        environment,
    });

    const consoleBasePath = environment.CONSOLE_BASE_PATH?.trim() || "/console";
    return {
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
            jsxImportSource: "react",
        },
        server: {
            // `npm run dev:console` talks to a locally running API.
            proxy: {
                [`${consoleBasePath}/runs`]: "http://127.0.0.1:4300",
                [`${consoleBasePath}/processes`]: "http://127.0.0.1:4300",
                [`${consoleBasePath}/skills`]: "http://127.0.0.1:4300",
                [`${consoleBasePath}/stats`]: "http://127.0.0.1:4300",
                [`${consoleBasePath}/caller-keys`]: "http://127.0.0.1:4300",
                ...(developmentGateway
                    ? { "/process-runs": developmentGateway }
                    : {}),
            },
        },
    };
});
