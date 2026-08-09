import { describe, expect, it } from "vitest";
import {
  createBullMqProcessWorker,
  createBullMqProcessWorkQueue,
} from "../src/bullmq-process-work-queue.js";
import type { ProcessWorker } from "../src/process-worker.js";

const unusedWorker: ProcessWorker = {
  process: async () => "ignored",
};

describe("BullMQ Process Work adapters", () => {
  it("rejects an invalid Redis URL before creating a connection", () => {
    expect(() =>
      createBullMqProcessWorkQueue({ redisUrl: "https://redis.example" }),
    ).toThrow("Redis URL must be a valid redis:// or rediss:// URL");
    expect(() =>
      createBullMqProcessWorker({
        redisUrl: "not-a-url",
        worker: unusedWorker,
      }),
    ).toThrow("Redis URL must be a valid redis:// or rediss:// URL");
  });

  it("rejects unsafe queue names and prefixes", () => {
    expect(() =>
      createBullMqProcessWorkQueue({
        redisUrl: "redis://127.0.0.1:6379",
        queueName: "process:runs",
      }),
    ).toThrow("Process Work Queue name is invalid");
    expect(() =>
      createBullMqProcessWorkQueue({
        redisUrl: "redis://127.0.0.1:6379",
        prefix: "bad prefix",
      }),
    ).toThrow("Process Work Queue prefix is invalid");
  });

  it("rejects invalid worker concurrency before creating a connection", () => {
    expect(() =>
      createBullMqProcessWorker({
        redisUrl: "redis://127.0.0.1:6379",
        worker: unusedWorker,
        concurrency: 0,
      }),
    ).toThrow("Process Worker concurrency must be a positive safe integer");
  });
});
