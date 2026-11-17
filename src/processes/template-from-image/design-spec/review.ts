/** 将独立看图复核限制在现有候选路径并校验摘要、最终检查和字段证据。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
    candidateIssues,
    type PrintDesignCandidate,
    PrintDesignContractError,
    readCandidate,
} from "./contract.js";
export const candidateDigest = (candidate: PrintDesignCandidate) =>
    createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
const escapePart = (part: string) =>
    part.replaceAll("~", "~0").replaceAll("/", "~1");
export function candidatePaths(value: unknown, prefix = ""): string[] {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) => {
        const path = `${prefix}/${escapePart(key)}`;
        return [path, ...candidatePaths(child, path)];
    });
}
const reviewChecks = [
    "imageFidelity",
    "layoutAndText",
    "printForm",
    "inputBindings",
    "defaultMigration",
    "sourceIsolation",
] as const;
const evidencePath = z
    .string()
    .min(1)
    .max(500)
    .regex(/^\/(draft|observation)\//u);
function detailPath(pointer: string) {
    return pointer
        .slice(1)
        .split("/")
        .map((key) => (/^\d+$/.test(key) ? Number(key) : key));
}
export function reviewSchema(candidate: PrintDesignCandidate) {
    const paths = candidatePaths(candidate);
    const containers = [
        "/draft/inputSchema/slots",
        "/draft/runtimeSemantics/targetInstances",
        "/draft/runtimeSemantics/inputBindings",
        "/draft/runtimeSemantics/designSpec/elements",
        "/draft/runtimeSemantics/designSpec/defaults",
        "/draft/runtimeSemantics/designSpec/whole",
    ];
    const editable = paths.filter(
        (path) =>
            [
                "/draft/key",
                "/draft/title",
                "/draft/description",
                "/draft/metadata/tags",
                "/observation/overview",
                "/observation/texts",
                "/observation/printRisks",
                "/observation/sourceCondition",
            ].includes(path) ||
            /^\/observation\/sourceCondition\/(marks|carrier|sharpness|compressionArtifacts|notes)$/u.test(
                path,
            ) ||
            /^\/draft\/runtimeSemantics\/designSpec\/whole\/composition\/relations\/\d+$/u.test(
                path,
            ) ||
            /^\/observation\/texts\/\d+\/(text|elementId)$/u.test(path) ||
            path.startsWith(
                "/draft/runtimeSemantics/designSpec/defaults/texts/",
            ) ||
            /^\/draft\/inputSchema\/slots\/\d+\/text\/defaultValue$/u.test(
                path,
            ) ||
            containers.some(
                (parent) =>
                    path === parent ||
                    (path.startsWith(`${parent}/`) &&
                        !path.slice(parent.length + 1).includes("/")),
            ) ||
            (path.startsWith("/draft/runtimeSemantics/designSpec/") &&
                !path
                    .slice("/draft/runtimeSemantics/designSpec/".length)
                    .includes("/") &&
                path !== "/draft/runtimeSemantics/designSpec/whole"),
    );
    const check = z.strictObject({
        passed: z.boolean(),
        evidence: z
            .array(
                z.strictObject({
                    path: evidencePath,
                    observation: z.string().trim().min(1).max(1000),
                }),
            )
            .min(1)
            .max(12),
    });
    return z.strictObject({
        reviewedCandidateSha256: z.literal(candidateDigest(candidate)),
        changes: z
            .array(
                z.strictObject({
                    path: z.enum(editable as [string, ...string[]]),
                    valueJson: z.string().min(1).max(100000),
                }),
            )
            .max(16),
        checks: z.strictObject({
            imageFidelity: check,
            layoutAndText: check,
            printForm: check,
            inputBindings: check,
            defaultMigration: check,
            sourceIsolation: check,
        }),
        issues: z
            .array(
                z.strictObject({
                    check: z.enum(reviewChecks),
                    path: evidencePath,
                    reason: z.string().trim().min(1).max(1000),
                }),
            )
            .max(20),
    });
}
/** 被跳过的复核补丁：下标与固定规则码，不含路径文本或补丁值。 */
export type SkippedPatch = Readonly<{ index: number; code: string }>;
export type AppliedReview = Readonly<{
    candidate: PrintDesignCandidate;
    skipped: readonly SkippedPatch[];
}>;
const pointerParts = (path: string) =>
    path
        .slice(1)
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
/** 把一条补丁写入克隆；路径不存在时返回 undefined。 */
function patched(
    base: unknown,
    parts: readonly string[],
    value: unknown,
): unknown {
    const next: unknown = structuredClone(base);
    let parent: unknown = next;
    for (const part of parts.slice(0, -1)) {
        if (
            !parent ||
            typeof parent !== "object" ||
            !Object.hasOwn(parent, part)
        )
            return undefined;
        parent = Reflect.get(parent, part);
    }
    const key = parts.at(-1);
    if (
        !key ||
        !parent ||
        typeof parent !== "object" ||
        !Object.hasOwn(parent, key)
    )
        return undefined;
    Reflect.set(parent, key, value);
    return next;
}
/**
 * 合同可读时返回剩余问题数（含复核证据指向的已删除路径）；不可读返回 undefined。
 * 数值越小越好，用来判断一条补丁是否让候选变差。
 */
function measure(
    value: unknown,
    evidence: readonly string[],
): { candidate: PrintDesignCandidate; score: number } | undefined {
    try {
        const candidate = readCandidate(value);
        const paths = new Set(candidatePaths(candidate));
        return {
            candidate,
            score:
                candidateIssues(candidate).length +
                evidence.filter((path) => !paths.has(path)).length,
        };
    } catch (error) {
        if (error instanceof PrintDesignContractError) return undefined;
        throw error;
    }
}
/**
 * 合并复核补丁而不让它把合格候选改坏。复核明确阻断（issues 或未通过的检查）
 * 仍直接失败；其余补丁先整体合并，整体不比原候选差则采用，否则逐条应用，
 * 让候选合同更差或无法读取的补丁跳过并记入返回值。不增加模型调用。
 */
export function applyReview(
    candidate: PrintDesignCandidate,
    raw: unknown,
): AppliedReview {
    if ((JSON.stringify(raw)?.length ?? Infinity) > 150000)
        throw new PrintDesignContractError(
            ["独立复核超出限制"],
            [{ path: ["review"], code: "too_big" }],
        );
    const parsed = reviewSchema(candidate).safeParse(raw);
    if (!parsed.success)
        throw new PrintDesignContractError(
            ["独立复核格式或摘要不匹配"],
            parsed.error.issues.map((issue) => ({
                path: ["review", ...issue.path],
                code:
                    issue.path[0] === "reviewedCandidateSha256"
                        ? "digest_mismatch"
                        : issue.code,
            })),
        );
    const review = parsed.data;
    if (
        review.issues.length ||
        Object.values(review.checks).some((check) => !check.passed)
    ) {
        const paths = new Set(candidatePaths(candidate));
        const rejected = Object.entries(review.checks).filter(
            ([, check]) => !check.passed,
        );
        throw new PrintDesignContractError(
            ["独立复核仍有未解决问题"],
            [
                ...rejected.map(([name]) => ({
                    path: ["review", "checks", name, "passed"],
                    code: "check_failed",
                })),
                ...review.issues.flatMap((issue, index) => [
                    {
                        path: ["review", "checks", issue.check],
                        code: "unresolved_review",
                    },
                    paths.has(issue.path)
                        ? {
                              path: detailPath(issue.path),
                              code: "review_evidence",
                          }
                        : {
                              path: ["review", "issues", index, "path"],
                              code: "missing_reference",
                          },
                ]),
                ...rejected.flatMap(([, check]) =>
                    check.evidence
                        .filter((item) => paths.has(item.path))
                        .map((item) => ({
                            path: detailPath(item.path),
                            code: "review_evidence",
                        })),
                ),
            ],
        );
    }
    const evidence = Object.values(review.checks).flatMap((check) =>
        check.evidence.map((item) => item.path),
    );
    const skipped: SkippedPatch[] = [];
    const decoded: {
        index: number;
        path: string;
        parts: string[];
        value: unknown;
    }[] = [];
    for (const [index, change] of review.changes.entries()) {
        if (
            decoded.some(
                ({ path }) =>
                    change.path === path ||
                    change.path.startsWith(`${path}/`) ||
                    path.startsWith(`${change.path}/`),
            )
        ) {
            skipped.push({ index, code: "patch_overlap" });
            continue;
        }
        let value: unknown;
        try {
            value = JSON.parse(change.valueJson);
        } catch {
            skipped.push({ index, code: "invalid_json" });
            continue;
        }
        const parts = pointerParts(change.path);
        if (patched(candidate, parts, value) === undefined) {
            skipped.push({ index, code: "missing_reference" });
            continue;
        }
        decoded.push({ index, path: change.path, parts, value });
    }
    const base = measure(candidate, evidence);
    if (!base)
        throw new PrintDesignContractError(
            ["复核的候选无法读取"],
            [{ path: ["review"], code: "contract" }],
        );
    let current = base;
    const apply = (state: unknown, item: (typeof decoded)[number]) =>
        patched(state, item.parts, item.value);
    const all = decoded.reduce<unknown>(
        (state, item) => (state === undefined ? state : apply(state, item)),
        current.candidate,
    );
    const whole = all === undefined ? undefined : measure(all, evidence);
    if (whole && whole.score <= base.score) current = whole;
    else {
        let pending = decoded;
        for (let pass = 0; pass < 2 && pending.length; pass++) {
            const rejected: typeof decoded = [];
            for (const item of pending) {
                const next = apply(current.candidate, item);
                const measured =
                    next === undefined ? undefined : measure(next, evidence);
                if (measured && measured.score <= current.score)
                    current = measured;
                else rejected.push(item);
            }
            if (rejected.length === pending.length) break;
            pending = rejected;
        }
        for (const item of pending)
            skipped.push({ index: item.index, code: "patch_rejected" });
    }
    const finalPaths = new Set(candidatePaths(current.candidate));
    for (const [name, check] of Object.entries(review.checks)) {
        const missing = check.evidence.findIndex(
            (item) => !finalPaths.has(item.path),
        );
        if (missing >= 0)
            throw new PrintDesignContractError(
                ["复核证据引用了已删除的字段"],
                [
                    {
                        path: [
                            "review",
                            "checks",
                            name,
                            "evidence",
                            missing,
                            "path",
                        ],
                        code: "missing_reference",
                    },
                ],
            );
    }
    return {
        candidate: current.candidate,
        skipped: skipped.toSorted((a, b) => a.index - b.index),
    };
}
