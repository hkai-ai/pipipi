/** 解析密钥管理命令并输出一次性发放结果或不含秘密的状态列表。 */
import { parseArgs } from "node:util";
import type { CallerApiKeyStore } from "./index.js";
export async function runCallerApiKeys(
    args: string[],
    store: CallerApiKeyStore,
): Promise<unknown> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            "caller-id": { type: "string" },
            label: { type: "string" },
            "expires-at": { type: "string" },
            actor: { type: "string" },
            note: { type: "string" },
            "key-id": { type: "string" },
        },
    });
    const required = (name: keyof typeof values) => {
        const value = values[name];
        if (!value?.trim())
            throw new Error("Required command option is missing");
        return value;
    };
    if (positionals.length !== 1)
        throw new Error("Expected issue, list, or revoke");
    switch (positionals[0]) {
        case "issue":
            return store.issue({
                callerId: required("caller-id"),
                label: required("label"),
                expiresAt: values["expires-at"],
                actor: values.actor,
                note: values.note,
            });
        case "list":
            return store.list(values["caller-id"]);
        case "revoke":
            return {
                revoked: await store.revoke(required("key-id"), {
                    actor: values.actor,
                    note: values.note,
                }),
            };
        default:
            throw new Error("Expected issue, list, or revoke");
    }
}
