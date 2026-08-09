import OSS from "ali-oss";
import {
  normalizeUploadObjectRequest,
  ObjectStorageError,
  type ObjectStorageCapability,
  type ObjectUrlAccess,
  type StoredObject,
  type UploadObjectOptions,
  type UploadObjectRequest,
} from "./object-storage.js";

export type AliyunOssStorageOptions = {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  endpoint?: string;
  cname?: boolean;
  timeoutMs?: number;
  urlAccess?: ObjectUrlAccess;
  publicBaseUrl?: string;
  signedUrlTtlSeconds?: number;
};

export type AliyunOssClient = Pick<OSS, "put" | "signatureUrlV4">;

export type AliyunOssStorageDependencies = {
  clientFactory?: (options: OSS.Options) => AliyunOssClient;
  now?: () => Date;
};

const provider = "aliyun-oss";

/** Stores in-memory business artifacts in one Alibaba Cloud OSS bucket. */
export class AliyunOssStorage implements ObjectStorageCapability {
  readonly provider = provider;
  readonly #bucket: string;
  readonly #client: AliyunOssClient;
  readonly #timeoutMs: number;
  readonly #urlAccess: ObjectUrlAccess;
  readonly #publicBaseUrl?: string;
  readonly #signedUrlTtlSeconds: number;
  readonly #now: () => Date;

  constructor(
    options: AliyunOssStorageOptions,
    dependencies: AliyunOssStorageDependencies = {},
  ) {
    const region = requiredTrimmed(options.region, "OSS region");
    const bucket = validateBucket(options.bucket);
    const accessKeyId = requiredTrimmed(
      options.accessKeyId,
      "OSS AccessKey ID",
    );
    const accessKeySecret = requiredTrimmed(
      options.accessKeySecret,
      "OSS AccessKey secret",
    );
    const stsToken = optionalTrimmed(options.stsToken, "OSS STS token");
    const endpoint = normalizeHttpsUrl(options.endpoint, "OSS endpoint");
    const publicBaseUrl = normalizeHttpsUrl(
      options.publicBaseUrl,
      "OSS public base URL",
    );
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? 60_000,
      "OSS timeout",
    );
    const signedUrlTtlSeconds = positiveInteger(
      options.signedUrlTtlSeconds ?? 3_600,
      "OSS signed URL TTL",
    );
    if (signedUrlTtlSeconds > 604_800) {
      throw new Error("OSS signed URL TTL must not exceed 604800 seconds");
    }
    if (options.cname && !endpoint) {
      throw new Error("OSS endpoint is required when CNAME mode is enabled");
    }
    const urlAccess = options.urlAccess ?? "signed";
    if (urlAccess !== "signed" && urlAccess !== "public") {
      throw new Error("OSS URL access must be signed or public");
    }

    const clientFactory =
      dependencies.clientFactory ?? ((clientOptions) => new OSS(clientOptions));
    this.#client = clientFactory({
      region,
      bucket,
      accessKeyId,
      accessKeySecret,
      authorizationV4: true,
      secure: true,
      timeout: timeoutMs,
      ...(stsToken ? { stsToken } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(options.cname === undefined ? {} : { cname: options.cname }),
    });
    this.#bucket = bucket;
    this.#timeoutMs = timeoutMs;
    this.#urlAccess = urlAccess;
    this.#publicBaseUrl = publicBaseUrl;
    this.#signedUrlTtlSeconds = signedUrlTtlSeconds;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async upload(
    request: UploadObjectRequest,
    options: UploadObjectOptions = {},
  ): Promise<StoredObject> {
    options.signal?.throwIfAborted();
    const input = normalizeUploadObjectRequest(request);
    const headers: Record<string, string> = {};
    if (input.cacheControl) headers["Cache-Control"] = input.cacheControl;
    let stage: "upload" | "url" = "upload";

    try {
      const result = await this.#client.put(
        input.objectKey,
        Buffer.from(input.bytes),
        {
          mime: input.contentType,
          timeout: this.#timeoutMs,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        },
      );
      options.signal?.throwIfAborted();
      stage = "url";

      const url =
        this.#urlAccess === "signed"
          ? await this.#client.signatureUrlV4(
              "GET",
              this.#signedUrlTtlSeconds,
              undefined,
              input.objectKey,
            )
          : this.#publicBaseUrl
            ? objectUrl(this.#publicBaseUrl, input.objectKey)
            : result.url;
      options.signal?.throwIfAborted();
      validateReturnedUrl(url);

      const etag = readHeader(result.res.headers, "etag");
      const requestId = readHeader(result.res.headers, "x-oss-request-id");
      return {
        provider,
        bucket: this.#bucket,
        objectKey: input.objectKey,
        url,
        urlAccess: this.#urlAccess,
        ...(this.#urlAccess === "signed"
          ? {
              urlExpiresAt: new Date(
                this.#now().getTime() + this.#signedUrlTtlSeconds * 1_000,
              ).toISOString(),
            }
          : {}),
        contentType: input.contentType,
        size: input.bytes.byteLength,
        ...(etag ? { etag } : {}),
        ...(requestId ? { requestId } : {}),
      };
    } catch (error) {
      if (options.signal?.aborted) options.signal.throwIfAborted();
      if (error instanceof ObjectStorageError) throw error;
      const details = readOssError(error);
      throw new ObjectStorageError(
        stage === "upload"
          ? "Alibaba Cloud OSS could not store the object"
          : "Alibaba Cloud OSS stored the object but could not create its URL",
        {
          provider,
          ...details,
        },
      );
    }
  }
}

function requiredTrimmed(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace`);
  }
  return value;
}

function optionalTrimmed(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredTrimmed(value, name);
}

function validateBucket(value: string): string {
  const bucket = requiredTrimmed(value, "OSS bucket");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error(
      "OSS bucket must contain 3-63 lowercase letters, digits, or hyphens",
    );
  }
  return bucket;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeHttpsUrl(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = requiredTrimmed(value, name);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function objectUrl(baseUrl: string, objectKey: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const encodedKey = objectKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  url.pathname = `${basePath}/${encodedKey}`;
  return url.toString();
}

function validateReturnedUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OSS returned an invalid object URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("OSS returned a non-HTTPS object URL");
  }
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function readOssError(error: unknown): {
  status?: number;
  code?: string;
  requestId?: string;
} {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const status =
    typeof record.status === "number" ? record.status : undefined;
  const code = typeof record.code === "string" ? record.code : undefined;
  const requestId =
    typeof record.requestId === "string"
      ? record.requestId
      : readNestedRequestId(record.res);
  return {
    ...(status === undefined ? {} : { status }),
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function readNestedRequestId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  return readHeader(
    (response as Record<string, unknown>).headers,
    "x-oss-request-id",
  );
}
