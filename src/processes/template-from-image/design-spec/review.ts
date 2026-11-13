/** 将独立看图复核限制在现有候选路径并校验摘要、最终检查和字段证据。 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
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
            ].includes(path) ||
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
                    path: z
                        .string()
                        .min(1)
                        .max(500)
                        .regex(/^\/(draft|observation)\//u),
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
        issues: z.array(z.string().trim().min(1).max(1000)).max(20),
    });
}
export function applyReview(
    candidate: PrintDesignCandidate,
    raw: unknown,
): PrintDesignCandidate {
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
                ...(review.issues.length
                    ? [
                          {
                              path: ["review", "issues"],
                              code: "unresolved_review",
                          },
                      ]
                    : []),
                ...rejected.flatMap(([, check]) =>
                    check.evidence
                        .filter((item) => paths.has(item.path))
                        .map((item) => ({
                            path: item.path
                                .slice(1)
                                .split("/")
                                .map((key) =>
                                    /^\d+$/.test(key) ? Number(key) : key,
                                ),
                            code: "review_evidence",
                        })),
                ),
            ],
        );
    }
    const updated: unknown = structuredClone(candidate);
    const seen: string[] = [];
    for (const [index, change] of review.changes.entries()) {
        if (
            seen.some(
                (path) =>
                    change.path === path ||
                    change.path.startsWith(`${path}/`) ||
                    path.startsWith(`${change.path}/`),
            )
        )
            throw new PrintDesignContractError(
                ["复核补丁路径冲突"],
                [
                    {
                        path: ["review", "changes", index, "path"],
                        code: "patch_overlap",
                    },
                ],
            );
        seen.push(change.path);
        const parts = change.path
            .slice(1)
            .split("/")
            .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
        let parent: unknown = updated;
        for (const part of parts.slice(0, -1)) {
            if (
                !parent ||
                typeof parent !== "object" ||
                !Object.hasOwn(parent, part)
            )
                throw new PrintDesignContractError(
                    ["复核补丁路径不存在"],
                    [
                        {
                            path: ["review", "changes", index, "path"],
                            code: "missing_reference",
                        },
                    ],
                );
            parent = Reflect.get(parent, part);
        }
        const key = parts.at(-1);
        if (
            !key ||
            !parent ||
            typeof parent !== "object" ||
            !Object.hasOwn(parent, key)
        )
            throw new PrintDesignContractError(
                ["复核补丁路径不存在"],
                [
                    {
                        path: ["review", "changes", index, "path"],
                        code: "missing_reference",
                    },
                ],
            );
        let value: unknown;
        try {
            value = JSON.parse(change.valueJson);
        } catch {
            throw new PrintDesignContractError(
                ["复核补丁值不是 JSON"],
                [
                    {
                        path: ["review", "changes", index, "valueJson"],
                        code: "invalid_json",
                    },
                ],
            );
        }
        Reflect.set(parent, key, value);
    }
    const result = readCandidate(updated);
    const finalPaths = new Set(candidatePaths(result));
    for (const [name, check] of Object.entries(review.checks))
        if (check.evidence.some((item) => !finalPaths.has(item.path)))
            throw new PrintDesignContractError(
                ["复核证据引用了已删除的字段"],
                [
                    {
                        path: [
                            "review",
                            "checks",
                            name,
                            "evidence",
                            check.evidence.findIndex(
                                (item) => !finalPaths.has(item.path),
                            ),
                            "path",
                        ],
                        code: "missing_reference",
                    },
                ],
            );
    return result;
}
