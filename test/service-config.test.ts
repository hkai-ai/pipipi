import { describe, expect, it } from "vitest";
import { parseBusinessApiBaseUrl } from "../src/service-config.js";

describe("service startup configuration", () => {
  it("requires a Business Capability URL", () => {
    expect(() => parseBusinessApiBaseUrl(undefined)).toThrow(
      "BUSINESS_API_BASE_URL is required",
    );
  });

  it.each([
    "not-a-url-with-secret-value",
    "file:///private/business-api",
    "https://user:secret-value@business.example",
  ])("rejects unsafe Business Capability URL %j without echoing it", (value) => {
    let error: unknown;
    try {
      parseBusinessApiBaseUrl(value);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "BUSINESS_API_BASE_URL must be a valid HTTP(S) URL without credentials",
    );
    expect((error as Error).message).not.toContain(value);
    expect((error as Error).message).not.toContain("secret-value");
  });

  it("accepts and normalizes an HTTP(S) Business Capability URL", () => {
    expect(
      parseBusinessApiBaseUrl("https://business.example/api"),
    ).toBe("https://business.example/api");
  });
});
