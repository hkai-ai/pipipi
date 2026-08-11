import type { ComponentChildren } from "preact";
import type { ProcessRunRecord } from "./api.js";

/**
 * `DEPENDENCY_FAILURE_AFTER_COMMIT` means the image was generated and billed
 * but could not be delivered. It is real money lost and must not read like an
 * ordinary failure in a list.
 */
export const billedFailureCode = "DEPENDENCY_FAILURE_AFTER_COMMIT";

export function StatusLabel({ record }: { record: ProcessRunRecord }) {
    if (record.status === "succeeded") {
        return <span class="status-succeeded">succeeded</span>;
    }
    const billed = record.errorCode === billedFailureCode;
    return (
        <span class={billed ? "status-billed" : "status-failed"}>
            {billed ? "已计费未交付" : "failed"}
            {record.errorCode ? ` ${record.errorCode}` : ""}
        </span>
    );
}

export function formatTime(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleString(undefined, { hour12: false });
}

export function formatDuration(milliseconds: number | undefined): string {
    if (milliseconds === undefined) return "—";
    if (milliseconds < 1_000) return `${milliseconds} ms`;
    return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

type ImageReference = Readonly<{ url: string; label: string }>;

/** Any output field shaped like the documented image object. */
export function imagesOf(output: unknown): readonly ImageReference[] {
    if (typeof output !== "object" || output === null) return [];
    return Object.entries(output as Record<string, unknown>)
        .filter(
            (entry): entry is [string, { url: string }] =>
                typeof entry[1] === "object" &&
                entry[1] !== null &&
                typeof (entry[1] as { url?: unknown }).url === "string",
        )
        .map(([label, value]) => ({ label, url: value.url }));
}

/**
 * Object storage lifecycle rules can delete an image while the record that
 * points at it is still retained. A broken thumbnail is reported as an expired
 * reference so it does not read as a service fault.
 */
export function Thumbnail({ image }: { image: ImageReference }) {
    return (
        <a
            href={image.url}
            target="_blank"
            rel="noreferrer"
            title={image.label}
        >
            <img
                class="thumb"
                loading="lazy"
                src={image.url}
                alt={image.label}
                onError={(event) => {
                    const element = event.currentTarget as HTMLImageElement;
                    const note = document.createElement("div");
                    note.className = "thumb-missing";
                    note.textContent = `${image.label}\n对象已过期或不可访问`;
                    element.replaceWith(note);
                }}
            />
        </a>
    );
}

export function Panel({
    title,
    action,
    children,
}: {
    title: string;
    action?: ComponentChildren;
    children: ComponentChildren;
}) {
    return (
        <section class="panel">
            <h2>
                {title} {action}
            </h2>
            {children}
        </section>
    );
}
