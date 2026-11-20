// 从团队仓库的准确标签同步已接入的 Runtime Skill，并同时更新生产绑定。
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillSet } from "../src/agent-runtime/skills.ts";

const [name, version, ...extra] = process.argv.slice(2);
if (
    name !== "minimal-zine-poster-prompt" ||
    !/^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(version ?? "") ||
    extra.length
) {
    throw new Error(
        "用法：npm run skill:sync -- minimal-zine-poster-prompt v1",
    );
}

const repository = "git@github.com:hkai-ai/skills.git";
const snapshot = `.pi/skills/${name}`;
const lockPath = "src/processes/poster/skill-lock.json";
const tag = `${name}/${version}`;
const ref = `refs/pipipi-skill-sync/${randomUUID()}`;
const temp = mkdtempSync(join(tmpdir(), "pipipi-skill-"));
const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
const git = (args, input) =>
    execFileSync("git", args, { env, input, maxBuffer: 32 * 1024 * 1024 });
try {
    git([
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        repository,
        `refs/tags/${tag}:${ref}`,
    ]);
    const commit = git(["rev-parse", `${ref}^{commit}`])
        .toString()
        .trim();
    const tree = git(["rev-parse", `${commit}:skills/${name}`])
        .toString()
        .trim();
    const files = git(["ls-tree", tree]).toString().trimEnd().split("\n");
    const entries = files.map((line) => {
        const match =
            /^100644 blob ([a-f0-9]{40})\t(LICENSE|SKILL\.md|SOURCE\.md|cover\.webp)$/.exec(
                line,
            );
        if (!match)
            throw new Error("海报 Skill 的文件清单已变化，请先审查新文件");
        return { oid: match[1], file: match[2] };
    });
    if (entries.length !== 4) throw new Error("海报 Skill 缺少已登记文件");
    const skill = entries.find((entry) => entry.file === "SKILL.md");
    const sha256 = createHash("sha256")
        .update(git(["cat-file", "blob", skill.oid]))
        .digest("hex");
    const lock = { repository, name, version, commit, tree, sha256 };
    let previous;
    try {
        previous = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    if (previous?.version === version && previous.commit !== commit)
        throw new Error("已选版本的标签指向发生变化");

    // 用临时索引生成一份补丁，文件和锁记录一起应用，不碰开发者的暂存区。
    git(["read-tree", "--empty"]);
    git(["add", "-f", "--", snapshot]);
    if (previous) git(["add", "-f", "--", lockPath]);
    const before = git(["write-tree"]).toString().trim();
    const localTree = git(["rev-parse", `${before}:${snapshot}`])
        .toString()
        .trim();
    if (localTree !== (previous?.tree ?? tree))
        throw new Error("本地快照有差异，请先保存并核对修改");
    for (const { oid, file } of entries) {
        git([
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${oid},${snapshot}/${file}`,
        ]);
    }
    const oid = git(
        ["hash-object", "-w", "--stdin"],
        JSON.stringify(lock, null, 4) + "\n",
    )
        .toString()
        .trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${oid},${lockPath}`]);
    const after = git(["write-tree"]).toString().trim();
    git(["checkout-index", "--all", `--prefix=${temp}/`]);
    createSkillSet([{ name, version, sha256, path: snapshot }], temp).load();
    const patch = git([
        "diff-tree",
        "-r",
        "--binary",
        "--no-renames",
        "--no-commit-id",
        before,
        after,
    ]);
    if (patch.length)
        git(["apply", "--binary", "--whitespace=nowarn", "-"], patch);
    console.log(
        `${tag} @ ${commit} · ${patch.length ? "已同步" : "已是所选快照"}`,
    );
} finally {
    try {
        git(["update-ref", "-d", ref]);
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
