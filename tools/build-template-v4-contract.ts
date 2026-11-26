/** 从 Memebuy 同步纯拆解 Schema 与检查器到 Pipipi vendor 目录并格式化。 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = process.argv[2];
if (!source) throw new Error("请提供 Memebuy 应用目录");

const MEMEBUY_FILES = [
    "src/modules/gallery/templates/design-spec-schema.ts",
    "src/modules/gallery/templates/design-spec-axes.ts",
    "src/modules/gallery/templates/design-spec-output.ts",
    "src/modules/gallery/generation/compile/design-spec-compiler/checks.ts",
    "src/modules/gallery/generation/compile/design-spec-compiler/vocabulary.ts",
    "src/modules/gallery/generation/compile/design-spec-compiler/types.ts",
    "src/modules/gallery/generation/compile/design-spec-compiler/py-compat.ts",
    "src/modules/gallery/generation/compile/design-spec-compiler/follow-texts.ts",
    "src/modules/gallery/generation/compile/design-spec-compiler/layout-json.ts",
] as const;

function transform(content: string): string {
    return (
        "/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */\n" +
        content
            .replaceAll("'zod'", '"zod"')
            .replaceAll(
                "(a[i] as string).codePointAt(0)!",
                "((a[i] as string).codePointAt(0) ?? 0)",
            )
            .replaceAll(
                "(b[i] as string).codePointAt(0)!",
                "((b[i] as string).codePointAt(0) ?? 0)",
            )
            .replaceAll(
                "'@/modules/gallery/templates/design-spec-schema'",
                '"./design-spec-schema.js"',
            )
            .replaceAll(
                "'@/modules/gallery/templates/design-spec-axes'",
                '"./design-spec-axes.js"',
            )
            .replaceAll(
                "'@/modules/gallery/templates/design-spec-output'",
                '"./design-spec-output.js"',
            )
            .replace(/from '\.\/([^']+)'/gu, 'from "./$1.js"')
    );
}

const generated: Record<string, string> = {};
for (const filePath of MEMEBUY_FILES) {
    const raw = readFileSync(resolve(source, filePath), "utf8");
    const name = filePath.split("/").at(-1);
    generated[`src/processes/template-from-image/design-spec/vendor/${name}`] =
        transform(raw);
}

const check = process.argv.includes("--check");
for (const [targetPath, raw] of Object.entries(generated)) {
    const content = execFileSync(
        "node_modules/.bin/biome",
        ["check", "--write", "--stdin-file-path", targetPath],
        { input: raw, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (check) {
        if (readFileSync(targetPath, "utf8") !== content)
            throw new Error(`需要重建：${targetPath}`);
    } else {
        writeFileSync(targetPath, content);
    }
}
console.log(JSON.stringify({ check, files: Object.keys(generated) }));
