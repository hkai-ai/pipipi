/** Availability Monitor 的 Interface 定义、Probe 编排与聚合状态判定 */
export type AvailabilityStatus = "available" | "degraded" | "unavailable";
export type AvailabilityKind = "http" | "redis";
export type AvailabilityAttribute = string | number | boolean;

export type AvailabilityProbeInspection = Readonly<{
    status: AvailabilityStatus;
    latencyMs: number;
    attributes: Readonly<Record<string, AvailabilityAttribute>>;
    errorCode?: string;
}>;

export type AvailabilityCheck = AvailabilityProbeInspection &
    Readonly<{
        name: string;
        kind: AvailabilityKind;
    }>;

export type AvailabilityReport = Readonly<{
    schemaVersion: 1;
    event: "service_availability_observed";
    revision: string;
    measuredAt: string;
    status: AvailabilityStatus;
    checks: readonly AvailabilityCheck[];
}>;

export type AvailabilityProbe = Readonly<{
    name: string;
    kind: AvailabilityKind;
    inspect: () => Promise<AvailabilityProbeInspection>;
}>;

export type AvailabilityNotifier = Readonly<{
    notify: (report: AvailabilityReport) => Promise<"succeeded" | "failed">;
}>;

export type AvailabilityMonitor = Readonly<{
    run: () => Promise<
        Readonly<{
            report: AvailabilityReport;
            notification: "succeeded" | "failed" | "skipped";
        }>
    >;
}>;

export function createAvailabilityMonitor(options: {
    revision: string;
    probes: readonly AvailabilityProbe[];
    notifier?: AvailabilityNotifier;
    clock?: () => string;
}): AvailabilityMonitor {
    if (!/^[0-9a-f]{40}$/.test(options.revision)) {
        throw new Error("Availability revision must be a full commit SHA");
    }
    if (options.probes.length < 1 || options.probes.length > 32) {
        throw new Error("Availability Monitor requires 1 to 32 probes");
    }
    const names = options.probes.map((probe) => validateProbeName(probe.name));
    if (new Set(names).size !== names.length) {
        throw new Error("Availability probe names must be unique");
    }
    const probes = Object.freeze([...options.probes]);
    const clock = options.clock ?? (() => new Date().toISOString());

    return Object.freeze({
        run: async () => {
            const measuredAt = validTimestamp(clock());
            const checks = Object.freeze(
                await Promise.all(probes.map(inspectProbe)),
            );
            const report = Object.freeze({
                schemaVersion: 1 as const,
                event: "service_availability_observed" as const,
                revision: options.revision,
                measuredAt,
                status: aggregateStatus(checks),
                checks,
            });
            if (report.status === "available" || !options.notifier) {
                return Object.freeze({
                    report,
                    notification: "skipped" as const,
                });
            }
            let notification: "succeeded" | "failed" = "failed";
            try {
                notification = await options.notifier.notify(report);
            } catch {
                notification = "failed";
            }
            return Object.freeze({ report, notification });
        },
    });
}

async function inspectProbe(
    probe: AvailabilityProbe,
): Promise<AvailabilityCheck> {
    try {
        const inspection = validateInspection(
            await probe.inspect(),
            probe.kind,
        );
        return Object.freeze({
            name: probe.name,
            kind: probe.kind,
            ...inspection,
        });
    } catch {
        return Object.freeze({
            name: probe.name,
            kind: probe.kind,
            status: "unavailable" as const,
            latencyMs: 0,
            attributes: Object.freeze({}),
            errorCode: "PROBE_FAILED",
        });
    }
}

function validateInspection(
    inspection: AvailabilityProbeInspection,
    kind: AvailabilityKind,
): AvailabilityProbeInspection {
    if (
        !["available", "degraded", "unavailable"].includes(inspection.status) ||
        !Number.isSafeInteger(inspection.latencyMs) ||
        inspection.latencyMs < 0 ||
        inspection.latencyMs > 300_000 ||
        typeof inspection.attributes !== "object" ||
        inspection.attributes === null ||
        Array.isArray(inspection.attributes)
    ) {
        throw new Error("Availability probe result is invalid");
    }
    const validators = attributeValidators[kind];
    const attributes = Object.fromEntries(
        Object.entries(inspection.attributes).map(([key, value]) => {
            if (!(key in validators) || !validators[key]?.(value)) {
                throw new Error("Availability probe attributes are invalid");
            }
            return [key, value] as const;
        }),
    );
    const errorCode = inspection.errorCode;
    if (errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) {
        throw new Error("Availability probe error code is invalid");
    }
    return Object.freeze({
        status: inspection.status,
        latencyMs: inspection.latencyMs,
        attributes: Object.freeze(attributes),
        ...(errorCode === undefined ? {} : { errorCode }),
    });
}

type AttributeValidator = (value: unknown) => boolean;

const attributeValidators: Readonly<
    Record<AvailabilityKind, Readonly<Record<string, AttributeValidator>>>
> = Object.freeze({
    http: Object.freeze({
        httpStatus: integerBetween(100, 599),
        semanticStatus: oneOf("ok", "ready"),
        role: matches(/^[a-z][a-z0-9-]{0,63}$/),
    }),
    redis: Object.freeze({
        configurationPresent: isBoolean,
        tlsConfigured: isBoolean,
        authenticationConfigured: isBoolean,
        version: matches(/^\d+\.\d+(?:\.\d+)?$/),
        usedMemoryBytes: integerBetween(0, Number.MAX_SAFE_INTEGER),
        maxMemoryBytes: integerBetween(0, Number.MAX_SAFE_INTEGER),
        memoryUtilizationPercent: integerBetween(0, 100),
        maxMemoryPolicy: matches(/^[a-z][a-z0-9-]{0,63}$/),
        evictedKeys: integerBetween(0, Number.MAX_SAFE_INTEGER),
        rejectedConnections: integerBetween(0, Number.MAX_SAFE_INTEGER),
        aofEnabled: isBoolean,
        aofLastWriteStatus: oneOf("ok", "err"),
        rdbLastSaveStatus: oneOf("ok", "err"),
        replicationRole: oneOf("master", "slave"),
        connectedReplicas: integerBetween(0, Number.MAX_SAFE_INTEGER),
    }),
});

function isBoolean(value: unknown): boolean {
    return typeof value === "boolean";
}

function integerBetween(minimum: number, maximum: number): AttributeValidator {
    return (value) =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= minimum &&
        value <= maximum;
}

function matches(pattern: RegExp): AttributeValidator {
    return (value) => typeof value === "string" && pattern.test(value);
}

function oneOf(...values: readonly string[]): AttributeValidator {
    return (value) => typeof value === "string" && values.includes(value);
}

function aggregateStatus(
    checks: readonly AvailabilityCheck[],
): AvailabilityStatus {
    if (checks.some((check) => check.status === "unavailable")) {
        return "unavailable";
    }
    return checks.some((check) => check.status === "degraded")
        ? "degraded"
        : "available";
}

function validateProbeName(value: string): string {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
        throw new Error("Availability probe name is invalid");
    }
    return value;
}

function validTimestamp(value: string): string {
    const milliseconds = new Date(value).getTime();
    if (
        !Number.isFinite(milliseconds) ||
        new Date(milliseconds).toISOString() !== value
    ) {
        throw new Error("Availability observation timestamp is invalid");
    }
    return value;
}
