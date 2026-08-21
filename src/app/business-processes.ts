/** production Business Process Runtime：向 catalog 中每个 Process 提供共享配置并组装 Runner */
import { parseOpenAIApiMode } from "../agent-runtime/pi.js";
import {
    combineProcessRunLogSinks,
    createProcessAttemptRunner,
    type ProcessRunLogSink,
} from "../process-runtime/index.js";
import type { ProcessRunRecords } from "../process-runtime/records.js";
import {
    createProcessRuntime,
    type ProcessRuntime,
    productionCatalog,
} from "../processes/catalog.js";
import {
    buildProductionRegistrations,
    type ProductionContext,
} from "../processes/production.js";
import { createPinoProcessRunLogSink } from "../run-observation/pino.js";
import { parsePositiveInteger, type StartupEnvironment } from "./config.js";
import { createProductionSkillBindings } from "./runtime-skills.js";

export function createProductionRuntime(
    environment: StartupEnvironment,
    options: {
        runLogSink?: ProcessRunLogSink;
        /**
         * Extra destinations for the same activity records, composed with the
         * Pino Sink rather than replacing it. Persisting activity records must
         * not change what operators already read from stdout.
         */
        additionalRunLogSinks?: readonly ProcessRunLogSink[];
        runRecords?: ProcessRunRecords;
    } = {},
): ProcessRuntime {
    const baseRunLogSink =
        options.runLogSink ??
        createPinoProcessRunLogSink({
            level: environment.PROCESS_RUN_LOG_LEVEL,
        });
    const runLogSink = options.additionalRunLogSinks?.length
        ? combineProcessRunLogSinks(
              baseRunLogSink,
              ...options.additionalRunLogSinks,
          )
        : baseRunLogSink;
    const positiveInteger: ProductionContext["positiveInteger"] = (
        name,
        fallback,
    ) => parsePositiveInteger(environment[name], fallback, name);
    const pi: ProductionContext["pi"] = {
        provider: environment.PI_PROVIDER,
        model: environment.PI_MODEL,
        openAIBaseUrl: environment.OPENAI_BASE_URL,
        openAIApiMode: parseOpenAIApiMode(environment.OPENAI_API_MODE),
        agentDir: environment.PI_AGENT_DIR,
    };
    const skills = createProductionSkillBindings(environment);
    const processTimeoutMs = positiveInteger("PROCESS_TIMEOUT_MS", 30_000);
    const registrations = buildProductionRegistrations({
        catalog: productionCatalog,
        environment,
        pi,
        skills,
        positiveInteger,
        // Member Steps share the top-level Sink and default limit so a composed
        // Run's timeline reads like any other Run's.
        attemptRunner: createProcessAttemptRunner({
            processTimeoutMs,
            logSink: runLogSink,
        }),
    });
    return createProcessRuntime({
        registrations,
        processTimeoutMs,
        runLogSink,
        ...(options.runRecords ? { runRecords: options.runRecords } : {}),
    });
}
