/** 装配运维后台导航、共享目录与按职责拆分的页面。 */
import {
    Activity,
    AlertTriangle,
    KeyRound,
    Layers,
    ListChecks,
    Play,
    Sparkles,
    Terminal,
    Workflow,
} from "lucide-react";
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { listProcesses } from "./api.js";
import { CallerKeysView } from "./caller-keys.jsx";
import { LiveView } from "./live.jsx";
import { Overview } from "./overview.jsx";
import { useAsync } from "./resource.js";
import { hrefFor, type Route, useRoute } from "./routing.js";
import { RunsView, RunView } from "./runs.jsx";
import { ProcessesView, SkillsView, SkillView, SubmitView } from "./tools.jsx";
import "./styles.css";

const mainLinks: readonly { route: Route; label: string; icon: ReactNode }[] = [
    {
        route: { view: "overview" },
        label: "运行概览",
        icon: <Activity size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
    {
        route: { view: "runs" },
        label: "运行记录",
        icon: <ListChecks size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
    {
        route: { view: "exceptions" },
        label: "异常排查",
        icon: <AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
    {
        route: { view: "caller-keys" },
        label: "调用方密钥",
        icon: <KeyRound size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
];
const toolLinks: readonly { route: Route; label: string; icon: ReactNode }[] = [
    {
        route: { view: "processes" },
        label: "业务流程",
        icon: <Workflow size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
    {
        route: { view: "skills" },
        label: "Agent 技能",
        icon: <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
    {
        route: { view: "submit" },
        label: "手动调试",
        icon: <Play size={15} strokeWidth={1.75} aria-hidden="true" />,
    },
];
function Console() {
    const route = useRoute();
    const local =
        document.querySelector('meta[name="pipipi-local-trace"]') !== null;
    const catalog = useAsync(() => listProcesses(), []);
    const current =
        route.view === "run"
            ? "runs"
            : route.view === "skill"
              ? "skills"
              : route.view;
    return (
        <div className="console-layout">
            <aside className="sidebar">
                <a className="brand" href={hrefFor({ view: "overview" })}>
                    <Layers size={16} strokeWidth={2} aria-hidden="true" />
                    <span>运行管理</span>
                </a>
                <nav aria-label="运行管理">
                    {mainLinks.map((link) => (
                        <a
                            key={link.label}
                            href={hrefFor(link.route)}
                            aria-current={
                                current === link.route.view ? "page" : undefined
                            }
                        >
                            {link.icon}
                            <span>{link.label}</span>
                        </a>
                    ))}
                </nav>
                <p className="nav-label">流程与调试</p>
                <nav aria-label="流程与调试">
                    {local ? (
                        <a
                            href={hrefFor({ view: "live" })}
                            aria-current={
                                current === "live" ? "page" : undefined
                            }
                        >
                            <Terminal
                                size={15}
                                strokeWidth={1.75}
                                aria-hidden="true"
                            />
                            <span>本地实时调试</span>
                        </a>
                    ) : null}
                    {toolLinks.map((link) => (
                        <a
                            key={link.label}
                            href={hrefFor(link.route)}
                            aria-current={
                                current === link.route.view ? "page" : undefined
                            }
                        >
                            {link.icon}
                            <span>{link.label}</span>
                        </a>
                    ))}
                </nav>
                <p className="sidebar-note">
                    记录用于观测。
                    <br />
                    执行状态以业务查询结果为准。
                </p>
            </aside>
            <div className="workspace">
                <header className="topbar">
                    <span className="topbar-title">
                        <span className="live-dot" aria-hidden="true" />
                        服务运行与排障
                    </span>
                    <span className="topbar-meta">
                        时间按浏览器本地时区显示
                    </span>
                </header>
                <main className="shell" id="main-content">
                    {route.view === "overview" ||
                    route.view === "exceptions" ? (
                        <Overview
                            hours={route.hours}
                            exceptions={route.view === "exceptions"}
                        />
                    ) : null}
                    {route.view === "runs" ? (
                        <>
                            {catalog.error ? (
                                <p role="alert" className="notice">
                                    业务目录读取失败；已保存的筛选与运行记录仍可查询。
                                </p>
                            ) : null}
                            <RunsView
                                key={hrefFor(route)}
                                processes={catalog.value?.processes ?? []}
                                filters={route.filters}
                            />
                        </>
                    ) : null}
                    {route.view === "caller-keys" ? (
                        <CallerKeysView callerId={route.callerId} />
                    ) : null}
                    {local && route.view === "live" ? (
                        <LiveView
                            key={route.runId ?? "active"}
                            runId={route.runId}
                        />
                    ) : null}
                    {route.view === "run" ? (
                        <RunView
                            key={route.runId}
                            runId={route.runId}
                            back={route.back}
                        />
                    ) : null}
                    {route.view === "processes" ? (
                        <ProcessesView
                            processes={catalog.value?.processes ?? []}
                            loading={catalog.loading}
                            error={catalog.error}
                            process={route.process}
                            version={route.version}
                        />
                    ) : null}
                    {route.view === "skills" ? <SkillsView /> : null}
                    {route.view === "skill" ? (
                        <SkillView name={route.name} version={route.version} />
                    ) : null}
                    {route.view === "submit" ? (
                        catalog.error ? (
                            <p role="alert" className="notice">
                                目录读取失败，请刷新页面后重试。
                            </p>
                        ) : (
                            <SubmitView
                                processes={catalog.value?.processes ?? []}
                                process={route.process}
                                version={route.version}
                            />
                        )
                    ) : null}
                </main>
            </div>
        </div>
    );
}
const mount = document.getElementById("console");
if (mount) {
    createRoot(mount).render(
        <StrictMode>
            <Console />
        </StrictMode>,
    );
}
