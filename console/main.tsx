/** 装配运维后台导航、共享目录与按职责拆分的页面。 */
import { render } from "preact";
import { listProcesses } from "./api.js";
import { Overview } from "./overview.jsx";
import { useAsync } from "./resource.js";
import { hrefFor, type Route, useRoute } from "./routing.js";
import { RunsView, RunView } from "./runs.jsx";
import { ProcessesView, SkillsView, SkillView, SubmitView } from "./tools.jsx";
import "./styles.css";

const mainLinks: readonly { route: Route; label: string }[] = [
    { route: { view: "overview" }, label: "运行概览" },
    { route: { view: "runs" }, label: "运行记录" },
    { route: { view: "exceptions" }, label: "异常排查" },
];
const toolLinks: readonly { route: Route; label: string }[] = [
    { route: { view: "processes" }, label: "业务流程" },
    { route: { view: "skills" }, label: "Agent 技能" },
    { route: { view: "submit" }, label: "手动调试" },
];
function Console() {
    const route = useRoute();
    const catalog = useAsync(() => listProcesses(), []);
    const current =
        route.view === "run"
            ? "runs"
            : route.view === "skill"
              ? "skills"
              : route.view;
    return (
        <div class="console-layout">
            <aside class="sidebar">
                <a class="brand" href={hrefFor({ view: "overview" })}>
                    运行管理
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
                            {link.label}
                        </a>
                    ))}
                </nav>
                <p class="nav-label">流程与调试</p>
                <nav aria-label="流程与调试">
                    {toolLinks.map((link) => (
                        <a
                            key={link.label}
                            href={hrefFor(link.route)}
                            aria-current={
                                current === link.route.view ? "page" : undefined
                            }
                        >
                            {link.label}
                        </a>
                    ))}
                </nav>
                <p class="sidebar-note">
                    记录用于观测。
                    <br />
                    执行状态以业务查询结果为准。
                </p>
            </aside>
            <div class="workspace">
                <header class="topbar">
                    <span>服务运行与排障</span>
                    <span>时间按浏览器本地时区显示</span>
                </header>
                <main class="shell" id="main-content">
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
                                <p role="alert" class="notice">
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
                    {route.view === "run" ? (
                        <RunView
                            key={route.runId}
                            runId={route.runId}
                            back={route.back}
                        />
                    ) : null}
                    {route.view === "processes" ? (
                        <ProcessesView
                            key={hrefFor(route)}
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
                            <p role="alert" class="notice">
                                目录读取失败，请刷新页面后重试。
                            </p>
                        ) : (
                            <SubmitView
                                processes={catalog.value?.processes ?? []}
                            />
                        )
                    ) : null}
                </main>
            </div>
        </div>
    );
}
const mount = document.getElementById("console");
if (mount) render(<Console />, mount);
