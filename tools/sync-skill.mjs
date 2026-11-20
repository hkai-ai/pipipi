// 从团队仓库的准确标签同步已接入的 Runtime Skill，并同时更新生产绑定。
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillSet } from "../src/agent-runtime/skills.ts";

const lockPath = "src/agent-runtime/skill-lock.json";
const initialLock = readFileSync(lockPath, "utf8");
const lock = JSON.parse(initialLock);
const [name, version, ...extra] = process.argv.slice(2);

if (
    !Object.hasOwn(lock.skills, name) ||
    !/^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(version ?? "") ||
    extra.length
) {
    throw new Error("用法：npm run skill:sync -- <已接入的 Skill 名称> <版本>");
}

const repository = lock.repository;
const snapshot = `.pi/skills/${name}`;
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
    const previous = lock.skills[name];
    if (previous.version === version && previous.commit !== commit)
        throw new Error("已选版本的标签指向发生变化");
    // 用临时索引生成一份补丁，文件和锁记录一起应用，不碰开发者的暂存区。
    git(["read-tree", "--empty"]);
    git(["add", "-f", "--", snapshot]);
    git(["add", "-f", "--", lockPath]);
    const before = git(["write-tree"]).toString().trim();
    if (
        git(["show", `${before}:${lockPath}`]).toString() !==
        initialLock.replaceAll("\r\n", "\n")
    )
        throw new Error("版本清单已变化，请重新同步");
    const localTree = git(["rev-parse", `${before}:${snapshot}`])
        .toString()
        .trim();
    if (localTree !== previous.tree)
        throw new Error("本地快照有差异，请先保存并核对修改");
    // 文件清单或模式变化需要单独审核；同步只替换已登记的普通文件。
    const inventory = (treeId) =>
        git(["ls-tree", "-r", treeId]).toString().trimEnd().split("\n");
    const files = inventory(tree);
    const shape = (rows) =>
        rows.map((row) => row.replace(/ [0-9a-f]{40}\t/, "\t")).join("\n");
    if (shape(files) !== shape(inventory(localTree)))
        throw new Error("文件清单或模式发生变化，请先审查");
    for (const row of files) {
        const match = /^100644 blob ([0-9a-f]{40})\t([a-zA-Z0-9_.-]+)$/.exec(
            row,
        );
        if (!match) throw new Error("快照包含未登记的文件类型或路径");
        git([
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${match[1]},${snapshot}/${match[2]}`,
        ]);
    }
    const sha256 = createHash("sha256")
        .update(git(["cat-file", "blob", `${tree}:SKILL.md`]))
        .digest("hex");
    lock.skills[name] = { version, commit, tree, sha256 };
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
