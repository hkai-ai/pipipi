/** 漫画分镜的固定预设、输入合同与服务端版式约束。 */
import { z } from "zod";
import { imageBackgroundSchema } from "../image-background.js";
import { sourcePhotoSchema } from "./capability.js";

export const mangaPanelsInputSchema = z.strictObject({
    sourceImageUrl: sourcePhotoSchema,
    preset: z
        .enum(["three-panel-details", "sketchy-mixed-panels"])
        .default("three-panel-details"),
    background: imageBackgroundSchema.optional(),
});

const layouts = {
    "three-panel-details":
        "EXACTLY THREE rectangular image panels. Reading order: top-right, top-left, then bottom. The top row occupies about one third of the page: top-right shows the same face and eyes; top-left studies one distinctive detail actually visible in the source. The bottom panel occupies about two thirds and preserves the source subject's visible pose. Use clean black contours, controlled black fills, restrained fine screentone, consistent narrow white gutters and clean panel borders.",
    "sketchy-mixed-panels":
        "EXACTLY THREE irregular image panels. Reading order: upper-right detail, dominant main panel, lower-left detail. The dominant slanted panel occupies roughly 70 percent of the page and preserves the source subject's visible pose. The upper-right inset shows the same eyes; the lower-left inset studies one distinctive detail actually visible in the source. Use expressive variable brush contours, broken dry-ink strokes, chunky shadow masses and selective crosshatching. Keep white gutters clear, face precise and panel borders legible; sparse directional strokes may support the existing pose without inventing action.",
} as const;

export function mangaPanelsDesignInstructions(
    input: z.infer<typeof mangaPanelsInputSchema>,
): string {
    return `\nServer-owned manga page design: ${layouts[input.preset]} Neutral black ink with white paper highlights, no colored ink. All panels depict the same source subject; each detail is a crop of visible source content, not a new pose or event. If no hand or accessory is visible, use an existing hair or garment detail instead. Preserve face, hair, costume, anatomy and object contacts across panels. Fit the source-visible subject in the main panel without cutting off source-visible hands or fingertips, and without adding unseen body parts. Keep every subject inside its picture panel. Create a text-free artwork. Remove source lettering, including small emblem letters and numbers; draw no dialogue boxes, speech bubbles or empty text placeholders. Panel frames contain pictures, never text.`;
}
