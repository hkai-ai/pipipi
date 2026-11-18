/** 为失败结果提供可悬停、聚焦或点击的中文排查提示。 */
import { Tooltip } from "@base-ui/react/tooltip";
import { explainError } from "./diagnostics.js";

export function ErrorHint({ code }: { code?: string }) {
    const explanation = explainError(code);
    return (
        <Tooltip.Root>
            <Tooltip.Trigger
                type="button"
                delay={0}
                closeDelay={150}
                closeOnClick={false}
                className={`error-trigger ${code === "DEPENDENCY_FAILURE_AFTER_COMMIT" ? "status-billed" : "status-failed"}`}
            >
                {explanation.title}
            </Tooltip.Trigger>
            <Tooltip.Portal>
                <Tooltip.Positioner
                    className="error-tooltip-positioner"
                    side="bottom"
                    align="start"
                    sideOffset={8}
                    collisionPadding={12}
                >
                    <Tooltip.Popup role="tooltip" className="error-tooltip">
                        <strong>{explanation.title}</strong>
                        <p>{explanation.next}</p>
                        <span>点击运行 ID 查看执行步骤与详情。</span>
                    </Tooltip.Popup>
                </Tooltip.Positioner>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}
