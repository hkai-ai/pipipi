import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ContentProcessingCapability } from "./business-capabilities.js";

const businessContentToolName = "process_business_content";
const contentOptimizationSkillName = "content-optimization";

export type ContentOptimizationAgentRequest = {
  content: string;
  signal: AbortSignal;
  contentProcessing: ContentProcessingCapability;
};

export type ContentOptimizationAgentRuntime = {
  optimize: (request: ContentOptimizationAgentRequest) => Promise<unknown>;
};

export type PiContentOptimizationAgentRuntimeOptions = {
  cwd?: string;
  agentDir?: string;
  skillDirectory?: string;
  provider?: string;
  model?: string;
  modelRuntime?: ModelRuntime;
};

/**
 * The production Agent adapter. Conversation state is deliberately request-local;
 * the model/auth runtime may be shared because it carries no business messages.
 */
export class PiContentOptimizationAgentRuntime
  implements ContentOptimizationAgentRuntime
{
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #skillDirectory: string;
  readonly #provider: string | undefined;
  readonly #model: string | undefined;
  readonly #providedModelRuntime: ModelRuntime | undefined;
  #modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(options: PiContentOptimizationAgentRuntimeOptions = {}) {
    if ((options.provider === undefined) !== (options.model === undefined)) {
      throw new Error("Pi provider and model must be configured together");
    }

    this.#cwd = resolve(options.cwd ?? process.cwd());
    this.#agentDir = options.agentDir ?? getAgentDir();
    this.#skillDirectory = resolve(
      options.skillDirectory ??
        resolve(this.#cwd, ".pi/skills/content-optimization"),
    );
    this.#provider = options.provider;
    this.#model = options.model;
    this.#providedModelRuntime = options.modelRuntime;
  }

  async optimize(request: ContentOptimizationAgentRequest): Promise<unknown> {
    const loadedSkills = loadSkillsFromDir({
      dir: this.#skillDirectory,
      source: "business-processing-service",
    });
    const optimizationSkills = loadedSkills.skills.filter(
      (skill) => skill.name === contentOptimizationSkillName,
    );
    if (optimizationSkills.length !== 1) {
      throw new Error("The content optimization Skill is unavailable");
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt:
        "You are a business content optimization agent. Follow the loaded Skill and return only the requested structured result.",
      skillsOverride: () => ({
        skills: optimizationSkills,
        diagnostics: loadedSkills.diagnostics,
      }),
    });
    await resourceLoader.reload();

    const businessContentTool = defineTool({
      name: businessContentToolName,
      label: "Process business content",
      description:
        "Run content through the service's existing Business Capability.",
      parameters: Type.Object(
        {
          content: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, input, toolSignal) => {
        const signal = toolSignal
          ? AbortSignal.any([request.signal, toolSignal])
          : request.signal;
        const result = await request.contentProcessing.process(input, {
          signal,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: {},
        };
      },
    });

    const modelRuntime = await this.#getModelRuntime();
    const selectedModel =
      this.#provider && this.#model
        ? modelRuntime.getModel(this.#provider, this.#model)
        : undefined;
    if (this.#provider && !selectedModel) {
      throw new Error("The configured Pi model is unavailable");
    }

    // A fresh in-memory manager and session prevent messages from crossing requests.
    const { session } = await createAgentSession({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
      modelRuntime,
      ...(selectedModel ? { model: selectedModel } : {}),
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.#cwd),
      customTools: [businessContentTool],
      tools: [businessContentToolName],
    });
    const abortSession = () => {
      void session.abort();
    };
    request.signal.addEventListener("abort", abortSession, { once: true });

    try {
      if (request.signal.aborted) throw new Error("Agent request was aborted");
      await session.prompt(
        `/skill:${contentOptimizationSkillName} Optimize this content: ${JSON.stringify(request.content)}\n` +
          `Call ${businessContentToolName} as directed by the Skill. ` +
          'Return only JSON matching {"content":"non-empty string"}.',
      );
      return parseLastAssistantJson(session.messages);
    } finally {
      request.signal.removeEventListener("abort", abortSession);
      session.dispose();
    }
  }

  #getModelRuntime(): Promise<ModelRuntime> {
    if (this.#providedModelRuntime) {
      return Promise.resolve(this.#providedModelRuntime);
    }
    this.#modelRuntimePromise ??= ModelRuntime.create();
    return this.#modelRuntimePromise;
  }
}

function parseLastAssistantJson(messages: readonly unknown[]): unknown {
  const message = messages.findLast(isAssistantMessage);
  if (
    !message ||
    message.stopReason === "error" ||
    message.stopReason === "aborted"
  ) {
    throw new Error("The Agent did not produce a successful response");
  }

  const text = message.content
    .filter(isTextContent)
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text) throw new Error("The Agent response was empty");
  return JSON.parse(text);
}

function isAssistantMessage(value: unknown): value is {
  role: "assistant";
  content: unknown[];
  stopReason?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function isTextContent(value: unknown): value is {
  type: "text";
  text: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}
