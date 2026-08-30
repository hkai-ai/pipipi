/** 从权威成功 Turn 重建受预算约束的公共 Session Context 与 Working Summary */
import type {
    AcceptedAgentTurnInput,
    AgentConversationContext,
    AgentPublicHistoryTurn,
    AgentRegistrationLimits,
} from "./registration.js";
import type { StoredAgentTurn } from "./store.js";

export function assembleAgentConversationContext(
    turns: readonly StoredAgentTurn[],
    currentInput: AcceptedAgentTurnInput,
    limits: AgentRegistrationLimits,
): AgentConversationContext {
    const completed = turns.filter(
        (turn): turn is Extract<StoredAgentTurn, { status: "succeeded" }> =>
            turn.status === "succeeded",
    );
    const baselineCost = valueTokens({
        input: currentInput,
        context: { history: [] },
    });
    let remaining = Math.max(0, limits.maxContextTokens - baselineCost);
    const history: AgentPublicHistoryTurn[] = [];

    for (const turn of completed.slice().reverse()) {
        if (history.length >= limits.maxHistoryTurns) break;
        const publicTurn = toPublicTurn(turn);
        const cost = valueTokens(publicTurn) + 1;
        if (cost > remaining) break;
        history.unshift(publicTurn);
        remaining -= cost;
    }

    const summarized = completed.slice(0, completed.length - history.length);
    const summaryBudget = Math.min(
        Math.max(0, remaining - 32),
        limits.maxSummaryTokens,
    );
    const workingSummary = fitSummary(
        buildWorkingSummary(summarized, summaryBudget),
        history,
        currentInput,
        limits.maxContextTokens,
    );
    return Object.freeze({
        ...(workingSummary ? { workingSummary } : {}),
        history: Object.freeze(history.map((turn) => structuredClone(turn))),
    });
}

function fitSummary(
    summary: string | undefined,
    history: readonly AgentPublicHistoryTurn[],
    currentInput: AcceptedAgentTurnInput,
    limit: number,
): string | undefined {
    if (!summary) return undefined;
    const fits = (value: string) =>
        valueTokens({
            input: currentInput,
            context: { workingSummary: value, history },
        }) <= limit;
    if (fits(summary)) return summary;

    const characters = [...summary.replace(/…$/u, "")];
    let low = 0;
    let high = characters.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(`${characters.slice(0, middle).join("")}…`)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    const shortened = characters.slice(0, low).join("");
    return shortened && fits(`${shortened}…`) ? `${shortened}…` : undefined;
}

export function estimateAgentContextTokens(value: unknown): number {
    return valueTokens(value);
}

function toPublicTurn(
    turn: Extract<StoredAgentTurn, { status: "succeeded" }>,
): AgentPublicHistoryTurn {
    return Object.freeze({
        turnId: turn.turnId,
        sequence: turn.sequence,
        input: structuredClone(turn.input),
        output: structuredClone(turn.output),
    });
}

function buildWorkingSummary(
    turns: readonly Extract<StoredAgentTurn, { status: "succeeded" }>[],
    budget: number,
): string | undefined {
    if (turns.length === 0 || budget < 1) return undefined;
    const lines = turns.map(
        (turn) =>
            `Turn ${turn.sequence} user: ${plainText(turn.input)}\nTurn ${turn.sequence} assistant: ${plainText(turn.output)}`,
    );
    const complete = lines.join("\n");
    if (Buffer.byteLength(complete, "utf8") <= budget) return complete;
    const suffix = "…";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    if (budget <= suffixBytes) return undefined;
    let result = "";
    for (const character of complete) {
        if (
            Buffer.byteLength(result + character, "utf8") + suffixBytes >
            budget
        ) {
            break;
        }
        result += character;
    }
    return result ? `${result}${suffix}` : undefined;
}

function plainText(value: AcceptedAgentTurnInput): string {
    return value.content.map((block) => block.text).join("\n");
}

function valueTokens(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}
