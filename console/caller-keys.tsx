/** 展示调用方认证态势，并提供密钥盘点、一次性发放、吊销与审计。 */
import type { ComponentChildren, TargetedSubmitEvent } from "preact";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
    ConsoleCallerKeys,
    ConsoleIssuedKey,
} from "../src/api/console-contract.js";
import {
    HttpError,
    issueCallerKey,
    listCallerKeys,
    revokeCallerKey,
} from "./api.js";
import { formatTime, Panel } from "./formatting.jsx";
import { useAsync } from "./resource.js";
import { hrefFor } from "./routing.js";

const statusLabels = {
    active: "有效",
    revoked: "已吊销",
    expired: "已过期",
} as const;

export function CallerKeysView({ callerId }: { callerId?: string }) {
    const [refresh, setRefresh] = useState(0);
    const result = useAsync(
        () => listCallerKeys(callerId),
        [callerId],
        refresh,
    );
    const [issued, setIssued] = useState<ConsoleIssuedKey>();
    const [copyFeedback, setCopyFeedback] = useState("");
    const [confirming, setConfirming] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [issueError, setIssueError] = useState("");
    const [revokeError, setRevokeError] = useState("");
    const reload = () => setRefresh((previous) => previous + 1);

    useEffect(() => {
        const clearIssued = () => {
            setIssued(undefined);
            setCopyFeedback("");
        };
        window.addEventListener("pagehide", clearIssued);
        return () => window.removeEventListener("pagehide", clearIssued);
    }, []);

    async function issue(event: TargetedSubmitEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy || issued) return;
        const form = event.currentTarget;
        const data = new FormData(form);
        const expiry = String(data.get("expiresAt"));
        const expires = expiry ? new Date(expiry) : undefined;
        if (expires && !(expires.getTime() > Date.now())) {
            setIssueError("请选择未来的过期时间。");
            return;
        }
        setIssueError("");
        setBusy(true);
        try {
            const response = await issueCallerKey({
                callerId: String(data.get("callerId")),
                label: String(data.get("label")),
                actor: optionalField(data, "actor"),
                note: optionalField(data, "note"),
                expiresAt: expires?.toISOString(),
            });
            setCopyFeedback("");
            setIssued(response);
            form.reset();
        } catch (error) {
            setIssueError(
                error instanceof HttpError && error.status === 400
                    ? "请填写调用方和用途标签。文本字段最多 512 字节，过期时间须在未来。"
                    : "发放未获确认。请先查看密钥和审计记录，再决定是否重试。",
            );
        } finally {
            setBusy(false);
            reload();
        }
    }

    async function revoke(
        event: TargetedSubmitEvent<HTMLFormElement>,
        keyId: string,
    ) {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(event.currentTarget);
        setRevokeError("");
        setBusy(true);
        try {
            await revokeCallerKey(keyId, {
                actor: optionalField(data, "actor"),
                note: optionalField(data, "note"),
            });
            setConfirming(undefined);
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) {
                setRevokeError("密钥不存在或已吊销。");
                setConfirming(undefined);
            } else if (error instanceof HttpError && error.status === 400) {
                setRevokeError("操作人和备注最多各 512 字节，请勿填入密钥。");
            } else {
                setRevokeError("吊销未获确认。请查看列表中的当前状态。");
            }
        } finally {
            setBusy(false);
            reload();
        }
    }

    async function copyKey(key: string) {
        try {
            await navigator.clipboard.writeText(key);
            setCopyFeedback("已复制");
        } catch {
            setCopyFeedback("复制失败，请选中密钥并手动复制。");
        }
    }

    const auth = result.value?.auth;
    return (
        <>
            <header class="page-heading">
                <h1>调用方密钥</h1>
            </header>

            {issued ? (
                <section
                    class="panel issued-key"
                    aria-labelledby="issued-key-title"
                >
                    <h2 id="issued-key-title">请保存一次性密钥</h2>
                    <p>服务端仅存不可逆哈希。刷新或关闭后无法再次查看明文。</p>
                    {issued.persistent ? null : (
                        <p class="cost-warning">
                            当前为本地内存模式，服务重启后密钥会清空。
                        </p>
                    )}
                    <code class="secret-value">{issued.key}</code>
                    <div class="actions">
                        <button
                            type="button"
                            class="primary"
                            onClick={() => void copyKey(issued.key)}
                        >
                            复制密钥
                        </button>
                        <button
                            type="button"
                            onClick={() => setIssued(undefined)}
                        >
                            我已保存，关闭提示
                        </button>
                        <span role="status">{copyFeedback}</span>
                    </div>
                </section>
            ) : null}

            <Panel title="当前认证态势">
                {auth ? (
                    <>
                        <dl class="detail-facts key-auth">
                            <div>
                                <dt>同步 /execute 认证档位</dt>
                                <dd>{auth.executeAuthMode}</dd>
                            </div>
                            <div>
                                <dt>网关注入兼容</dt>
                                <dd>
                                    {auth.gatewayFallbackEnabled
                                        ? "开启"
                                        : "关闭"}
                                </dd>
                            </div>
                            <div>
                                <dt>密钥存储</dt>
                                <dd>
                                    {auth.persistent
                                        ? "PostgreSQL 持久存储"
                                        : "本地内存开发模式"}
                                </dd>
                            </div>
                        </dl>
                        {auth.persistent ? null : (
                            <p class="notice">
                                服务重启后密钥和审计记录会清空。
                            </p>
                        )}
                    </>
                ) : (
                    <p class="hint">
                        {result.error
                            ? "认证态势读取失败。"
                            : "正在读取认证态势…"}
                    </p>
                )}
            </Panel>

            <Panel title="发放新密钥">
                <form
                    autocomplete="off"
                    onSubmit={(event) => void issue(event)}
                >
                    <div class="toolbar">
                        <label>
                            调用方 ID
                            <input
                                name="callerId"
                                required
                                placeholder="memebuy-uat"
                                maxLength={512}
                            />
                        </label>
                        <label>
                            用途标签
                            <input
                                name="label"
                                required
                                placeholder="Memebuy UAT"
                                maxLength={512}
                            />
                        </label>
                        <label>
                            操作人
                            <input name="actor" maxLength={512} />
                        </label>
                        <label>
                            过期时间
                            <input name="expiresAt" type="datetime-local" />
                        </label>
                    </div>
                    <label>
                        备注
                        <input name="note" maxLength={512} />
                    </label>
                    <div class="actions">
                        <button
                            type="submit"
                            class="primary"
                            disabled={busy || Boolean(issued)}
                        >
                            发放密钥
                        </button>
                        <span class="hint">
                            {issued
                                ? "请先保存并关闭上方一次性密钥提示，再发放下一把密钥。"
                                : "过期时间留空表示永不过期。"}
                        </span>
                    </div>
                    {issueError ? (
                        <p role="alert" class="error">
                            {issueError}
                        </p>
                    ) : null}
                </form>
            </Panel>

            <Panel title="密钥列表">
                <form
                    class="toolbar"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const filter = String(
                            new FormData(event.currentTarget).get("callerId"),
                        ).trim();
                        const hash = hrefFor({
                            view: "caller-keys",
                            callerId: filter || undefined,
                        });
                        if (location.hash === hash) reload();
                        else {
                            setConfirming(undefined);
                            setRevokeError("");
                            location.hash = hash;
                        }
                    }}
                >
                    <label>
                        按调用方 ID 筛选
                        <input
                            key={callerId}
                            name="callerId"
                            defaultValue={callerId ?? ""}
                            maxLength={512}
                        />
                    </label>
                    <button type="submit">筛选</button>
                    <button type="button" onClick={reload}>
                        刷新
                    </button>
                </form>
                {result.error ? (
                    <p role="alert" class="error">
                        {result.error}
                    </p>
                ) : null}
                {result.loading ? (
                    <p class="hint" role="status">
                        正在读取密钥和审计记录…
                    </p>
                ) : null}
                {revokeError ? (
                    <p role="alert" class="error">
                        {revokeError}
                    </p>
                ) : null}
                {result.value ? (
                    <KeysTable
                        keys={result.value.keys}
                        confirming={confirming}
                        disabled={busy || result.loading}
                        onSelect={(keyId) => {
                            setRevokeError("");
                            setConfirming(keyId);
                        }}
                        onRevoke={revoke}
                    />
                ) : null}
            </Panel>

            <Panel title="操作审计">
                {result.value ? (
                    <AuditTable audits={result.value.audits} />
                ) : null}
            </Panel>
        </>
    );
}

const keyColumns = [
    "调用方 ID",
    "密钥前缀",
    "用途标签",
    "状态",
    "创建时间",
    "过期时间",
    "最后使用",
    "吊销时间",
    "操作",
];

function KeysTable({
    keys,
    confirming,
    disabled,
    onSelect,
    onRevoke,
}: {
    keys: ConsoleCallerKeys["keys"];
    confirming?: string;
    disabled: boolean;
    onSelect: (keyId?: string) => void;
    onRevoke: (
        event: TargetedSubmitEvent<HTMLFormElement>,
        keyId: string,
    ) => Promise<void>;
}) {
    if (!keys.length) return <p class="empty">没有匹配的密钥。</p>;
    return (
        <Table title="密钥列表" columns={keyColumns}>
            {keys.map((key) => {
                const active = key.status === "active";
                const expanded = active && confirming === key.keyId;
                return (
                    <Fragment key={key.keyId}>
                        <tr>
                            <td>{key.callerId}</td>
                            <td>
                                <code class="mono">{key.keyPrefix}</code>
                            </td>
                            <td>{key.label}</td>
                            <td>
                                <span class={`chip key-${key.status}`}>
                                    {statusLabels[key.status]}
                                </span>
                            </td>
                            <td>{formatTime(key.createdAt)}</td>
                            <td>{displayTime(key.expiresAt, "永不过期")}</td>
                            <td>{displayTime(key.lastUsedAt, "未使用")}</td>
                            <td>{displayTime(key.revokedAt, "—")}</td>
                            <td>
                                {active ? (
                                    <button
                                        type="button"
                                        class="key-revoke"
                                        disabled={disabled}
                                        aria-expanded={expanded}
                                        onClick={() => onSelect(key.keyId)}
                                    >
                                        吊销
                                    </button>
                                ) : null}
                            </td>
                        </tr>
                        {expanded ? (
                            <tr>
                                <td colSpan={keyColumns.length}>
                                    <RevokeForm
                                        disabled={disabled}
                                        onSubmit={(event) =>
                                            void onRevoke(event, key.keyId)
                                        }
                                        onCancel={() => onSelect()}
                                    />
                                </td>
                            </tr>
                        ) : null}
                    </Fragment>
                );
            })}
        </Table>
    );
}

function RevokeForm({
    disabled,
    onSubmit,
    onCancel,
}: {
    disabled: boolean;
    onSubmit: (event: TargetedSubmitEvent<HTMLFormElement>) => void;
    onCancel: () => void;
}) {
    return (
        <form autocomplete="off" onSubmit={onSubmit}>
            <p class="cost-warning">确认后，该密钥将立即失去认证权限。</p>
            <div class="toolbar">
                <label>
                    吊销操作人
                    <input name="actor" maxLength={512} />
                </label>
                <label>
                    吊销原因
                    <input name="note" maxLength={512} />
                </label>
                <button type="submit" class="key-revoke" disabled={disabled}>
                    确认吊销
                </button>
                <button type="button" disabled={disabled} onClick={onCancel}>
                    取消
                </button>
            </div>
        </form>
    );
}

function AuditTable({ audits }: Pick<ConsoleCallerKeys, "audits">) {
    if (!audits.length) return <p class="empty">没有匹配的审计记录。</p>;
    return (
        <>
            <p class="hint">最近 100 条，最新操作在前。</p>
            <Table
                title="操作审计"
                columns={[
                    "时间",
                    "动作",
                    "调用方 ID",
                    "密钥前缀",
                    "用途标签",
                    "操作人",
                    "备注",
                    "过期时间",
                ]}
            >
                {audits.map((entry) => (
                    <tr key={`${entry.keyId}:${entry.operation}`}>
                        <td>{formatTime(entry.timestamp)}</td>
                        <td>{entry.operation === "issue" ? "发放" : "吊销"}</td>
                        <td>{entry.callerId}</td>
                        <td>
                            <code class="mono">{entry.keyPrefix}</code>
                        </td>
                        <td>{entry.label}</td>
                        <td>{entry.actor ?? "—"}</td>
                        <td>{entry.note ?? "—"}</td>
                        <td>{displayTime(entry.expiresAt, "永不过期")}</td>
                    </tr>
                ))}
            </Table>
        </>
    );
}

function Table({
    title,
    columns,
    children,
}: {
    title: string;
    columns: readonly string[];
    children: ComponentChildren;
}) {
    return (
        <div class="table-scroll">
            <table class="key-table" aria-label={title}>
                <thead>
                    <tr>
                        {columns.map((column) => (
                            <th key={column} scope="col">
                                {column}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}

function displayTime(value: string | undefined, fallback: string) {
    return value ? formatTime(value) : fallback;
}

function optionalField(data: FormData, name: string) {
    return String(data.get(name)).trim() || undefined;
}
