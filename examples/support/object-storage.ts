export type ObjectUrlAccess = "public" | "signed";

export type UploadObjectRequest = {
  objectKey: string;
  bytes: Uint8Array;
  contentType: string;
  cacheControl?: string;
};

export type UploadObjectOptions = {
  signal?: AbortSignal;
};

export type StoredObject = {
  provider: string;
  bucket: string;
  objectKey: string;
  url: string;
  urlAccess: ObjectUrlAccess;
  urlExpiresAt?: string;
  contentType: string;
  size: number;
  etag?: string;
  requestId?: string;
};

export type ObjectStorageCapability = {
  readonly provider: string;
  upload: (
    request: UploadObjectRequest,
    options?: UploadObjectOptions,
  ) => Promise<StoredObject>;
};

export class ObjectStorageError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    options: {
      provider: string;
      status?: number;
      code?: string;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "ObjectStorageError";
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

export type NormalizedUploadObjectRequest = UploadObjectRequest & {
  contentType: string;
  cacheControl?: string;
};

export function normalizeUploadObjectRequest(
  request: UploadObjectRequest,
): NormalizedUploadObjectRequest {
  if (!(request.bytes instanceof Uint8Array)) {
    throw new TypeError("Object bytes must be a Uint8Array");
  }

  const objectKey = request.objectKey;
  if (
    typeof objectKey !== "string" ||
    objectKey.length === 0 ||
    objectKey !== objectKey.trim()
  ) {
    throw new Error("Object key must be a non-empty trimmed string");
  }
  const keyBytes = Buffer.byteLength(objectKey, "utf8");
  if (keyBytes > 1_023) {
    throw new Error("Object key must not exceed 1023 UTF-8 bytes");
  }
  if (objectKey.startsWith("/") || objectKey.includes("\\")) {
    throw new Error("Object key must be relative and use forward slashes");
  }
  if (/[\u0000-\u001f\u007f]/u.test(objectKey)) {
    throw new Error("Object key must not contain control characters");
  }
  if (objectKey.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Object key must not contain dot path segments");
  }

  const contentType = normalizeHeaderValue(request.contentType, "Content type");
  const cacheControl =
    request.cacheControl === undefined
      ? undefined
      : normalizeHeaderValue(request.cacheControl, "Cache-Control");

  return {
    ...request,
    objectKey,
    contentType,
    ...(cacheControl === undefined ? {} : { cacheControl }),
  };
}

function normalizeHeaderValue(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (/\r|\n/u.test(value)) {
    throw new Error(`${name} must not contain line breaks`);
  }
  return value.trim();
}
