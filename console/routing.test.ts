import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute } from "./routing.js";

describe("console navigation", () => {
    it("links to an exact process version without confusing it with a skill", () => {
        const route = {
            view: "processes",
            process: "character-emoji",
            version: "v2",
        } as const;
        expect(parseRoute(hrefFor(route))).toEqual(route);
        expect(parseRoute("#/processes?process=retired&version=v99")).toEqual({
            view: "processes",
            process: "retired",
            version: "v99",
        });
    });
    it("keeps exact version, errors and timestamp boundaries through a shared link", () => {
        const route = {
            view: "runs",
            filters: {
                process: "character-emoji",
                version: "v3",
                status: "failed",
                errorCode: "AGENT_FAILURE",
                since: "2026-11-01T02:00:00.123Z",
                until: "2026-11-02T02:00:00.123Z",
            },
        } as const;
        expect(parseRoute(hrefFor(route))).toEqual(route);
        const detail = {
            view: "run",
            runId: "run/a?b",
            back: hrefFor(route),
        } as const;
        expect(parseRoute(hrefFor(detail))).toEqual(detail);
    });
    it("preserves old stats links and defaults to overview", () => {
        expect(parseRoute("#/stats")).toEqual({ view: "overview", hours: 24 });
        expect(parseRoute("")).toEqual({ view: "overview" });
        expect(parseRoute("#/exceptions?hours=720")).toEqual({
            view: "exceptions",
            hours: 720,
        });
    });
    it("rejects external return locations and tolerates malformed links", () => {
        expect(parseRoute("#/run/id?back=https%3A%2F%2Fevil.example")).toEqual({
            view: "run",
            runId: "id",
            back: undefined,
        });
        expect(parseRoute("#/run/%E0%A4%A")).toEqual({ view: "overview" });
        expect(
            hrefFor({ view: "run", runId: "id", back: "javascript:alert(1)" }),
        ).toBe("#/run/id");
    });
});
