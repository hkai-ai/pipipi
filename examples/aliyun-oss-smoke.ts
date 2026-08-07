import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createObjectStorageFromEnvironment } from "../src/object-storage-config.js";
import type { StoredObject } from "../src/object-storage.js";

const storage = createObjectStorageFromEnvironment(process.env);
if (!storage) {
  throw new Error(
    "Set OBJECT_STORAGE_PROVIDER=aliyun-oss before running the OSS smoke test",
  );
}

const inputFile = resolve(
  process.env.OSS_SMOKE_FILE ?? "artifacts/gpt-image-2/latest.png",
);
const reportFile = resolve(
  process.env.OSS_SMOKE_REPORT_FILE ??
    "artifacts/object-storage/latest.json",
);
const bytes = await readFile(inputFile);
const digest = createHash("sha256").update(bytes).digest("hex");
const extension = extname(inputFile).toLowerCase() || ".bin";
const objectPrefix =
  process.env.OSS_SMOKE_OBJECT_PREFIX?.trim() || "object-storage-smoke";
const objectKey =
  process.env.OSS_SMOKE_OBJECT_KEY?.trim() ||
  `${objectPrefix}/${digest}${extension}`;
const contentType =
  process.env.OSS_SMOKE_CONTENT_TYPE?.trim() || contentTypeFor(extension);

let storedObject: StoredObject | undefined;
let uploadDurationMs: number | undefined;
let uploadError: string | undefined;
const uploadStartedAt = performance.now();
try {
  storedObject = await storage.upload({
    objectKey,
    bytes,
    contentType,
  });
} catch (error) {
  uploadError = formatError(error);
} finally {
  uploadDurationMs = Math.round(performance.now() - uploadStartedAt);
}

let verification:
  | {
      status: number;
      contentType?: string;
      contentRange?: string;
    }
  | undefined;
let verificationError: string | undefined;
if (storedObject) {
  try {
    const response = await fetch(storedObject.url, {
      headers: { range: "bytes=0-0" },
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`Object URL returned HTTP ${response.status}`);
    }
    verification = {
      status: response.status,
      ...(response.headers.get("content-type")
        ? { contentType: response.headers.get("content-type") ?? undefined }
        : {}),
      ...(response.headers.get("content-range")
        ? { contentRange: response.headers.get("content-range") ?? undefined }
        : {}),
    };
  } catch (error) {
    verificationError = formatError(error);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  passed:
    storedObject !== undefined &&
    uploadError === undefined &&
    verification !== undefined &&
    verificationError === undefined,
  input: {
    file: inputFile,
    bytes: bytes.length,
    sha256: digest,
    contentType,
  },
  requestedObjectKey: objectKey,
  uploadDurationMs,
  ...(storedObject ? { storedObject } : {}),
  ...(uploadError ? { uploadError } : {}),
  ...(verification ? { verification } : {}),
  ...(verificationError ? { verificationError } : {}),
  reportFile,
};

await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

function contentTypeFor(extension: string): string {
  const types: Record<string, string> = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
  };
  return types[extension] ?? "application/octet-stream";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
