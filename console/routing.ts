import { useEffect, useState } from "preact/hooks";

export type Route =
    | Readonly<{ view: "runs" }>
    | Readonly<{ view: "run"; runId: string }>
    | Readonly<{ view: "processes" }>
    | Readonly<{ view: "skills" }>
    | Readonly<{ view: "skill"; name: string; version: string }>
    | Readonly<{ view: "stats" }>
    | Readonly<{ view: "submit" }>;

/**
 * Hash routing rather than history routing: the console is mounted under a
 * deployment-chosen base path, and a hash needs no server-side rewrite rule to
 * keep a deep link working.
 */
export function parseRoute(hash: string): Route {
    const path = hash.replace(/^#\/?/, "");
    const [head, ...rest] = path.split("/");
    if (head === "run" && rest[0]) {
        return { view: "run", runId: decodeURIComponent(rest[0]) };
    }
    if (head === "skills" && rest[0]) {
        const identity = decodeURIComponent(rest[0]);
        const separator = identity.indexOf("@");
        if (separator > 0) {
            return {
                view: "skill",
                name: identity.slice(0, separator),
                version: identity.slice(separator + 1),
            };
        }
    }
    if (
        head === "processes" ||
        head === "skills" ||
        head === "stats" ||
        head === "submit"
    ) {
        return { view: head };
    }
    return { view: "runs" };
}

export function hrefFor(route: Route): string {
    switch (route.view) {
        case "run":
            return `#/run/${encodeURIComponent(route.runId)}`;
        case "runs":
            return "#/runs";
        case "skill":
            return `#/skills/${encodeURIComponent(`${route.name}@${route.version}`)}`;
        default:
            return `#/${route.view}`;
    }
}

export function useRoute(): Route {
    const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
    useEffect(() => {
        const onChange = () => setRoute(parseRoute(location.hash));
        addEventListener("hashchange", onChange);
        return () => removeEventListener("hashchange", onChange);
    }, []);
    return route;
}
