import { describe, expect, it } from "vitest";
import { loadHttpConfiguration } from "../src/http-config.js";

describe("HTTP startup configuration", () => {
  it("uses the controlled MVP defaults when limits are not configured", () => {
    expect(loadHttpConfiguration({})).toEqual({
      maxRequestBodyBytes: 262_144,
      maxConcurrentExecutions: 4,
    });
  });

  it("loads explicit positive integer limits from the environment", () => {
    expect(
      loadHttpConfiguration({
        HTTP_MAX_REQUEST_BODY_BYTES: "524288",
        MAX_CONCURRENT_EXECUTIONS: "7",
      }),
    ).toEqual({
      maxRequestBodyBytes: 524_288,
      maxConcurrentExecutions: 7,
    });
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "not-a-number",
  ])("rejects invalid request body byte limit %j", (value) => {
    expect(() =>
      loadHttpConfiguration({ HTTP_MAX_REQUEST_BODY_BYTES: value }),
    ).toThrow("HTTP_MAX_REQUEST_BODY_BYTES must be a positive integer");
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "not-a-number",
  ])("rejects invalid concurrent execution limit %j", (value) => {
    expect(() =>
      loadHttpConfiguration({ MAX_CONCURRENT_EXECUTIONS: value }),
    ).toThrow("MAX_CONCURRENT_EXECUTIONS must be a positive integer");
  });
});
