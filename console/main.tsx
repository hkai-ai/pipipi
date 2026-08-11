import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type ConsoleProcessDescription, listProcesses } from "./api.js";
import { hrefFor, type Route, useRoute } from "./routing.js";
import "./styles.css";
import {
    ProcessesView,
    RunsView,
    RunView,
    StatsView,
    SubmitView,
} from "./views.jsx";

const tabs: readonly Readonly<{ route: Route; label: string }>[] = [
    { route: { view: "runs" }, label: "运行记录" },
    { route: { view: "stats" }, label: "服务压力" },
    { route: { view: "processes" }, label: "Process 目录" },
    { route: { view: "submit" }, label: "提交任务" },
];

function Console() {
    const route = useRoute();
    // The catalog is fixed for a release, so it is fetched once and shared by
    // the filter list and the submit form.
    const [processes, setProcesses] = useState<
        readonly ConsoleProcessDescription[]
    >([]);

    useEffect(() => {
        listProcesses().then(
            (result) => setProcesses(result.processes),
            () => setProcesses([]),
        );
    }, []);

    return (
        <div class="shell">
            <header class="masthead">
                <h1>Business Process 控制台</h1>
                <span class="hint">运维视图，非产品接口</span>
            </header>
            <p class="cost-warning">
                此页面直接调用生产服务。提交任务会真实出图并产生费用。
            </p>

            <nav>
                {tabs.map((tab) => (
                    <a
                        key={tab.label}
                        href={hrefFor(tab.route)}
                        aria-current={
                            tab.route.view === route.view ||
                            (tab.route.view === "runs" && route.view === "run")
                                ? "page"
                                : undefined
                        }
                    >
                        {tab.label}
                    </a>
                ))}
            </nav>

            {route.view === "runs" ? (
                <RunsView processes={processes.map((entry) => entry.process)} />
            ) : null}
            {route.view === "run" ? <RunView runId={route.runId} /> : null}
            {route.view === "stats" ? <StatsView /> : null}
            {route.view === "processes" ? <ProcessesView /> : null}
            {route.view === "submit" ? (
                <SubmitView processes={processes} />
            ) : null}
        </div>
    );
}

const mount = document.getElementById("console");
if (mount) render(<Console />, mount);
