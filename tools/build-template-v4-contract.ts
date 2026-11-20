/** 核验 Memebuy 来源摘要并生成 Pipipi 执行的拆解检查器。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const source = process.argv[2];
if (!source) throw new Error("请提供 Memebuy 应用目录");
const directory = ".pi/skills/print-design-template-compiler";
const manifest = JSON.parse(readFileSync(`${directory}/source-manifest.json`, "utf8")) as {files: {path: string; sha256: string}[]};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const contents = new Map<string, string>();
for (const file of manifest.files) {
    const bytes = readFileSync(resolve(source, file.path));
    if (hash(bytes) !== file.sha256) throw new Error(`来源变化，请先审查：${file.path}`);
    contents.set(file.path, bytes.toString("utf8"));
}
const generated: Record<string, string> = {};
for (const [path, content] of contents) {
    if (!path.endsWith(".ts")) continue;
    const name = path.split("/").at(-1);
    generated[`src/processes/template-from-image/design-spec/vendor/${name}`] = '/** 从固定 Memebuy 来源生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */\n' + content
        .replaceAll("'zod'", '"zod"')
        .replaceAll("(a[i] as string).codePointAt(0)!", "((a[i] as string).codePointAt(0) ?? 0)")
        .replaceAll("(b[i] as string).codePointAt(0)!", "((b[i] as string).codePointAt(0) ?? 0)")
        .replaceAll("'@/modules/gallery/templates/design-spec-schema'", '"./design-spec-schema.js"')
        .replace(/from '\.\/([^']+)'/gu, 'from "./$1.js"');
}
const check = process.argv.includes("--check");
for (const [path, raw] of Object.entries(generated)) {
    const content = path.endsWith(".ts") ? execFileSync("node_modules/.bin/biome", ["check", "--write", "--stdin-file-path", path], {input: raw, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]}) : raw;
    if (check) { if (readFileSync(path, "utf8") !== content) throw new Error(`需要重建：${path}`); }
    else writeFileSync(path, content);
}
console.log(JSON.stringify({check, files: Object.keys(generated)}));
