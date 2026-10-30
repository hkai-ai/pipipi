/** 提供 JSON 重交与字段修正指令，对可读取候选冻结未报错内容。 */
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { AiTextOutputFailure } from "./agent-types.js";
import { EmojiFailure, planningIssues } from "./diagnostics.js";

export const JSON_CORRECTION_PROMPT = JSON.stringify({
    task: "上次最终方案无法解析为JSON。保留原需求、搜索资料、来源选择和已有剧情，只修复输出格式，按同一Schema重新提交一个完整JSON对象。字符串正确转义，仅输出方案对象。",
    issues: [{ path: "", code: "invalid_json" }],
});

const actorField =
    "actors\\.\\d+\\.(?:expression|action|position|identityMark(?:\\.(?:text|carrier|placement))?)";
const repairablePath = new RegExp(
    `^(?:caption|scene|joke|composition|punchlineDetail|continuity|aspectRatio|page\\.(?:aspectRatio|layout|readingOrder)|${actorField}|propMarks\\.\\d+\\.(?:text|carrier|placement)|panels\\.\\d+\\.(?:frame|scene|composition|punchlineDetail|${actorField}|texts\\.\\d+\\.(?:kind|speaker|text|placement)))$`,
);

export function createSchemaCorrection(raw: unknown, error: z.ZodError) {
    // 只修可定位的现有画面字段，不重建角色列表、分格、来源或整个候选。
    if (
        !error.issues.length ||
        error.issues.length > 12 ||
        error.issues.some(
            (issue) =>
                !repairablePath.test(issue.path.join(".")) ||
                ![
                    "invalid_type",
                    "invalid_value",
                    "too_big",
                    "too_small",
                ].includes(issue.code),
        )
    )
        return null;
    const paths = error.issues.map((issue) => issue.path);
    const protectedContent = (value: unknown) => {
        const copy = structuredClone(value);
        for (const path of paths) {
            let parent = copy as Record<PropertyKey, unknown>;
            for (const part of path.slice(0, -1)) {
                if (
                    !parent ||
                    typeof parent !== "object" ||
                    !Object.hasOwn(parent, part)
                )
                    throw new EmojiFailure(
                        "planning",
                        "repair_changed_content",
                    );
                parent = parent[part] as Record<PropertyKey, unknown>;
            }
            if (!parent || typeof parent !== "object")
                throw new EmojiFailure("planning", "repair_changed_content");
            delete parent[path[path.length - 1]];
        }
        return copy;
    };
    const original = protectedContent(raw);
    return {
        prompt: JSON.stringify({
            task: "方案结构未通过校验。仅修正issues指向的字段，按同一Schema返回完整候选。保留其余字段原值及来源选择，不再搜索，不重写剧情。",
            issues: planningIssues(error.issues),
        }),
        assertUnchanged(value: unknown) {
            if (!isDeepStrictEqual(original, protectedContent(value)))
                throw new EmojiFailure("planning", "repair_changed_content");
        },
    };
}

export function createCorrection(
    candidate: object,
    failure: AiTextOutputFailure,
) {
    const issues = failure.issues ?? [];
    if (
        !issues.length ||
        issues.some(
            ({ path, code }) =>
                !(
                    path === "caption" &&
                    [
                        "caption_setting_mismatch",
                        "specified_caption_mismatch",
                    ].includes(code)
                ),
        )
    )
        return null;
    const protectedContent = (value: object) =>
        JSON.stringify({ ...value, caption: null });
    const original = protectedContent(candidate);
    return {
        prompt: JSON.stringify({
            task: "最终方案未通过业务校验。仅修正issues指定的台词字段，遵守原配字要求。保留其他字段原值，不再搜索，重新提交相同Schema的完整方案。",
            issues,
        }),
        assertUnchanged(value: object) {
            if (protectedContent(value) !== original)
                throw new EmojiFailure("planning", "repair_changed_content");
        },
    };
}
