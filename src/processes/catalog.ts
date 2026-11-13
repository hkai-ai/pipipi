/** 显式 production catalog 和通用 Process Runtime 组装 */
import {
    createProcessRegistry,
    createProcessRunner,
    type ProcessExecutor,
    type ProcessRegistration,
    type ProcessRegistry,
    type ProcessRunLogClock,
    type ProcessRunLogSink,
} from "../process-runtime/index.js";
import type { ProcessRunRecords } from "../process-runtime/records.js";
import {
    characterEmojiProduction,
    characterEmojiV3Production,
    characterEmojiV4Production,
} from "./character-emoji/production.js";
import { composedProduction } from "./composed/production.js";
import { crtProduction } from "./crt/production.js";
import {
    narrativeMonumentProduction,
    paleWatercolorProduction,
    rawHumanismProduction,
} from "./news-image/production.js";
import {
    crayonProduction,
    dopamineProduction,
    mangaPanelsProduction,
    memoryChecklistProduction,
    monoColorProduction,
    monoColorV2Production,
    monochromeProduction,
    photoDoodleCollageProduction,
    photoFashionMangaProduction,
    risographAlbumProduction,
    travelAbstractionProduction,
    woodcutProduction,
} from "./photo-poster/production.js";
import { posterProduction } from "./poster/production.js";
import type { ProductionProcess } from "./production.js";
import { printDesignProduction } from "./template-from-image/design-spec/production.js";
import {
    templateProduction,
    templateV2Production,
} from "./template-from-image/production.js";
import {
    templatePlanProduction,
    templateRenderProduction,
    templateSourceProduction,
    templateSourceV2Production,
    templateSourceV3Production,
} from "./template-from-source/production.js";

/**
 * The explicit production catalog: one entry per exact `(id, version)`, each
 * owning how it is built from the startup environment. Nothing is discovered,
 * defaulted, or fallen back to; a Process ships only when it is listed here.
 * `composed-task` composes the others and ships switched off by default.
 */
export const productionCatalog: readonly ProductionProcess[] = Object.freeze([
    posterProduction,
    crtProduction,
    paleWatercolorProduction,
    rawHumanismProduction,
    narrativeMonumentProduction,
    dopamineProduction,
    monoColorProduction,
    monoColorV2Production,
    travelAbstractionProduction,
    crayonProduction,
    monochromeProduction,
    woodcutProduction,
    photoDoodleCollageProduction,
    photoFashionMangaProduction,
    mangaPanelsProduction,
    memoryChecklistProduction,
    risographAlbumProduction,
    characterEmojiProduction,
    characterEmojiV3Production,
    characterEmojiV4Production,
    templateProduction,
    templateV2Production,
    printDesignProduction,
    templatePlanProduction,
    templateRenderProduction,
    templateSourceProduction,
    templateSourceV2Production,
    templateSourceV3Production,
    composedProduction,
]);

export type ProcessRuntimeOptions = {
    registrations: readonly ProcessRegistration[];
    processTimeoutMs?: number;
    runRecords?: ProcessRunRecords;
    runLogSink?: ProcessRunLogSink;
    runLogClock?: ProcessRunLogClock;
};

export type ProcessRuntime = Readonly<{
    registry: ProcessRegistry;
    executor: ProcessExecutor;
}>;

export function createProcessExecutor(
    options: ProcessRuntimeOptions,
): ProcessExecutor {
    return createProcessRuntime(options).executor;
}

export function createProcessRuntime(
    options: ProcessRuntimeOptions,
): ProcessRuntime {
    if (
        !Array.isArray(options.registrations) ||
        options.registrations.length === 0
    ) {
        throw new Error("At least one Process Registration is required");
    }
    const registry = createProcessRegistry(options.registrations);

    return Object.freeze({
        registry,
        executor: createProcessRunner({
            registry,
            processTimeoutMs: options.processTimeoutMs,
            runRecords: options.runRecords,
            runLogSink: options.runLogSink,
            runLogClock: options.runLogClock,
        }),
    });
}
