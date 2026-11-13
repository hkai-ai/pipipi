/** 保存可分享的筛选窗口与详情返回位置，兼容已有 hash 链接。 */
import { useEffect, useState } from "preact/hooks";
import type { RunFilters } from "./api.js";

export type Route =
    | Readonly<{ view: "overview" | "exceptions"; hours?: number }>
    | Readonly<{ view: "runs"; filters?: RunFilters }>
    | Readonly<{ view: "live"; runId?: string }>
    | Readonly<{ view: "run"; runId: string; back?: string }>
    | Readonly<{ view: "skills" | "submit" }>
    | Readonly<{ view: "processes"; process?: string; version?: string }>
    | Readonly<{ view: "skill"; name: string; version: string }>;

export function parseRoute(hash: string): Route {
    try {
        const [path, search = ""] = hash.replace(/^#\/?/, "").split("?");
        const [head, ...rest] = path.split("/");
        const params = new URLSearchParams(search);
        if (head === "live")
            return {
                view: "live",
                runId: rest[0] ? decodeURIComponent(rest[0]) : undefined,
            };
        if (head === "run" && rest[0]) {
            const back = params.get("back") ?? undefined;
            return {
                view: "run",
                runId: decodeURIComponent(rest[0]),
                back: safeBack(back),
            };
        }
        if (head === "skills" && rest[0]) {
            const identity = decodeURIComponent(rest[0]);
            const separator = identity.indexOf("@");
            if (separator > 0)
                return {
                    view: "skill",
                    name: identity.slice(0, separator),
                    version: identity.slice(separator + 1),
                };
        }
        if (head === "runs") {
            const filters: Record<string, string> = {};
            for (const name of [
                "process",
                "version",
                "status",
                "errorCode",
                "since",
                "until",
            ]) {
                const value = params.get(name);
                if (value) filters[name] = value;
            }
            if (filters.status !== "succeeded" && filters.status !== "failed")
                delete filters.status;
            return { view: "runs", filters: filters as RunFilters };
        }
        if (head === "overview" || head === "stats" || head === "exceptions") {
            const hours = Number(params.get("hours") ?? 24);
            return {
                view: head === "exceptions" ? "exceptions" : "overview",
                hours: [1, 24, 168, 720].includes(hours) ? hours : 24,
            };
        }
        if (head === "processes")
            return {
                view: "processes",
                process: params.get("process") || undefined,
                version: params.get("version") || undefined,
            };
        if (head === "skills" || head === "submit") return { view: head };
    } catch {
        /* A malformed shared link returns to the overview. */
    }
    return { view: "overview" };
}

function safeBack(value?: string): string | undefined {
    return value && /^#\/(runs|overview|exceptions)(\?|$)/.test(value)
        ? value
        : undefined;
}

export function hrefFor(route: Route): string {
    const query = new URLSearchParams();
    switch (route.view) {
        case "processes":
            if (route.process) query.set("process", route.process);
            if (route.version) query.set("version", route.version);
            return `#/processes${query.size ? `?${query}` : ""}`;
        case "live":
            return route.runId
                ? `#/live/${encodeURIComponent(route.runId)}`
                : "#/live";
        case "run":
            if (safeBack(route.back)) query.set("back", route.back as string);
            return `#/run/${encodeURIComponent(route.runId)}${query.size ? `?${query}` : ""}`;
        case "runs":
            for (const name of [
                "process",
                "version",
                "status",
                "errorCode",
                "since",
                "until",
            ] as const) {
                const value = route.filters?.[name];
                if (value) query.set(name, value);
            }
            return `#/runs${query.size ? `?${query}` : ""}`;
        case "skill":
            return `#/skills/${encodeURIComponent(`${route.name}@${route.version}`)}`;
        case "overview":
        case "exceptions":
            return `#/${route.view}?hours=${route.hours ?? 24}`;
        default:
            return `#/${route.view}`;
    }
}

export function useRoute(): Route {
    const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
    useEffect(() => {
        const change = () => setRoute(parseRoute(location.hash));
        addEventListener("hashchange", change);
        return () => removeEventListener("hashchange", change);
    }, []);
    return route;
}
