/** 在单次 Process 运行范围内累计模型与图片调用的供应商费用，并投影为公开的 cost 字段。 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RunCostSource = "provider" | "estimate";

/** `/execute` 响应中的费用字段；amount 只含已知费用，complete=false 时为下限。 */
export type RunCost = Readonly<{
    currency: "USD";
    amount: number;
    source: RunCostSource | "mixed";
    complete: boolean;
}>;

/** 跨进程传递的账本快照（内部 Business API 经响应头回传）。 */
export type CostLedgerSnapshot = Readonly<{
    usd: number;
    provider: number;
    estimate: number;
    unknown: number;
}>;

export type CostLedger = {
    /** 记录一次费用已知的调用；0 只在供应商明确回报时才应传入。 */
    recordKnown(usd: number, source: RunCostSource): void;
    /** 记录一次费用未知的调用，不估算。 */
    recordUnknown(): void;
    /** 并入子账本或远端快照。 */
    absorb(snapshot: CostLedgerSnapshot): void;
    snapshot(): CostLedgerSnapshot;
    /** 没有任何已知费用时返回 undefined，不拿 0 冒充免费。 */
    summary(): RunCost | undefined;
};

export function createCostLedger(): CostLedger {
    let usd = 0;
    let provider = 0;
    let estimate = 0;
    let unknown = 0;
    return {
        recordKnown(amount, source) {
            if (!Number.isFinite(amount) || amount < 0) {
                unknown += 1;
                return;
            }
            usd += amount;
            if (source === "provider") provider += 1;
            else estimate += 1;
        },
        recordUnknown() {
            unknown += 1;
        },
        absorb(snapshot) {
            usd += snapshot.usd;
            provider += snapshot.provider;
            estimate += snapshot.estimate;
            unknown += snapshot.unknown;
        },
        snapshot: () => ({ usd, provider, estimate, unknown }),
        summary() {
            if (provider + estimate === 0) return undefined;
            return {
                currency: "USD",
                // 消除浮点累加噪声，保留到 1e-10 美元。
                amount: Number(usd.toFixed(10)),
                source:
                    provider > 0 && estimate > 0
                        ? "mixed"
                        : provider > 0
                          ? "provider"
                          : "estimate",
                complete: unknown === 0,
            };
        },
    };
}

const context = new AsyncLocalStorage<CostLedger>();

export function currentCostLedger(): CostLedger | undefined {
    return context.getStore();
}

export function withCostLedger<T>(ledger: CostLedger, operation: () => T): T {
    return context.run(ledger, operation);
}

/** 无账本（非 Process 运行范围）时静默跳过，费用采集不得影响业务。 */
export function recordUnknownCost(): void {
    context.getStore()?.recordUnknown();
}

export function recordKnownCost(usd: number, source: RunCostSource): void {
    context.getStore()?.recordKnown(usd, source);
}

/**
 * LiteLLM 网关在响应头 `x-litellm-response-cost` 回报该次调用的美元费用。
 * 头缺失、非数字或为负时记为未知；明确的 0 照常计入。
 */
export const gatewayCostHeader = "x-litellm-response-cost";
export function recordGatewayResponseCost(headers: Headers): void {
    const raw = headers.get(gatewayCostHeader)?.trim();
    const value =
        raw && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : NaN;
    if (Number.isFinite(value)) recordKnownCost(value, "provider");
    else recordUnknownCost();
}

/** 内部 Business API 把本请求账本放在此响应头回传给调用的 Process。 */
export const businessApiCostHeader = "x-pipipi-cost-ledger";

export function encodeCostLedger(ledger: CostLedger): string {
    return JSON.stringify(ledger.snapshot());
}

function count(value: unknown): number | undefined {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
        ? value
        : undefined;
}

export function decodeCostLedger(
    raw: string | null,
): CostLedgerSnapshot | undefined {
    if (!raw || raw.length > 256) return undefined;
    try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        const { usd } = value;
        const provider = count(value.provider);
        const estimate = count(value.estimate);
        const unknown = count(value.unknown);
        if (
            typeof usd !== "number" ||
            !Number.isFinite(usd) ||
            usd < 0 ||
            provider === undefined ||
            estimate === undefined ||
            unknown === undefined
        )
            return undefined;
        return { usd, provider, estimate, unknown };
    } catch {
        return undefined;
    }
}

/**
 * 记录一次对内部 Business API 的调用结果：带账本头则并入；无头（旧服务）或 202
 * （后台仍在处理，费用尚未确定）记为未知。
 */
export function recordBusinessApiCost(response: Response): void {
    const ledger = context.getStore();
    if (!ledger) return;
    const snapshot = decodeCostLedger(
        response.headers.get(businessApiCostHeader),
    );
    if (snapshot) ledger.absorb(snapshot);
    if (!snapshot || response.status === 202) ledger.recordUnknown();
}

/** 包裹对内部 Business API 的 fetch：没有拿到响应时（超时、断连）无法确认是否已扣费。 */
export async function fetchBilled(
    fetcher: typeof globalThis.fetch,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
    let response: Response;
    try {
        response = await fetcher(input, init);
    } catch (error) {
        recordUnknownCost();
        throw error;
    }
    recordBusinessApiCost(response);
    return response;
}
