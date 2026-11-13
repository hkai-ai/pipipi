/** 显式付费验收本地批准图片的 V4 拆解，经正式 HTTP 与独立看图复核保留本地证据。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInstalledSkillCatalog } from "../src/agent-runtime/catalog.js";
import { parseOpenAIApiMode } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import { resolveModelGateway } from "../src/model-gateway.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import { PiPrintDesignAgent } from "../src/processes/template-from-image/design-spec/agent.js";
import { skillRef } from "../src/processes/template-from-image/design-spec/contract.js";
import { createPrintDesignRegistration } from "../src/processes/template-from-image/design-spec/registration.js";
import { decodeTemplateImage } from "../src/processes/template-from-image/image.js";

if (process.env.RUN_TEMPLATE_PAID_ACCEPTANCE !== "1")
    throw new Error(
        "设置 RUN_TEMPLATE_PAID_ACCEPTANCE=1 才会调用真实模型并产生费用",
    );
const [file, directory] = process.argv.slice(2);
if (!file || !directory)
    throw new Error(
        "用法：template-v4-acceptance <已批准图片> <新的本地证据目录>",
    );
const output = resolve(directory);
await mkdir(output, { mode: 0o700 });
const image = await decodeTemplateImage(await readFile(file));
const skills = createInstalledSkillCatalog([skillRef], process.cwd()).resolve([
    skillRef,
]);
const provider = process.env.PI_PROVIDER ?? "openai";
const agent = new PiPrintDesignAgent({
    skills,
    provider,
    model:
        process.env.TEMPLATE_MODEL?.trim() ||
        (provider === "openai" ? "gpt-5.4" : process.env.PI_MODEL),
    gateway: resolveModelGateway(process.env),
    openAIApiMode: parseOpenAIApiMode(process.env.OPENAI_API_MODE),
});
let calls = 0;
const save = (name: string, data: unknown) =>
    writeFile(resolve(output, name), `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
    });
const registration = createPrintDesignRegistration({
    loadImage: async () => image,
    agent: {
        compile: async (request) => {
            calls++;
            const candidate = await agent.compile(request);
            await save(`candidate-${calls}.json`, candidate);
            return candidate;
        },
        review: async (request) => {
            calls++;
            const review = await agent.review(request);
            await save(`review-${calls}.json`, review);
            return review;
        },
    },
});
const app = createProcessingApplication({
    executor: createProcessExecutor({ registrations: [registration] }),
});
const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
try {
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            process: "template-from-image",
            version: "v3",
            input: {
                imageUrl: "https://images.example.com/approved-template.png",
            },
        }),
    });
    const result = await response.json();
    await save("http-result.json", result);
    console.log(
        JSON.stringify({
            status: response.status,
            calls,
            succeeded: response.ok,
        }),
    );
    if (!response.ok) process.exitCode = 1;
} finally {
    await app.close();
}
