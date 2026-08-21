/** composed-task/v1 允许 Planner 看到并调用的 Member Process 白名单：Tool 名、面向模型的描述和是否付费 */
import type { ProcessIdentity } from "../../process-runtime/index.js";

/** Whether one successful run of the Member spends money or persists an artefact. */
export type MemberSideEffect = "none" | "priced";

export type MemberSpec = Readonly<{
    process: string;
    version: string;
    /** The Tool name the Planner sees; lower snake case, unique in the list. */
    toolName: string;
    /** One or two sentences the model reads to decide when to call it. */
    description: string;
    sideEffect: MemberSideEffect;
}>;

/**
 * The reviewed list. Adding a Member means the Planner may spend that
 * Process's budget on any request, so each entry is a deliberate decision,
 * not a reflection of what happens to be in the catalog.
 */
export const composedMembers: readonly MemberSpec[] = Object.freeze([
    Object.freeze({
        process: "content-processing",
        version: "v1",
        toolName: "run_content_processing",
        description:
            "Refine one block of business text through the approved content service. Input {content}; output {content}.",
        sideEffect: "none" as const,
    }),
    Object.freeze({
        process: "titled-content-processing",
        version: "v1",
        toolName: "run_titled_content_processing",
        description:
            "Combine a title with a body and refine the result through the approved content service. Input {title, body}; output {title, content}.",
        sideEffect: "none" as const,
    }),
    Object.freeze({
        process: "minimal-zine-poster",
        version: "v1",
        toolName: "run_minimal_zine_poster",
        description:
            "Priced. Compile a brief into a minimal zine poster and render one 3:5 image. Input {brief, text?}; output includes image.url.",
        sideEffect: "priced" as const,
    }),
    Object.freeze({
        process: "crt-interface-image",
        version: "v1",
        toolName: "run_crt_interface_image",
        description:
            "Priced. Re-render a public HTTPS reference image as a CRT interface PNG. Input {sourceImageUrl, palette, aspectRatio}; output includes image.url.",
        sideEffect: "priced" as const,
    }),
    Object.freeze({
        process: "news-image-narrative-monument",
        version: "v1",
        toolName: "run_news_image_narrative_monument",
        description:
            "Priced. Render a news cover in the narrative-monument style from a title and summary. Input {title, summary}; output includes image.url.",
        sideEffect: "priced" as const,
    }),
    Object.freeze({
        process: "news-image-pale-watercolor",
        version: "v1",
        toolName: "run_news_image_pale_watercolor",
        description:
            "Priced. Render a news cover in the pale-watercolor style from a title and summary. Input {title, summary}; output includes image.url.",
        sideEffect: "priced" as const,
    }),
    Object.freeze({
        process: "news-image-raw-humanism",
        version: "v1",
        toolName: "run_news_image_raw_humanism",
        description:
            "Priced. Render a news cover in the raw-humanism style from a title and summary. Input {title, summary}; output includes image.url.",
        sideEffect: "priced" as const,
    }),
]);

export function memberIdentities(
    members: readonly MemberSpec[],
): readonly ProcessIdentity[] {
    return Object.freeze(
        members.map(({ process, version }) =>
            Object.freeze({ id: process, version }),
        ),
    );
}
