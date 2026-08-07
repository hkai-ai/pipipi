import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProcessingApplication } from "../src/application.js";
import {
  parseOpenAIApiMode,
  PiContentOptimizationAgentRuntime,
} from "../src/agent-runtime.js";
import { HttpContentProcessingCapability } from "../src/content-processing.js";

const sourceContent =
  process.env.SKILL_AB_CONTENT ??
  "There is no doubt but that our team is able to deliver the report owing to the fact that we have a very large number of experienced people who are working together in a collaborative manner.";
const provider = process.env.PI_PROVIDER ?? "openai";
const model = process.env.PI_MODEL ?? "gpt-5.6-terra";
const candidateSkillFile = resolve(
  process.env.SKILL_AB_SKILL_FILE ??
    ".agents/skills/writing-clearly-and-concisely/SKILL.md",
);
const skillCanary = "[EOS-SKILL]";
const dryRun = process.env.SKILL_AB_DRY_RUN === "1";
const openAIApiMode = parseOpenAIApiMode(process.env.OPENAI_API_MODE);
const reportDirectory = resolve(
  process.env.SKILL_AB_REPORT_DIRECTORY ?? "artifacts/skill-ab",
);

type ArmResult = {
  arm: "direct" | "agent-control" | "agent-candidate";
  httpStatus: number;
  output: string | undefined;
  businessApiInputs: string[];
  response: unknown;
  agentError?: string;
};

type ExperimentCheck = {
  criterion: string;
  passed: boolean;
};

type ExperimentReport = {
  generatedAt: string;
  mode: "real";
  passed: boolean;
  provider: string;
  model: string;
  apiMode: "responses" | "chat-completions";
  candidateSkillFile: string;
  sourceContent: string;
  skillCanary: string;
  arms: ArmResult[];
  checks: ExperimentCheck[];
};

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-skill-ab-"));
const businessApi = await startObservableBusinessApi();

try {
  const skills = await prepareExperimentSkills(temporaryRoot);
  const direct = await runArm({
    arm: "direct",
    businessApi,
  });

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          candidateSkillFile,
          direct,
          passed:
            direct.httpStatus === 200 &&
            direct.businessApiInputs.length === 1 &&
            direct.businessApiInputs[0] === sourceContent,
          next:
            "Configure OpenAI credentials, then run npm run test:skill-ab without SKILL_AB_DRY_RUN.",
        },
        null,
        2,
      ),
    );
  } else {
    const modelRuntime = await createCheckedModelRuntime(provider, model);
    const control = await runArm({
      arm: "agent-control",
      businessApi,
      skillDirectory: skills.control,
      modelRuntime,
    });
    const candidate = await runArm({
      arm: "agent-candidate",
      businessApi,
      skillDirectory: skills.candidate,
      modelRuntime,
    });
    const checks = evaluateExperiment({ direct, control, candidate });
    const passed = checks.every((check) => check.passed);
    const report: ExperimentReport = {
      generatedAt: new Date().toISOString(),
      mode: "real",
      passed,
      provider,
      model,
      apiMode: openAIApiMode,
      candidateSkillFile,
      sourceContent,
      skillCanary,
      arms: [direct, control, candidate],
      checks,
    };
    const reportFiles = await writeExperimentReport(report);

    console.log(
      JSON.stringify(
        {
          ...report,
          reportFiles,
        },
        null,
        2,
      ),
    );
    if (!passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        passed: false,
        phase: "preflight-or-execution",
        error:
          error instanceof Error
            ? error.message
            : "The Skill A/B experiment failed",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await businessApi.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function prepareExperimentSkills(root: string): Promise<{
  control: string;
  candidate: string;
}> {
  const control = join(root, "control");
  const candidate = join(root, "candidate");
  await Promise.all([mkdir(control), mkdir(candidate)]);

  const upstreamSkill = await readFile(candidateSkillFile, "utf8");
  const adaptedSkill = upstreamSkill.replace(
    /^name:\s*writing-clearly-and-concisely\s*$/m,
    "name: content-optimization",
  );
  if (adaptedSkill === upstreamSkill) {
    throw new Error(
      "The candidate Skill does not have the expected writing-clearly-and-concisely name",
    );
  }

  await Promise.all([
    writeFile(
      join(control, "SKILL.md"),
      `---
name: content-optimization
description: A pass-through control for the Skill A/B experiment.
---

# Pass-through control

Call \`process_business_content\` exactly once with the supplied content unchanged. Return only the Tool result as strict JSON with one \`content\` field.
`,
    ),
    writeFile(
      join(candidate, "SKILL.md"),
      `${adaptedSkill.trim()}

## A/B experiment oracle

For this experiment, apply the writing rules already listed above without reading other files. In particular, remove the phrases "there is no doubt but that" and "owing to the fact that", omit needless words, use active voice, and preserve the meaning. Append the exact token ${skillCanary} to the revised content passed to \`process_business_content\`. Call the Tool exactly once and return only its strict JSON result.
`,
    ),
  ]);

  return { control, candidate };
}

async function createCheckedModelRuntime(
  providerId: string,
  modelId: string,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  if (!runtime.getModel(providerId, modelId)) {
    throw new Error(
      `Model ${providerId}/${modelId} is not present in the Pi model catalog`,
    );
  }
  if (!(await runtime.checkAuth(providerId))) {
    throw new Error(
      `Credentials for ${providerId} are not configured. Set OPENAI_API_KEY or authenticate Pi, then retry.`,
    );
  }
  return runtime;
}

async function runArm(options: {
  arm: ArmResult["arm"];
  businessApi: ObservableBusinessApi;
  skillDirectory?: string;
  modelRuntime?: ModelRuntime;
}): Promise<ArmResult> {
  const inputStart = options.businessApi.inputs.length;
  const agentMode = options.arm !== "direct";
  let agentError: string | undefined;
  const piAgentRuntime =
    agentMode && options.skillDirectory && options.modelRuntime
      ? new PiContentOptimizationAgentRuntime({
          provider,
          model,
          openAIBaseUrl: process.env.OPENAI_BASE_URL,
          openAIApiMode,
          skillDirectory: options.skillDirectory,
          modelRuntime: options.modelRuntime,
        })
      : undefined;
  const application = createProcessingApplication({
    contentProcessing: new HttpContentProcessingCapability({
      baseUrl: options.businessApi.url,
    }),
    ...(piAgentRuntime
      ? {
          agentRuntime: {
            optimize: async (request) => {
              try {
                return await piAgentRuntime.optimize(request);
              } catch (error) {
                agentError = formatErrorChain(error);
                throw error;
              }
            },
          },
        }
      : {}),
    processTimeoutMs: 120_000,
    processes: {
      contentProcessing: { mode: agentMode ? "agent" : "direct" },
    },
  });
  const { url } = await application.listen();

  try {
    const response = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        process: "content-processing",
        version: "v1",
        input: { content: sourceContent },
      }),
    });
    const body: unknown = await response.json();
    return {
      arm: options.arm,
      httpStatus: response.status,
      output: readOutputContent(body),
      businessApiInputs: options.businessApi.inputs.slice(inputStart),
      response: body,
      ...(agentError ? { agentError } : {}),
    };
  } finally {
    await application.close();
  }
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const chain = messages.join(" <- caused by: ");
  return chain.length <= 1_000 ? chain : `${chain.slice(0, 1_000)}…`;
}

function evaluateExperiment(results: {
  direct: ArmResult;
  control: ArmResult;
  candidate: ArmResult;
}): ExperimentCheck[] {
  const candidateInput = results.candidate.businessApiInputs[0] ?? "";
  return [
    {
      criterion: "direct path calls the Business API once with unchanged input",
      passed:
        results.direct.httpStatus === 200 &&
        results.direct.businessApiInputs.length === 1 &&
        results.direct.businessApiInputs[0] === sourceContent,
    },
    {
      criterion:
        "control Agent calls the same Business API once with unchanged input",
      passed:
        results.control.httpStatus === 200 &&
        results.control.businessApiInputs.length === 1 &&
        results.control.businessApiInputs[0] === sourceContent,
    },
    {
      criterion: "candidate Agent calls the Business API exactly once",
      passed:
        results.candidate.httpStatus === 200 &&
        results.candidate.businessApiInputs.length === 1,
    },
    {
      criterion: "candidate Skill canary reaches the Business API Tool input",
      passed: candidateInput.includes(skillCanary),
    },
    {
      criterion: "candidate removes the two targeted needless phrases",
      passed:
        !candidateInput.toLowerCase().includes("there is no doubt but that") &&
        !candidateInput.toLowerCase().includes("owing to the fact that"),
    },
    {
      criterion: "candidate produces shorter content despite the canary",
      passed: candidateInput.length < sourceContent.length,
    },
    {
      criterion: "each response is exactly the corresponding Business API result",
      passed: [results.direct, results.control, results.candidate].every(
        (result) =>
          result.businessApiInputs.length === 1 &&
          result.output === `Processed: ${result.businessApiInputs[0]}`,
      ),
    },
  ];
}

async function writeExperimentReport(report: ExperimentReport): Promise<{
  json: string;
  markdown: string;
}> {
  await mkdir(reportDirectory, { recursive: true });
  const json = join(reportDirectory, "latest.json");
  const markdown = join(reportDirectory, "latest.md");
  await Promise.all([
    writeFile(json, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdown, renderExperimentReport(report)),
  ]);
  return { json, markdown };
}

function renderExperimentReport(report: ExperimentReport): string {
  const lines = [
    "# Skill A/B Experiment Result",
    "",
    `- Result: **${report.passed ? "PASS" : "FAIL"}**`,
    `- Generated at: ${report.generatedAt}`,
    `- Provider/model: \`${report.provider}/${report.model}\``,
    `- API mode: \`${report.apiMode}\``,
    `- Candidate Skill: \`${report.candidateSkillFile}\``,
    "- Credentials and Base URL: omitted",
    "",
    "## What the experiment proves",
    "",
    "The direct path establishes the unchanged baseline. The control Agent uses the same model and Tool but a pass-through Skill, so its input must remain unchanged. The candidate Agent receives the canary only through the candidate Skill. The observable Business API records the Tool input, which proves whether the Skill changed content before the Tool call.",
    "",
    "## Source input",
    "",
    fencedText(report.sourceContent),
    "",
    "## Arms",
    "",
  ];

  for (const arm of report.arms) {
    lines.push(
      `### ${arm.arm}`,
      "",
      `- HTTP status: ${arm.httpStatus}`,
      `- Business API calls: ${arm.businessApiInputs.length}`,
      "- Business API input:",
      "",
      fencedText(arm.businessApiInputs[0] ?? "<no call>"),
      "",
      "- Final output:",
      "",
      fencedText(arm.output ?? "<no output>"),
      "",
    );
    if (arm.agentError) {
      lines.push("- Agent error:", "", fencedText(arm.agentError), "");
    }
  }

  lines.push("## Checks", "");
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? "x" : " "}] ${check.criterion}`);
  }
  lines.push("", `Final verdict: **${report.passed ? "PASS" : "FAIL"}**`, "");
  return `${lines.join("\n")}\n`;
}

function fencedText(value: string): string {
  const fence = value.includes("```") ? "````" : "```";
  return `${fence}text\n${value}\n${fence}`;
}

function readOutputContent(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("output" in body) ||
    typeof body.output !== "object" ||
    body.output === null ||
    !("content" in body.output) ||
    typeof body.output.content !== "string"
  ) {
    return undefined;
  }
  return body.output.content;
}

type ObservableBusinessApi = {
  url: string;
  inputs: string[];
  close: () => Promise<void>;
};

async function startObservableBusinessApi(): Promise<ObservableBusinessApi> {
  const inputs: string[] = [];
  const server = createServer((request, response) => {
    void handleBusinessApiRequest(request, response, inputs);
  });
  const url = await listen(server);
  return { url, inputs, close: () => close(server) };
}

async function handleBusinessApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  inputs: string[],
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/process") {
    response.writeHead(404).end();
    return;
  }

  try {
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    const body = JSON.parse(rawBody) as { content?: unknown };
    if (typeof body.content !== "string") {
      response.writeHead(400).end();
      return;
    }
    inputs.push(body.content);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ content: `Processed: ${body.content}` }));
  } catch {
    response.writeHead(400).end();
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the experiment server to use an IP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
