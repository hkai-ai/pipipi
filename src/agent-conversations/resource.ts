/** 定义 owner-scoped Agent 图片资源解析边界及受控服务和内存 Adapter */

export const agentImageMediaTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
] as const;

export type AgentImageMediaType = (typeof agentImageMediaTypes)[number];

export type AgentImageResource = Readonly<{
    resourceId: string;
    mediaType: AgentImageMediaType;
    byteSize: number;
    width: number;
    height: number;
}>;

export type AgentImageAccess = Readonly<{
    resourceId: string;
    mediaType: AgentImageMediaType;
    data: string;
}>;

export type AgentImageProjection = Readonly<{
    url: string;
    expiresAt: string;
}>;

export type AcquiredAgentImage = Readonly<{
    access: AgentImageAccess;
    release: () => Promise<void>;
}>;

export type AgentResourceResolver = Readonly<{
    inspectInput: (request: {
        ownerId: string;
        resourceId: string;
    }) => Promise<AgentImageResource | undefined>;
    inspectOutput: (request: {
        ownerId: string;
        resourceId: string;
        turnId: string;
    }) => Promise<AgentImageResource | undefined>;
    acquire: (request: {
        ownerId: string;
        resource: AgentImageResource;
        signal: AbortSignal;
    }) => Promise<AcquiredAgentImage | undefined>;
    project: (request: {
        ownerId: string;
        resource: AgentImageResource;
    }) => Promise<AgentImageProjection | undefined>;
}>;

export type OwnedAgentResourceService = Readonly<{
    inspect: (request: {
        ownerId: string;
        resourceId: string;
        purpose: "input" | "output";
        turnId?: string;
    }) => Promise<unknown>;
    readModelContent: (request: {
        ownerId: string;
        resourceId: string;
        signal: AbortSignal;
    }) => Promise<unknown>;
    createReadProjection: (request: {
        ownerId: string;
        resourceId: string;
    }) => Promise<unknown>;
}>;

export function createOwnedServiceAgentResourceResolver(
    service: OwnedAgentResourceService,
): AgentResourceResolver {
    return Object.freeze({
        inspectInput: async ({ ownerId, resourceId }) =>
            parseResource(
                await service.inspect({
                    ownerId,
                    resourceId,
                    purpose: "input",
                }),
                resourceId,
            ),
        inspectOutput: async ({ ownerId, resourceId, turnId }) =>
            parseResource(
                await service.inspect({
                    ownerId,
                    resourceId,
                    purpose: "output",
                    turnId,
                }),
                resourceId,
            ),
        acquire: async ({ ownerId, resource, signal }) => {
            const content = await service.readModelContent({
                ownerId,
                resourceId: resource.resourceId,
                signal,
            });
            const access = parseAccess(content, resource);
            return access
                ? Object.freeze({ access, release: async () => {} })
                : undefined;
        },
        project: async ({ ownerId, resource }) =>
            parseProjection(
                await service.createReadProjection({
                    ownerId,
                    resourceId: resource.resourceId,
                }),
            ),
    });
}

export type InMemoryAgentImageRecord = Readonly<{
    ownerId: string;
    resource: AgentImageResource;
    modelData: string;
    projection: AgentImageProjection;
    outputTurnIds?: readonly string[];
}>;

export function createInMemoryAgentResourceResolver(
    records: readonly InMemoryAgentImageRecord[],
    events: {
        acquired?: (resourceId: string) => void;
        released?: (resourceId: string) => void;
    } = {},
): AgentResourceResolver {
    for (const record of records) assertInMemoryRecord(record);
    const byId = new Map(
        records.map((record) => [
            record.resource.resourceId,
            Object.freeze({
                ...structuredClone(record),
                resource: requireResource(record.resource),
                projection: requireProjection(record.projection),
            }),
        ]),
    );
    if (byId.size !== records.length) {
        throw new Error("Agent image resource identity is duplicated");
    }
    return Object.freeze({
        inspectInput: async ({ ownerId, resourceId }) => {
            const record = byId.get(resourceId);
            return record?.ownerId === ownerId
                ? structuredClone(record.resource)
                : undefined;
        },
        inspectOutput: async ({ ownerId, resourceId, turnId }) => {
            const record = byId.get(resourceId);
            return record?.ownerId === ownerId &&
                record.outputTurnIds?.includes(turnId)
                ? structuredClone(record.resource)
                : undefined;
        },
        acquire: async ({ ownerId, resource, signal }) => {
            const record = byId.get(resource.resourceId);
            if (
                signal.aborted ||
                record?.ownerId !== ownerId ||
                !sameResource(record.resource, resource)
            ) {
                return undefined;
            }
            events.acquired?.(resource.resourceId);
            return Object.freeze({
                access: Object.freeze({
                    resourceId: resource.resourceId,
                    mediaType: resource.mediaType,
                    data: record.modelData,
                }),
                release: async () => {
                    events.released?.(resource.resourceId);
                },
            });
        },
        project: async ({ ownerId, resource }) => {
            const record = byId.get(resource.resourceId);
            return record?.ownerId === ownerId &&
                sameResource(record.resource, resource)
                ? structuredClone(record.projection)
                : undefined;
        },
    });
}

function assertInMemoryRecord(record: InMemoryAgentImageRecord): void {
    if (
        typeof record.ownerId !== "string" ||
        record.ownerId.trim().length === 0 ||
        Buffer.byteLength(record.ownerId, "utf8") > 512 ||
        typeof record.modelData !== "string" ||
        record.modelData.length === 0 ||
        record.outputTurnIds?.some(
            (turnId) =>
                typeof turnId !== "string" ||
                turnId.trim().length === 0 ||
                Buffer.byteLength(turnId, "utf8") > 256,
        )
    ) {
        throw new Error("In-memory Agent image record is invalid");
    }
}

export function requireResource(value: unknown): AgentImageResource {
    const resource = parseResource(value);
    if (!resource) throw new Error("Agent image resource is invalid");
    return resource;
}

function parseResource(
    value: unknown,
    expectedId?: string,
): AgentImageResource | undefined {
    if (!isRecord(value) || Object.keys(value).length !== 5) return undefined;
    const { resourceId, mediaType, byteSize, width, height } = value;
    if (
        typeof resourceId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(resourceId) ||
        (expectedId !== undefined && resourceId !== expectedId) ||
        !agentImageMediaTypes.includes(mediaType as AgentImageMediaType) ||
        !positiveInteger(byteSize) ||
        !positiveInteger(width) ||
        !positiveInteger(height)
    ) {
        return undefined;
    }
    return Object.freeze({
        resourceId,
        mediaType: mediaType as AgentImageMediaType,
        byteSize,
        width,
        height,
    });
}

function parseAccess(
    value: unknown,
    resource: AgentImageResource,
): AgentImageAccess | undefined {
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 3 ||
        value.resourceId !== resource.resourceId ||
        value.mediaType !== resource.mediaType ||
        typeof value.data !== "string" ||
        value.data.length === 0
    ) {
        return undefined;
    }
    return Object.freeze({
        resourceId: resource.resourceId,
        mediaType: resource.mediaType,
        data: value.data,
    });
}

function requireProjection(value: unknown): AgentImageProjection {
    const projection = parseProjection(value);
    if (!projection) throw new Error("Agent image projection is invalid");
    return projection;
}

function parseProjection(value: unknown): AgentImageProjection | undefined {
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 2 ||
        typeof value.url !== "string" ||
        !isHttpsUrl(value.url) ||
        typeof value.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt))
    ) {
        return undefined;
    }
    return Object.freeze({ url: value.url, expiresAt: value.expiresAt });
}

function sameResource(
    left: AgentImageResource,
    right: AgentImageResource,
): boolean {
    return (
        left.resourceId === right.resourceId &&
        left.mediaType === right.mediaType &&
        left.byteSize === right.byteSize &&
        left.width === right.width &&
        left.height === right.height
    );
}

function positiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}
