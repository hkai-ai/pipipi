/**
 * The operator console is one self-contained document: no bundler, no static
 * asset route, no external origin. It ships inside the API image, so a release
 * can never serve a page and a server that disagree about the run shape.
 */
export function renderConsolePage(basePath: string): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Business Process 控制台</title>
<style>
${consoleStyles}
</style>
</head>
<body>
<header>
    <h1>Business Process 控制台</h1>
    <p class="warning">此页面会真实调用生产流程。每次提交都会生成图片并产生费用。</p>
</header>

<main>
<section class="panel">
    <h2>提交任务</h2>
    <form id="submit-form">
        <label>Business Process
            <select id="process" name="process"></select>
        </label>
        <div id="fields"></div>
        <button type="submit" id="submit-button">提交</button>
        <p class="hint" id="submit-hint">同步执行，出图最长可能等待 4 分钟。页面关闭不影响执行，结果仍会写入下方记录。</p>
    </form>
    <pre id="submit-result" hidden></pre>
</section>

<section class="panel">
    <h2>Process 目录 <button type="button" id="toggle-catalog">展开</button></h2>
    <p class="hint">字段约束由服务端执行校验的 Schema 推导，不是手写。错误语义与计费边界见业务接口文档。</p>
    <div id="catalog" hidden></div>
</section>

<section class="panel">
    <h2>任务记录 <button type="button" id="refresh">刷新</button></h2>
    <p class="hint" id="records-hint">按记录时间倒序，跨发版保留。</p>
    <div id="records"></div>
    <button type="button" id="load-more" hidden>加载更早</button>
</section>
</main>

<script>
const basePath = ${JSON.stringify(basePath)};
${consoleScript}
</script>
</body>
</html>
`;
}

const consoleStyles = `
:root {
    color-scheme: light dark;
    --surface: #ffffff;
    --ink: #1a1a1a;
    --muted: #5f6b7a;
    --line: #d8dee6;
    --ground: #f4f6f8;
    --ok: #1f7a4d;
    --bad: #b3261e;
}
@media (prefers-color-scheme: dark) {
    :root {
        --surface: #1c2128;
        --ink: #e6edf3;
        --muted: #97a3b1;
        --line: #303845;
        --ground: #12161c;
        --ok: #4ac07f;
        --bad: #f28b82;
    }
}
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 24px;
    background: var(--ground);
    color: var(--ink);
    font: 15px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
main { display: grid; gap: 20px; max-width: 1100px; margin: 20px auto 0; }
header { max-width: 1100px; margin: 0 auto; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px; }
.warning { color: var(--bad); margin: 0; font-size: 13px; }
.hint { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
label { display: block; margin-bottom: 12px; font-size: 13px; color: var(--muted); }
select, input, textarea {
    display: block; width: 100%; margin-top: 4px; padding: 8px;
    background: var(--ground); color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px;
    font: inherit;
}
textarea { min-height: 84px; resize: vertical; }
button {
    padding: 8px 16px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--ground); color: var(--ink); font: inherit; cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: progress; }
pre { overflow-x: auto; background: var(--ground); padding: 12px; border-radius: 6px; font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
td.run-id { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.status-succeeded { color: var(--ok); }
.status-failed { color: var(--bad); }
.thumb { width: 96px; height: auto; border-radius: 4px; border: 1px solid var(--line); display: block; }
.record-input { max-width: 360px; white-space: pre-wrap; word-break: break-word; color: var(--muted); font-size: 12px; margin: 0; }
.table-scroll { overflow-x: auto; }
.trace-toggle {
    padding: 2px 6px; font-family: ui-monospace, monospace; font-size: 11px;
    color: var(--muted); background: none; border: 1px dashed var(--line);
}
.trace-toggle:hover { color: var(--ink); border-style: solid; }
details { border-top: 1px solid var(--line); padding: 10px 0; }
details summary { cursor: pointer; font-weight: 500; }
details table { margin-bottom: 8px; }
.timeline {
    margin: 4px 0; padding-left: 20px;
    font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.8;
}
`;

const consoleScript = `
const processes = [
    { id: "content-processing", label: "content-processing 处理文本", fields: [{ name: "content", type: "textarea", required: true }] },
    { id: "titled-content-processing", label: "titled-content-processing 标题+正文", fields: [{ name: "title", type: "text", required: true }, { name: "body", type: "textarea", required: true }] },
    { id: "minimal-zine-poster", label: "minimal-zine-poster 极简海报", fields: [{ name: "brief", type: "textarea", required: true }, { name: "text", type: "text", required: false }] },
    { id: "crt-interface-image", label: "crt-interface-image CRT 风格", fields: [
        { name: "sourceImageUrl", type: "text", required: true },
        { name: "palette", type: "select", required: true, options: ["经典", "粉黛", "极客01", "极客02", "复古01", "复古02", "游戏01", "游戏02", "如图"] },
        { name: "aspectRatio", type: "select", required: true, options: ["4:3", "3:4", "16:9", "9:16"] },
        { name: "grain", type: "select", required: false, options: ["normal", "fine", "coarse"] },
    ] },
    { id: "news-image-narrative-monument", label: "news-image-narrative-monument 叙事碑", fields: newsFields() },
    { id: "news-image-pale-watercolor", label: "news-image-pale-watercolor 淡彩绘本", fields: newsFields() },
    { id: "news-image-raw-humanism", label: "news-image-raw-humanism 原质人文", fields: newsFields() },
];

function newsFields() {
    return [
        { name: "title", type: "text", required: true },
        { name: "summary", type: "textarea", required: true },
    ];
}

const processSelect = document.getElementById("process");
const fieldsContainer = document.getElementById("fields");
const form = document.getElementById("submit-form");
const submitButton = document.getElementById("submit-button");
const submitResult = document.getElementById("submit-result");
const recordsContainer = document.getElementById("records");
const recordsHint = document.getElementById("records-hint");
const loadMoreButton = document.getElementById("load-more");
let nextBefore;

for (const process of processes) {
    const option = document.createElement("option");
    option.value = process.id;
    option.textContent = process.label;
    processSelect.append(option);
}

function currentProcess() {
    return processes.find((process) => process.id === processSelect.value) ?? processes[0];
}

function renderFields() {
    fieldsContainer.replaceChildren();
    for (const field of currentProcess().fields) {
        const label = document.createElement("label");
        label.textContent = field.name + (field.required ? " *" : "（可选）");
        let control;
        if (field.type === "select") {
            control = document.createElement("select");
            if (!field.required) control.append(new Option("（不填）", ""));
            for (const value of field.options) control.append(new Option(value, value));
        } else {
            control = document.createElement(field.type === "textarea" ? "textarea" : "input");
            if (field.type === "text") control.type = "text";
        }
        control.name = field.name;
        if (field.required) control.required = true;
        label.append(control);
        fieldsContainer.append(label);
    }
}

processSelect.addEventListener("change", renderFields);
renderFields();

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = {};
    for (const field of currentProcess().fields) {
        const value = form.elements[field.name].value.trim();
        if (value.length > 0) input[field.name] = value;
    }
    submitButton.disabled = true;
    submitButton.textContent = "执行中…";
    submitResult.hidden = false;
    submitResult.textContent = "已提交，等待流程返回…";
    try {
        const response = await fetch("/execute", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ process: processSelect.value, version: "v1", input }),
        });
        const body = await response.json();
        submitResult.textContent = response.status + " " + JSON.stringify(body, null, 2);
    } catch (error) {
        submitResult.textContent = "请求失败：" + String(error);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "提交";
        await loadRecords({ reset: true });
    }
});

function imageUrls(output) {
    if (typeof output !== "object" || output === null) return [];
    return Object.values(output)
        .filter((value) => typeof value === "object" && value !== null && typeof value.url === "string")
        .map((value) => value.url);
}

function renderRecords(records, { reset }) {
    if (reset) recordsContainer.replaceChildren();
    let table = recordsContainer.querySelector("table");
    if (!table) {
        const scroll = document.createElement("div");
        scroll.className = "table-scroll";
        table = document.createElement("table");
        table.innerHTML = "<thead><tr><th>记录时间</th><th>Process</th><th>状态</th><th>输入</th><th>产出</th><th>runId</th></tr></thead><tbody></tbody>";
        scroll.append(table);
        recordsContainer.append(scroll);
    }
    const body = table.querySelector("tbody");
    for (const record of records) {
        const row = document.createElement("tr");

        const time = document.createElement("td");
        time.textContent = new Date(record.recordedAt).toLocaleString();
        row.append(time);

        const process = document.createElement("td");
        process.textContent = (record.process ?? "unknown") + " " + (record.version ?? "");
        row.append(process);

        const status = document.createElement("td");
        status.className = "status-" + record.status;
        status.textContent = record.status === "failed"
            ? "failed " + (record.errorCode ?? "")
            : "succeeded";
        row.append(status);

        const input = document.createElement("td");
        const inputText = document.createElement("pre");
        inputText.className = "record-input";
        inputText.textContent = record.content
            ? JSON.stringify(record.content.input, null, 1)
            : "（未记录）";
        input.append(inputText);
        row.append(input);

        const output = document.createElement("td");
        const urls = imageUrls(record.content?.output);
        if (urls.length > 0) {
            for (const url of urls) {
                const link = document.createElement("a");
                link.href = url;
                link.target = "_blank";
                link.rel = "noreferrer";
                const image = document.createElement("img");
                image.className = "thumb";
                image.loading = "lazy";
                image.src = url;
                image.alt = "";
                link.append(image);
                output.append(link);
            }
        } else if (record.content && record.content.output !== undefined) {
            const text = document.createElement("pre");
            text.className = "record-input";
            text.textContent = JSON.stringify(record.content.output, null, 1);
            output.append(text);
        } else {
            output.textContent = "—";
        }
        row.append(output);

        const runId = document.createElement("td");
        runId.className = "run-id";
        const trace = document.createElement("button");
        trace.type = "button";
        trace.className = "trace-toggle";
        trace.textContent = record.runId;
        trace.title = "展开活动时间线";
        runId.append(trace);
        row.append(runId);

        const timelineRow = document.createElement("tr");
        const timelineCell = document.createElement("td");
        timelineCell.colSpan = 6;
        timelineRow.hidden = true;
        timelineRow.append(timelineCell);
        trace.addEventListener("click", () =>
            toggleTimeline(record.runId, timelineRow, timelineCell),
        );

        body.append(row, timelineRow);
    }
}

async function toggleTimeline(runId, timelineRow, timelineCell) {
    if (!timelineRow.hidden) {
        timelineRow.hidden = true;
        return;
    }
    timelineRow.hidden = false;
    if (timelineCell.dataset.loaded === "true") return;
    timelineCell.textContent = "读取活动时间线…";
    try {
        const response = await fetch(
            basePath + "/runs/" + encodeURIComponent(runId) + "/activities",
            { headers: { accept: "application/json" } },
        );
        if (!response.ok) throw new Error("HTTP " + response.status);
        const { activities } = await response.json();
        timelineCell.replaceChildren(renderTimeline(activities));
        timelineCell.dataset.loaded = "true";
    } catch (error) {
        timelineCell.textContent = "读取活动时间线失败：" + String(error);
    }
}

function renderTimeline(activities) {
    if (activities.length === 0) {
        const empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "没有活动记录。执行可能发生在启用持久化之前。";
        return empty;
    }
    const list = document.createElement("ol");
    list.className = "timeline";
    for (const entry of activities) {
        const item = document.createElement("li");
        const label = entry.activity
            ? entry.event + " · " + entry.activity
            : entry.event;
        const outcome = entry.outcome ? " → " + entry.outcome : "";
        const duration =
            entry.durationMs === undefined ? "" : " (" + entry.durationMs + " ms)";
        item.textContent =
            "#" + entry.attemptNumber + "." + entry.sequence + "  " +
            label + outcome + duration +
            (entry.errorCode ? "  " + entry.errorCode : "");
        if (entry.outcome && entry.outcome !== "succeeded") {
            item.className = "status-failed";
        }
        list.append(item);
    }
    return list;
}

async function loadRecords({ reset }) {
    const query = new URLSearchParams({ limit: "50" });
    if (!reset && nextBefore) query.set("before", nextBefore);
    try {
        const response = await fetch(basePath + "/runs?" + query.toString(), {
            headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const page = await response.json();
        if (reset) nextBefore = undefined;
        renderRecords(page.records, { reset });
        nextBefore = page.nextBefore;
        loadMoreButton.hidden = nextBefore === undefined;
        if (reset && page.records.length === 0) {
            recordsContainer.textContent = "暂无记录。";
        }
        recordsHint.textContent = "按记录时间倒序，跨发版保留。";
    } catch (error) {
        recordsHint.textContent = "读取记录失败：" + String(error);
    }
}

const catalogContainer = document.getElementById("catalog");
const catalogToggle = document.getElementById("toggle-catalog");
let catalogLoaded = false;

function describeConstraint(property) {
    const parts = [property.type ?? "any"];
    if (property.enum) parts.push(property.enum.join(" | "));
    if (property.minLength !== undefined || property.maxLength !== undefined) {
        parts.push((property.minLength ?? 0) + "–" + (property.maxLength ?? "∞") + " 字符");
    }
    if (property.default !== undefined) parts.push("缺省 " + JSON.stringify(property.default));
    return parts.join("，");
}

function renderSchemaTable(schema) {
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>字段</th><th>必填</th><th>约束</th></tr></thead><tbody></tbody>";
    const body = table.querySelector("tbody");
    const required = new Set(schema?.required ?? []);
    for (const [name, property] of Object.entries(schema?.properties ?? {})) {
        const row = document.createElement("tr");
        for (const text of [name, required.has(name) ? "是" : "否", describeConstraint(property)]) {
            const cell = document.createElement("td");
            cell.textContent = text;
            row.append(cell);
        }
        body.append(row);
    }
    return table;
}

async function loadCatalog() {
    if (catalogLoaded) return;
    catalogContainer.textContent = "读取 Process 目录…";
    try {
        const response = await fetch(basePath + "/processes", {
            headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const { processes } = await response.json();
        catalogContainer.replaceChildren();
        for (const entry of processes) {
            const block = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = entry.process + " / " + entry.version;
            block.append(summary);

            const meta = document.createElement("p");
            meta.className = "hint";
            meta.textContent =
                "活动：" + entry.activities.join(" → ") +
                "　最大 Attempt：" + entry.retry.maximumAttempts;
            block.append(meta);

            for (const [label, schema] of [["输入", entry.input], ["输出", entry.output]]) {
                const heading = document.createElement("p");
                heading.className = "hint";
                heading.textContent = label;
                block.append(heading);
                block.append(
                    schema
                        ? renderSchemaTable(schema)
                        : Object.assign(document.createElement("p"), {
                              className: "hint",
                              textContent: "该 Schema 无法自动生成，请查阅业务接口文档。",
                          }),
                );
            }
            catalogContainer.append(block);
        }
        catalogLoaded = true;
    } catch (error) {
        catalogContainer.textContent = "读取 Process 目录失败：" + String(error);
    }
}

catalogToggle.addEventListener("click", async () => {
    catalogContainer.hidden = !catalogContainer.hidden;
    catalogToggle.textContent = catalogContainer.hidden ? "展开" : "收起";
    if (!catalogContainer.hidden) await loadCatalog();
});

document.getElementById("refresh").addEventListener("click", () => loadRecords({ reset: true }));
loadMoreButton.addEventListener("click", () => loadRecords({ reset: false }));
loadRecords({ reset: true });
setInterval(() => {
    if (!submitButton.disabled) loadRecords({ reset: true });
}, 15000);
`;
