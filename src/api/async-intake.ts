/** 文件标记控制的 POST /process-runs intake 开关 */
import { existsSync } from "node:fs";
import path from "node:path";

export type AsyncIntake = Readonly<{ isOpen: () => boolean }>;

/**
 * Treats a server-owned marker as a fail-safe operational intake switch.
 * Reads remain available because only POST /process-runs consults this seam.
 */
export function createFileControlledAsyncIntake(options: {
    disabledMarkerFile: string;
}): AsyncIntake {
    const marker = options.disabledMarkerFile.trim();
    if (!path.isAbsolute(marker) || marker.length > 4_096) {
        throw new Error(
            "ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE must be an absolute path",
        );
    }
    return Object.freeze({ isOpen: () => !existsSync(marker) });
}
