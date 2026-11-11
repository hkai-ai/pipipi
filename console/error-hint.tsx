/** 为失败结果提供可悬停、聚焦或点击的中文排查提示。 */
import { createPortal } from "preact/compat";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { explainError } from "./diagnostics.js";

export function ErrorHint({ code }: { code?: string }) {
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const pendingClose = useRef<ReturnType<typeof setTimeout>>();
    const [position, setPosition] = useState<{ left: number; top: number }>();
    const explanation = explainError(code);
    const positionFor = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
            left: Math.max(12, Math.min(rect.left, window.innerWidth - 332)),
            top: Math.max(
                12,
                Math.min(rect.bottom + 8, window.innerHeight - 170),
            ),
        };
    };
    const keepOpen = () => clearTimeout(pendingClose.current);
    const show = (element: HTMLElement) => {
        keepOpen();
        setPosition(positionFor(element));
    };
    const hideSoon = () => {
        keepOpen();
        pendingClose.current = setTimeout(() => setPosition(undefined), 150);
    };
    useEffect(() => {
        const close = () => setPosition(undefined);
        const reposition = () => {
            const element = trigger.current;
            if (!element) return;
            const rect = element.getBoundingClientRect();
            setPosition((current) =>
                current && rect.bottom > 0 && rect.top < window.innerHeight
                    ? positionFor(element)
                    : undefined,
            );
        };
        const dismissOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") close();
        };
        window.addEventListener("scroll", reposition, true);
        window.addEventListener("resize", close);
        window.addEventListener("keydown", dismissOnEscape);
        return () => {
            clearTimeout(pendingClose.current);
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", close);
            window.removeEventListener("keydown", dismissOnEscape);
        };
    }, []);
    return (
        <>
            <button
                ref={trigger}
                type="button"
                class={`error-trigger ${code === "DEPENDENCY_FAILURE_AFTER_COMMIT" ? "status-billed" : "status-failed"}`}
                aria-describedby={position ? id : undefined}
                onMouseEnter={(event) => show(event.currentTarget)}
                onMouseLeave={hideSoon}
                onFocus={(event) => show(event.currentTarget)}
                onBlur={() => setPosition(undefined)}
                onClick={(event) => show(event.currentTarget)}
            >
                {explanation.title}
            </button>
            {position
                ? createPortal(
                      <div
                          id={id}
                          role="tooltip"
                          class="error-tooltip"
                          style={position}
                          onMouseEnter={keepOpen}
                          onMouseLeave={hideSoon}
                      >
                          <strong>{explanation.title}</strong>
                          <p>{explanation.next}</p>
                          <span>点击运行 ID 查看执行步骤与详情。</span>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
