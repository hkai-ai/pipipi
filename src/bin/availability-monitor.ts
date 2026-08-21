/** 构造 Availability Monitor 命令，执行一次性探测并输出报告 */
import { constructAvailabilityMonitor } from "../app/availability-monitor.js";

const monitor = constructAvailabilityMonitor(process.env);
const result = await monitor.run();
console.log(JSON.stringify(result));

if (result.report.status !== "available" || result.notification === "failed") {
    process.exitCode = 1;
}
