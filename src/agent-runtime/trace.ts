/** 在真实 Pi 会话事件和最终供应商请求处采集轮次、用量与工具返回关系。 */
import type {
    AgentSession,
    AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { recordLocalField } from "../process-runtime/local-trace.js";
import type {
    PiRoundTrace,
    PiSessionTrace,
} from "../process-runtime/pi-trace.js";
import { currentTraceActivity } from "../process-runtime/trace-context.js";

type Collector = {
    trace: PiSessionTrace;
    toolNames: Set<string>;
    current?: PiRoundTrace;
    started: number;
    calls: Map<string, PiRoundTrace["calls"][number]>;
};
const sessions = new WeakMap<AgentSession, Collector>();

function observe(operation: () => void) {
    try {
        operation();
    } catch {
        /* 采集故障不能进入模型或业务错误路径。 */
    }
}
export function observePiSession(
    session: AgentSession,
    skills: PiSessionTrace["skills"],
    toolNames: readonly string[],
) {
    const scope = currentTraceActivity();
    if (!scope || scope.sessions.length >= 32) return;
    observe(() => {
        const trace: PiSessionTrace = {
            sessionId: scope.sessions.length + 1,
            skills,
            rounds: [],
        };
        const collector: Collector = {
            trace,
            started: 0,
            toolNames: new Set(toolNames),
            calls: new Map(),
        };
        sessions.set(session, collector);
        scope.sessions.push(trace);
        session.subscribe((event) =>
            observe(() => recordEvent(collector, event)),
        );
    });
}

/** 仅由业务 Adapter 投影本模式允许观察的实际字段。 */
export function recordPiField(
    session: AgentSession,
    kind: "input" | "model",
    field: string,
    read: () => { value?: string; note?: string },
) {
    const state = sessions.get(session);
    if (state)
        recordLocalField(kind, field, read, {
            sessionId: state.trace.sessionId,
            round:
                kind === "input"
                    ? state.trace.rounds.length + 1
                    : state.current?.round,
        });
}

export function tracePiValidation(
    session: AgentSession,
    validation: "passed" | "failed",
) {
    const state = sessions.get(session);
    if (state) {
        state.trace.validation = validation;
        recordLocalField(
            "validation",
            "candidate",
            () => ({ value: validation }),
            { sessionId: state.trace.sessionId, round: state.current?.round },
        );
    }
}

function recordEvent(state: Collector, event: AgentSessionEvent) {
    const round = state.current;
    if (!round) return;
    if (event.type === "message_end" && event.message.role === "assistant") {
        round.outcome = event.message.stopReason;
        round.durationMs = Math.round(performance.now() - state.started);
        const link = { sessionId: state.trace.sessionId, round: round.round };
        for (const part of event.message.content) {
            if (part.type !== "toolCall" || round.calls.length >= 64) continue;
            const call = {
                call: round.calls.length + 1,
                ...(state.toolNames.has(part.name) ? { name: part.name } : {}),
            };
            round.calls.push(call);
            state.calls.set(part.id, call);
            if (call.name === "search_memes")
                recordLocalField(
                    "toolCall",
                    "focus",
                    () => {
                        const focus = object(part.arguments)?.focus;
                        return typeof focus === "string"
                            ? { value: focus }
                            : { note: "本次调用未提供 focus。" };
                    },
                    { ...link, call: call.call },
                );
        }
    } else if (event.type === "tool_execution_end") {
        const call = state.calls.get(event.toolCallId);
        if (!call) return;
        call.result = event.isError ? "error" : "returned";
        if (
            typeof event.durationMs === "number" &&
            Number.isFinite(event.durationMs)
        )
            call.durationMs = Math.max(0, Math.round(event.durationMs));
        recordLocalField(
            "toolResult",
            call.name ?? "tool",
            () => ({ value: call.result, note: "工具返回的正文已省略。" }),
            {
                sessionId: state.trace.sessionId,
                round: round.round,
                call: call.call,
            },
        );
        state.calls.delete(event.toolCallId);
    }
}
function object(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    return undefined;
}
function number(value: unknown): number | undefined {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
}

function beginRound(
    state: Collector,
    payload: unknown,
    api: string,
    modelId?: string,
) {
    const rounds = state.trace.rounds;
    state.current = undefined;
    if (rounds.length >= 64) return;
    const body = object(payload);
    // 这些 API 的 tools 缺省即为未开放。未知协议不把缺失推断成空清单。
    const known = [
        "openai-responses",
        "openai-completions",
        "anthropic-messages",
    ].includes(api);
    const raw = body?.tools;
    let tools: string[] | undefined;
    if (known && body && raw === undefined) tools = [];
    else if (Array.isArray(raw) && raw.length <= 64) {
        const names = raw.map(
            (tool) =>
                object(tool)?.name ?? object(object(tool)?.function)?.name,
        );
        if (
            names.every(
                (n): n is string =>
                    typeof n === "string" && state.toolNames.has(n),
            )
        )
            tools = names;
    }
    const round: PiRoundTrace = {
        round: rounds.length + 1,
        ...(tools ? { tools } : {}),
        ...(modelId && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(modelId)
            ? { model: modelId }
            : {}),
        calls: [],
    };
    rounds.push(round);
    state.current = round;
    state.started = performance.now();
}

// SDK 的归一化 usage 会为缺失的供应商字段填零；仅采集原生事件实际带回的计数。
function recordUsage(round: PiRoundTrace | undefined, wire: unknown) {
    if (!round) return;
    const event = object(wire);
    const usage =
        object(object(event?.response)?.usage) ?? object(event?.usage);
    if (!usage) return;
    const inputDetails = object(
        usage.input_tokens_details ?? usage.prompt_tokens_details,
    );
    const outputDetails = object(
        usage.output_tokens_details ?? usage.completion_tokens_details,
    );
    const values = {
        input: number(usage.input_tokens ?? usage.prompt_tokens),
        output: number(usage.output_tokens ?? usage.completion_tokens),
        cacheRead: number(
            inputDetails?.cached_tokens ?? usage.cache_read_input_tokens,
        ),
        cacheWrite: number(usage.cache_creation_input_tokens),
        reasoning: number(outputDetails?.reasoning_tokens),
        totalTokens: number(usage.total_tokens),
    };
    const counts = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(counts).length) round.usage = { ...round.usage, ...counts };
}

/** 业务配置完请求变换后包裹一次 prompt；其内部多轮请求各自读取最终载荷。 */
export async function promptPi(
    session: AgentSession,
    ...args: Parameters<AgentSession["prompt"]>
) {
    const state = sessions.get(session);
    if (!state || !session.agent) return session.prompt(...args);
    const { onPayload, onProviderStreamEvent } = session.agent;
    session.agent.onPayload = async (payload, model) => {
        const changed = await onPayload?.(payload, model);
        observe(() =>
            beginRound(
                state,
                changed ?? payload,
                model?.api ?? session.model?.api ?? "",
                model?.id ?? session.model?.id,
            ),
        );
        return changed;
    };
    session.agent.onProviderStreamEvent = (event, model) => {
        observe(() => recordUsage(state.current, event));
        return onProviderStreamEvent?.(event, model);
    };
    try {
        return await session.prompt(...args);
    } finally {
        session.agent.onPayload = onPayload;
        session.agent.onProviderStreamEvent = onProviderStreamEvent;
    }
}
