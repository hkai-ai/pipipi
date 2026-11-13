/** 保留服务目录、Runtime Skill 浏览与人工任务提交工具。 */
import { useEffect, useRef, useState } from "preact/hooks";
import {
    type ConsoleProcessDescription,
    type ConsoleSkillDescription,
    listProcesses,
    listSkills,
    skillCoverHref,
} from "./api.js";
import { formatTime, Panel } from "./formatting.jsx";
import { activityName, processName } from "./labels.js";
import {
    type PendingProcessRun,
    type ProcessRunOutcome,
    type ProcessRunProgress,
    processRuns,
} from "./process-run-client.js";
import { useAsync } from "./resource.js";
import { hrefFor } from "./routing.js";

export function ProcessesView({
    process,
    version,
}: {
    process?: string;
    version?: string;
}) {
    const catalog = useAsync(() => listProcesses(), []);
    const entries = catalog.value?.processes.filter(
        (entry) =>
            (!process || entry.process === process) &&
            (!version || entry.version === version),
    );
    return (
        <Panel title="业务流程">
            <p class="hint">
                查看当前服务支持的业务流程、版本和输入要求。展开流程查看参数与执行限制。
            </p>
            <p class="hint">
                流程版本定义一次业务调用的输入、输出与执行规则；技能版本定义
                Agent 使用的指令。两者独立编号。
            </p>
            {process ? (
                <p>
                    <a href={hrefFor({ view: "processes" })}>
                        查看全部业务流程
                    </a>
                </p>
            ) : null}
            {catalog.error ? <p class="error">{catalog.error}</p> : null}
            {catalog.loading ? <p class="hint">正在读取业务流程…</p> : null}
            {entries?.length === 0 ? (
                <p class="notice">
                    当前服务未注册 {processName(process)} 的流程版本{" "}
                    {version ?? "（未指定）"}
                    。它可能已下线，或请求指定的版本不存在；不能用其他版本代替查看。
                </p>
            ) : null}
            {entries?.map((entry) => (
                <ProcessEntry
                    key={`${entry.process}/${entry.version}`}
                    entry={entry}
                    expanded={Boolean(process)}
                />
            ))}
        </Panel>
    );
}

function ProcessEntry({
    entry,
    expanded,
}: {
    entry: ConsoleProcessDescription;
    expanded?: boolean;
}) {
    return (
        <details open={expanded}>
            <summary>
                {processName(entry.process)} · 流程版本 {entry.version}
            </summary>
            <p class="hint">
                流程标识：{entry.process}。步骤：
                {entry.activities.map(activityName).join(" → ")}。最多执行次数：
                {entry.retry.maximumAttempts}
            </p>
            <h3>当前声明的 Runtime Skill</h3>
            {entry.skills.length > 0 ? (
                <ul>
                    {entry.skills.map(({ name, version }) => (
                        <li key={`${name}@${version}`}>
                            <a href={hrefFor({ view: "skill", name, version })}>
                                {name} · {version}
                            </a>
                        </li>
                    ))}
                </ul>
            ) : (
                <p class="hint">此版本未绑定 Runtime Skill。</p>
            )}
            <SchemaTable label="输入" schema={entry.input} />
            <SchemaTable label="输出" schema={entry.output} />
        </details>
    );
}

type JsonSchema = Readonly<{
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
}>;

function SchemaTable({ label, schema }: { label: string; schema: unknown }) {
    const parsed = schema as JsonSchema | undefined;
    if (!parsed?.properties) {
        return (
            <p class="hint">
                {label}：该 Schema 无法自动生成，请查阅业务接口文档。
            </p>
        );
    }
    const required = new Set(parsed.required ?? []);
    return (
        <>
            <p class="hint">{label}</p>
            <table>
                <thead>
                    <tr>
                        <th>字段</th>
                        <th>必填</th>
                        <th>约束</th>
                    </tr>
                </thead>
                <tbody>
                    {Object.entries(parsed.properties).map(
                        ([name, property]) => (
                            <tr key={name}>
                                <td class="mono">{name}</td>
                                <td>{required.has(name) ? "是" : "否"}</td>
                                <td>{describeConstraint(property)}</td>
                            </tr>
                        ),
                    )}
                </tbody>
            </table>
        </>
    );
}

function describeConstraint(property: Record<string, unknown>): string {
    const parts: string[] = [String(property.type ?? "any")];
    if (Array.isArray(property.enum)) parts.push(property.enum.join(" | "));
    if (property.minLength !== undefined || property.maxLength !== undefined) {
        parts.push(
            `${property.minLength ?? 0}–${property.maxLength ?? "∞"} 字符`,
        );
    }
    if (property.default !== undefined) {
        parts.push(`缺省 ${JSON.stringify(property.default)}`);
    }
    return parts.join("，");
}

/**
 * The installed Runtime Skills as a cover grid. The catalog is read-only by
 * design: installing, updating or removing a Skill is a reviewed code change
 * and a release, never a console action.
 */
export function SkillsView() {
    const catalog = useAsync(() => listSkills(), []);
    const [query, setQuery] = useState("");
    const needle = query.trim().toLowerCase();
    const skills = (catalog.value?.skills ?? []).filter(
        (skill) =>
            needle.length === 0 ||
            [skill.name, skill.description, ...skill.processes].some((text) =>
                text.toLowerCase().includes(needle),
            ),
    );

    return (
        <Panel title="Agent 技能">
            <p class="hint">
                查看业务流程使用的 Agent 技能，了解指令、来源与关联流程。
                技能随服务发布，此处只供查看；更新需通过代码评审与发布。
            </p>
            <div class="toolbar">
                <label class="grow">
                    筛选
                    <input
                        type="search"
                        placeholder="按名称、描述或关联业务流程筛选"
                        value={query}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                <span class="hint">
                    {catalog.value
                        ? `${skills.length} / ${catalog.value.skills.length} 个`
                        : ""}
                </span>
            </div>
            {catalog.error ? <p class="error">{catalog.error}</p> : null}
            {catalog.value && skills.length === 0 ? (
                <p class="empty">
                    {catalog.value.skills.length === 0
                        ? "当前服务没有启用使用 Agent 技能的业务流程。"
                        : "没有匹配的 Skill。"}
                </p>
            ) : null}
            <div class="skill-grid">
                {skills.map((skill) => (
                    <SkillCard
                        key={`${skill.name}@${skill.version}`}
                        skill={skill}
                    />
                ))}
            </div>
        </Panel>
    );
}

function SkillCard({ skill }: { skill: ConsoleSkillDescription }) {
    return (
        <a
            class="skill-card"
            href={hrefFor({
                view: "skill",
                name: skill.name,
                version: skill.version,
            })}
        >
            <SkillCover skill={skill} />
            <div class="skill-card-body">
                <div class="skill-card-title">
                    {skill.name}
                    <span class="skill-version">{skill.version}</span>
                </div>
                <p class="skill-card-description" title={skill.description}>
                    {skill.description || "（未提供描述）"}
                </p>
                <ProcessChips processes={skill.processes} />
            </div>
        </a>
    );
}

/**
 * A Skill without a cover still gets a stable, recognisable tile so the grid
 * scans the same whether or not every snapshot ships an image.
 */
function SkillCover({ skill }: { skill: ConsoleSkillDescription }) {
    if (skill.cover) {
        return (
            <img
                class="skill-cover"
                loading="lazy"
                src={skillCoverHref(skill)}
                alt={`${skill.name} 封面`}
            />
        );
    }
    const initials = skill.name
        .split("-")
        .filter((part) => part.length > 0)
        .slice(0, 3)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
    return (
        <div class="skill-cover skill-cover-missing">
            <span aria-hidden="true">{initials}</span>
            <small>未提供封面</small>
        </div>
    );
}

function ProcessChips({ processes }: { processes: readonly string[] }) {
    if (processes.length === 0) {
        return <span class="hint">未被任何已启用 Process 绑定</span>;
    }
    return (
        <div class="chips">
            {processes.map((process) => (
                <span class="chip" key={process}>
                    {process}
                </span>
            ))}
        </div>
    );
}

export function SkillView({
    name,
    version,
}: {
    name: string;
    version: string;
}) {
    const catalog = useAsync(() => listSkills(), []);
    const skill = catalog.value?.skills.find(
        (entry) => entry.name === name && entry.version === version,
    );
    const back = <a href={hrefFor({ view: "skills" })}>← 返回 Agent 技能</a>;

    if (catalog.error) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p class="error">{catalog.error}</p>
            </Panel>
        );
    }
    if (!catalog.value) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p class="hint">加载中…</p>
            </Panel>
        );
    }
    if (!skill) {
        return (
            <Panel title={`${name} @ ${version}`} action={back}>
                <p class="empty">
                    本次发布没有安装这个 Skill 版本，或它未被任何已启用 Process
                    绑定。
                </p>
            </Panel>
        );
    }

    return (
        <Panel title={`${skill.name} @ ${skill.version}`} action={back}>
            <div class="skill-hero">
                {skill.cover ? (
                    <a
                        href={skillCoverHref(skill)}
                        target="_blank"
                        rel="noreferrer"
                        title="在新标签页中打开封面"
                    >
                        <SkillCover skill={skill} />
                    </a>
                ) : (
                    <SkillCover skill={skill} />
                )}
                <div>
                    <p class="skill-description">
                        {skill.description || "（未提供描述）"}
                    </p>
                    <table>
                        <tbody>
                            <tr>
                                <th>绑定 Process</th>
                                <td>
                                    <ProcessChips processes={skill.processes} />
                                </td>
                            </tr>
                            <tr>
                                <th>SHA-256</th>
                                <td class="mono">{skill.sha256 || "—"}</td>
                            </tr>
                            <tr>
                                <th>封面文件</th>
                                <td class="mono">
                                    {skill.cover
                                        ? `${skill.cover.file}（${skill.cover.mediaType}）`
                                        : "无；在 Skill 目录放置 cover.png / cover.jpg / cover.webp 即可显示"}
                                </td>
                            </tr>
                            <tr>
                                <th>快照文件</th>
                                <td class="mono">{skill.files.join("　")}</td>
                            </tr>
                        </tbody>
                    </table>
                    <p class="hint">
                        SHA-256 只覆盖
                        SKILL.md；封面与其他随附文件不参与完整性校验。
                    </p>
                </div>
            </div>
            <details open>
                <summary>SKILL.md 指令正文（Agent 实际收到的内容）</summary>
                <pre class="skill-text">{skill.instructions}</pre>
            </details>
            {skill.source !== undefined ? (
                <details>
                    <summary>SOURCE.md 来源与审查记录</summary>
                    <pre class="skill-text">{skill.source}</pre>
                </details>
            ) : null}
        </Panel>
    );
}

export function SubmitView({
    processes,
}: {
    processes: readonly ConsoleProcessDescription[];
}) {
    const [selected, setSelected] = useState("");
    const [values, setValues] = useState<Record<string, string>>({});
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<ProcessRunProgress | undefined>(
        undefined,
    );
    const [outcome, setOutcome] = useState<ProcessRunOutcome | undefined>(
        undefined,
    );
    const [pending, setPending] = useState<PendingProcessRun | undefined>(() =>
        processRuns.pending(),
    );
    const [hasUnexpectedError, setHasUnexpectedError] = useState(false);
    const execution = useRef<AbortController | undefined>(undefined);

    useEffect(
        () => () => {
            execution.current?.abort();
        },
        [],
    );

    const entry =
        processes.find(
            (candidate) =>
                `${candidate.process}/${candidate.version}` === selected,
        ) ?? processes[0];
    const fields = entry ? fieldsOf(entry) : [];

    if (!entry) return <Panel title="手动调试">正在读取业务流程…</Panel>;

    const execute = async (intent: "continue" | "new") => {
        const controller = new AbortController();
        execution.current = controller;
        setRunning(true);
        setProgress(undefined);
        setOutcome(undefined);
        setHasUnexpectedError(false);
        const input = Object.fromEntries(
            fields
                .map((field) => [field.name, (values[field.name] ?? "").trim()])
                .filter(([, value]) => value !== ""),
        );
        try {
            const result = await processRuns.execute(
                {
                    process: entry.process,
                    version: entry.version,
                    input,
                },
                {
                    intent,
                    onProgress: setProgress,
                    signal: controller.signal,
                },
            );
            setOutcome(result);
        } catch {
            setHasUnexpectedError(true);
        } finally {
            if (execution.current === controller) {
                execution.current = undefined;
            }
            setPending(processRuns.pending());
            setRunning(false);
        }
    };

    return (
        <Panel title="手动调试">
            <p class="cost-warning">
                提交会真实执行生产流程并产生图片费用。控制台异步提交并查询结果，
                默认等待 300 秒；关闭页面或等待超时不会取消服务端 Run。
            </p>
            {pending ? (
                <PendingOperation
                    operation={pending}
                    running={running}
                    onContinue={() => execute("continue")}
                    onDismiss={() => {
                        if (!processRuns.dismiss()) return;
                        setPending(undefined);
                        setProgress(undefined);
                        setOutcome(undefined);
                        setHasUnexpectedError(false);
                    }}
                />
            ) : null}
            <form
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (
                        pending?.classification === "accepted" ||
                        pending?.classification === "unavailable"
                    ) {
                        return;
                    }
                    await execute(pending ? "new" : "continue");
                }}
            >
                <label>
                    Business Process
                    <select
                        value={`${entry.process}/${entry.version}`}
                        onChange={(event) => {
                            setSelected(event.currentTarget.value);
                            setValues({});
                        }}
                    >
                        {processes.map((candidate) => (
                            <option
                                key={`${candidate.process}/${candidate.version}`}
                                value={`${candidate.process}/${candidate.version}`}
                            >
                                {candidate.process} / {candidate.version}
                            </option>
                        ))}
                    </select>
                </label>

                {fields.map((field) => {
                    const inputId = `field-${entry.process}-${field.name}`;
                    const onChange = (value: string) =>
                        setValues({ ...values, [field.name]: value });
                    return (
                        <div key={field.name}>
                            <label for={inputId}>
                                {field.name}
                                {field.required ? " *" : "（可选）"}
                            </label>
                            {field.options ? (
                                <select
                                    id={inputId}
                                    value={values[field.name] ?? ""}
                                    onChange={(event) =>
                                        onChange(event.currentTarget.value)
                                    }
                                >
                                    {field.required ? null : (
                                        <option value="">（不填）</option>
                                    )}
                                    {field.options.map((option) => (
                                        <option key={option} value={option}>
                                            {option}
                                        </option>
                                    ))}
                                </select>
                            ) : field.long ? (
                                <textarea
                                    id={inputId}
                                    required={field.required}
                                    value={values[field.name] ?? ""}
                                    onInput={(event) =>
                                        onChange(event.currentTarget.value)
                                    }
                                />
                            ) : (
                                <input
                                    id={inputId}
                                    required={field.required}
                                    value={values[field.name] ?? ""}
                                    onInput={(event) =>
                                        onChange(event.currentTarget.value)
                                    }
                                />
                            )}
                        </div>
                    );
                })}

                <button
                    type="submit"
                    class="primary"
                    disabled={
                        running ||
                        pending?.classification === "accepted" ||
                        pending?.classification === "unavailable"
                    }
                >
                    {running
                        ? "等待结果…"
                        : pending?.classification === "accepted"
                          ? "先继续查询或移除已接受 Run"
                          : pending?.classification === "unavailable"
                            ? "浏览器恢复存储不可用"
                            : pending
                              ? "明确开始新提交（生成新幂等键）"
                              : "提交"}
                </button>
            </form>
            <SubmissionResult
                progress={progress}
                outcome={outcome}
                hasUnexpectedError={hasUnexpectedError}
            />
        </Panel>
    );
}

function PendingOperation({
    operation,
    running,
    onContinue,
    onDismiss,
}: {
    operation: PendingProcessRun;
    running: boolean;
    onContinue: () => Promise<void>;
    onDismiss: () => void;
}) {
    if (operation.classification === "unavailable") {
        return (
            <p class="error" style="margin-bottom:14px">
                浏览器恢复存储不可用。为避免响应丢失后重复创建付费
                Run，当前禁止提交。
            </p>
        );
    }
    const action =
        operation.classification === "accepted"
            ? "继续查询"
            : "重试同一操作（复用幂等键）";
    return (
        <div class="hint" style="margin-bottom:14px">
            <p>
                检测到可恢复操作 · {operation.classification} · 创建于
                {formatTime(operation.createdAt)}
                {operation.runId ? (
                    <>
                        {" "}
                        · Run <code>{operation.runId}</code>
                    </>
                ) : null}
            </p>
            {operation.classification !== "accepted" ? (
                <p>重试前请填写与原操作相同的 Process 和输入。</p>
            ) : null}
            <button type="button" disabled={running} onClick={onContinue}>
                {action}
            </button>{" "}
            <button type="button" disabled={running} onClick={onDismiss}>
                移除恢复记录
            </button>
        </div>
    );
}

function SubmissionResult({
    progress,
    outcome,
    hasUnexpectedError,
}: {
    progress?: ProcessRunProgress;
    outcome?: ProcessRunOutcome;
    hasUnexpectedError: boolean;
}) {
    if (hasUnexpectedError) {
        return <p class="error">客户端发生未预期错误，请稍后重试。</p>;
    }
    if (outcome) return <Outcome result={outcome} />;
    if (!progress) return null;
    return (
        <p class="hint" style="margin-top:14px">
            Run <code>{progress.runId}</code> 已接受，当前状态：
            <strong>{progress.status}</strong>
        </p>
    );
}

function Outcome({ result }: { result: ProcessRunOutcome }) {
    switch (result.status) {
        case "succeeded":
            return (
                <div style="margin-top:14px">
                    <p class="status-succeeded">
                        Run <code>{result.runId}</code> · succeeded
                    </p>
                    <pre>{JSON.stringify(result.output, null, 2)}</pre>
                </div>
            );
        case "failed":
            return (
                <div style="margin-top:14px">
                    <p class="status-failed">
                        Run <code>{result.runId}</code> · failed
                    </p>
                    <p class="error">
                        {result.error.code}：{result.error.message}
                    </p>
                </div>
            );
        case "result-expired":
            return (
                <p class="error" style="margin-top:14px">
                    Run <code>{result.runId}</code> 已 {result.resultStatus}，
                    结果于 {formatTime(result.resultExpiredAt)} 过期。
                </p>
            );
        case "timed-out":
            return (
                <p class="error" style="margin-top:14px">
                    Run <code>{result.runId}</code> 查询超过
                    {result.timeoutMs / 1_000} 秒；服务端仍会继续执行。
                </p>
            );
        case "cancelled":
            return (
                <p class="error" style="margin-top:14px">
                    已停止查询 Run <code>{result.runId}</code>
                    ；服务端不会收到取消请求，之后仍可继续查询。
                </p>
            );
        case "rejected":
            return (
                <p class="error" style="margin-top:14px">
                    HTTP {result.httpStatus} · {result.error.code}：
                    {result.error.message}
                </p>
            );
        case "protocol-error":
            return (
                <p class="error" style="margin-top:14px">
                    服务响应不符合 Process Run Interface：{result.code}
                </p>
            );
        case "submission-pending":
            return result.classification === "acceptance-unknown" ? (
                <p class="error" style="margin-top:14px">
                    提交响应丢失，服务端是否接受尚不确定。请重试同一操作，客户端会复用原幂等键。
                </p>
            ) : (
                <p class="error" style="margin-top:14px">
                    HTTP {result.httpStatus} · {result.error.code}
                    ：服务暂不可接受新 Run；建议 {result.retryAfterMs / 1_000}{" "}
                    秒后重试同一操作。
                </p>
            );
        case "recovery-error":
            return (
                <p class="error" style="margin-top:14px">
                    {result.code === "REQUEST_MISMATCH"
                        ? "当前输入与待恢复操作不一致；请恢复原输入，或明确开始新提交。"
                        : result.code === "ACCEPTED_OPERATION_ACTIVE"
                          ? "已有已接受的 Run；请先继续查询，或明确移除恢复记录。"
                          : result.code === "ACTIVE_OPERATION"
                            ? "另一个提交操作正在进行；本次操作未开始。"
                            : "浏览器恢复存储不可用；为避免重复创建付费 Run，本次操作未发送。"}
                </p>
            );
    }
}

/**
 * The form is generated from the same Schema the service validates against, so
 * a new Process or a changed field needs no console change.
 */
type FieldDescription = {
    name: string;
    required: boolean;
    options?: readonly string[];
    long: boolean;
};

function fieldsOf(
    entry: ConsoleProcessDescription,
): readonly FieldDescription[] {
    const schema = entry.input as JsonSchema | undefined;
    if (!schema?.properties) return [];
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).map(([name, property]) => ({
        name,
        required: required.has(name),
        ...(Array.isArray(property.enum)
            ? { options: property.enum.map(String) }
            : {}),
        long: Number(property.maxLength ?? 0) > 300,
    }));
}
