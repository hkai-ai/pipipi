/** 显式付费验收本地批准图片的 v3 编译，经真实 HTTP、模型与独立复核输出脱敏模板。 */

import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createInstalledSkillCatalog } from "../src/agent-runtime/catalog.js";
import { parseOpenAIApiMode } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import { resolveModelGateway } from "../src/model-gateway.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import { PiTemplateAgent } from "../src/processes/template-from-image/agent.pi.js";
import { decodeTemplateImage } from "../src/processes/template-from-image/image.js";
import { createTemplateRegistration } from "../src/processes/template-from-image/registration.js";
import { createTemplateSkillRefs } from "../src/processes/template-from-image/skills.js";

if (process.env.RUN_TEMPLATE_PAID_ACCEPTANCE !== "1")
    throw new Error(
        "设置 RUN_TEMPLATE_PAID_ACCEPTANCE=1 才会调用真实模型并产生费用",
    );
const [imageFile, outputDirectory] = process.argv.slice(2);
if (!imageFile || !outputDirectory)
    throw new Error("用法：template-v3-acceptance <批准图片文件> <证据目录>");
const output = resolve(outputDirectory);
await mkdir(dirname(output), { recursive: true });
// 每轮验收独立保存，禁止覆盖已产生费用的请求及失败证据。
await mkdir(output);
const image = await decodeTemplateImage(await readFile(imageFile));
const refs = createTemplateSkillRefs();
const skills = createInstalledSkillCatalog(refs, process.cwd()).resolve(refs);
let sessions = 0;
const agent = new PiTemplateAgent({
    sessionFactory: async (options) => {
        const result = await createAgentSession(options);
        const index = ++sessions;
        const dispose = result.session.dispose.bind(result.session);
        result.session.dispose = () => {
            writeFileSync(
                resolve(output, `response-${index}.json`),
                JSON.stringify(
                    result.session.messages.filter(
                        (message) => message.role === "assistant",
                    ),
                    null,
                    2,
                ),
            );
            dispose();
        };
        return result;
    },
    skills,
    runtimeVersion: 3,
    provider: process.env.PI_PROVIDER ?? "openai",
    model: process.env.TEMPLATE_MODEL ?? "gpt-5.4",
    gateway: resolveModelGateway(process.env),
    openAIApiMode: parseOpenAIApiMode(process.env.OPENAI_API_MODE),
});
let calls = 0;
const registration = createTemplateRegistration({
    runtimeVersion: 3,
    agent: {
        async compile(request) {
            calls++;
            const plan = await agent
                .compile(request)
                .catch((error: unknown) => {
                    const cause =
                        error instanceof Error ? error.cause : undefined;
                    const message =
                        cause instanceof Error ? cause.message : "unknown";
                    console.error(
                        JSON.stringify({
                            event: "model_failure",
                            category: /timeout|timed out/i.test(message)
                                ? "timeout"
                                : /401|unauthorized|invalid.*key/i.test(message)
                                  ? "authentication"
                                  : /404|model.*not.*found/i.test(message)
                                    ? "model_unavailable"
                                    : /502|503|504|bad gateway|APIConnectionError|TransferEncodingError/i.test(
                                            message,
                                        )
                                      ? "upstream_unavailable"
                                      : /400|unsupported|invalid.*param/i.test(
                                              message,
                                          )
                                        ? "request_rejected"
                                        : "other",
                        }),
                    );
                    throw error;
                });
            await writeFile(
                resolve(output, `plan-${calls}.json`),
                JSON.stringify(plan, null, 2),
            );
            return plan;
        },
        async review(request) {
            calls++;
            const result = await agent
                .review(request)
                .catch((error: unknown) => {
                    console.error(
                        JSON.stringify({
                            event: "review_failure",
                            category: "invalid_or_unavailable",
                        }),
                    );
                    throw error;
                });
            await writeFile(
                resolve(output, "reviewed.json"),
                JSON.stringify(result, null, 2),
            );
            return result;
        },
    },
    loadImage: async () => image,
    onDiagnostic: (record) => console.log(JSON.stringify(record)),
});
const app = createProcessingApplication({
    executor: createProcessExecutor({ registrations: [registration] }),
});
const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
try {
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            process: "template-from-image",
            version: "v2",
            input: {
                imageUrl: "https://images.example.com/approved-template.png",
            },
        }),
        signal: AbortSignal.timeout(510000),
    });
    const result: unknown = await response.json();
    await writeFile(
        resolve(output, "result.json"),
        JSON.stringify(result, null, 2),
    );
    const succeeded =
        result !== null &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "succeeded";
    console.log(
        JSON.stringify({ httpStatus: response.status, succeeded, calls }),
    );
    if (!succeeded) process.exitCode = 1;
} finally {
    await app.close();
}
