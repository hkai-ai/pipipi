/** Mono Color 的五个固定预设、可编辑业务参数与最终设计约束。 */
import { z } from "zod";
import { imageBackgroundSchema } from "../image-background.js";
import { sourcePhotoSchema } from "./capability.js";

export const monoColorPresets = [
    "blue_orange_overlap",
    "blue_orange_diagonal_crop",
    "black_red_statement",
    "black_red_frame",
    "black_red_diagonal_type",
] as const;

// 旧请求只在输入边界转换，后续编译与渲染统一使用语义化预设名。
const legacyPresets = {
    within_reach: "blue_orange_overlap",
    half_hidden: "blue_orange_diagonal_crop",
    your_move: "black_red_statement",
    hold_still: "black_red_frame",
    look_again: "black_red_diagonal_type",
} as const;

const palettes = {
    cobalt_terracotta: ["cobalt blue #2148B8", "terracotta #C65F38"],
    charcoal_red: ["charcoal #30343A", "signal red #C83232"],
    green_oxblood: ["green #008A4B", "oxblood #8F3434"],
} as const;
const typography = {
    literary:
        "oversized high-contrast literary serif; prefer expressive lowercase only for automatically derived text",
    condensed:
        "heavy condensed sans-serif; prefer tall bold uppercase only for automatically derived text",
} as const;
const compositions = {
    editorial_cover:
        "Editorial cover: central or right subject, generous left negative space. Set a wide two-line lower title across the lower 35–45% of the poster at bold emphasis, interwoven with the existing subject silhouette. Let existing foreground details cross selected letters while keeping the words readable; do not confine the title to a small caption strip.",
    diagonal_crop:
        "Diagonal crop: crop close around the existing focal subject. Use a dominant upper title and a strong rising diagonal crop boundary to reveal the focal detail below it, such as the eyes when present. Align the main title to that boundary, with a much smaller lead word above when the wording permits. Keep a quiet lower-left annotation area. The diagonal must shape the image crop, not merely rotate a sentence down the side.",
    statement:
        "Frontal statement: center the existing subject without changing its pose. Set a wide, tightly stacked two-line lower title across the lower 35–45% at bold emphasis. Use natural foreground overlap only where the reference already provides it. Do not reduce the title to a single-line bottom caption or place it inside a colored panel.",
    frame: "Typographic viewfinder: split the title into a shorter top block and a substantially larger bottom block, leaving the focal subject clear between them. Integrate the existing silhouette with the title edges. Use existing framing gestures only when present; otherwise frame with cropping and type, without inventing fingers or rotating the subject.",
    diagonal_type:
        "Rising diagonal title: place the subject toward the right without changing its pose, leaving upper-left space. Set a large, tightly stacked two-line title rising from the lower-left toward the center and crossing the existing silhouette. Use thin paper-white knockouts where dark letters meet dark subject regions. Keep the title dominant rather than making a small upper-left label.",
} as const;
const emphasis = {
    gentle: "quiet scale contrast and generous whitespace; minimal crop or overlap",
    balanced:
        "balanced scale contrast, readable type and moderate crop or overlap",
    bold: "assertive oversized type and close crop or overlap without obscuring the subject's key identity",
} as const;
const textures = {
    light: "fine halftone confined to shaded areas, crisp contours and barely visible paper grain; keep highlights clear of dots",
    standard:
        "visible fine-to-medium halftone in shaded areas, lightly dry ink edges and restrained ink-density variation",
    strong: "coarser halftone and worn dry ink, while keeping identity and lettering legible",
} as const;
const presets = {
    blue_orange_overlap: {
        palette: "cobalt_terracotta",
        typography: "literary",
        composition: "editorial_cover",
        emphasis: "bold",
        texture: "light",
    },
    blue_orange_diagonal_crop: {
        palette: "cobalt_terracotta",
        typography: "literary",
        composition: "diagonal_crop",
        emphasis: "bold",
        texture: "light",
    },
    black_red_statement: {
        palette: "charcoal_red",
        typography: "condensed",
        composition: "statement",
        emphasis: "bold",
        texture: "light",
    },
    black_red_frame: {
        palette: "charcoal_red",
        typography: "condensed",
        composition: "frame",
        emphasis: "balanced",
        texture: "light",
    },
    black_red_diagonal_type: {
        palette: "charcoal_red",
        typography: "condensed",
        composition: "diagonal_type",
        emphasis: "bold",
        texture: "light",
    },
} as const;

export const monoColorInputSchema = z.strictObject({
    sourceImageUrl: sourcePhotoSchema,
    background: imageBackgroundSchema.optional(),
    text: z.string().trim().min(1).max(200).optional(),
    preset: z
        .preprocess(
            (value) =>
                typeof value === "string" && Object.hasOwn(legacyPresets, value)
                    ? legacyPresets[value as keyof typeof legacyPresets]
                    : value,
            z.enum(monoColorPresets),
        )
        .optional(),
    palette: z
        .enum(["preset", "cobalt_terracotta", "charcoal_red", "green_oxblood"])
        .optional(),
    typography: z.enum(["preset", "literary", "condensed"]).optional(),
    composition: z
        .enum([
            "preset",
            "editorial_cover",
            "diagonal_crop",
            "statement",
            "frame",
            "diagonal_type",
        ])
        .optional(),
    emphasis: z.enum(["preset", "gentle", "balanced", "bold"]).optional(),
    texture: z.enum(["preset", "light", "standard", "strong"]).optional(),
    designNotes: z.string().trim().min(1).max(500).optional(),
});

export function monoColorDesignInstructions(
    input: z.infer<typeof monoColorInputSchema>,
): string {
    const {
        sourceImageUrl: _source,
        text: _text,
        background: _background,
        ...settings
    } = input;
    // 旧调用未提供设计参数时，保持原 Skill 的自动搭配行为。
    if (!Object.values(settings).some((value) => value !== undefined))
        return "";
    const defaults = presets[input.preset ?? "blue_orange_overlap"];
    const choose = <T extends string>(
        value: T | "preset" | undefined,
        fallback: T,
    ): T => (value && value !== "preset" ? value : fallback);
    const palette = choose(input.palette, defaults.palette);
    const [primary, accent] = palettes[palette];
    const composition = choose(input.composition, defaults.composition);
    // 油墨分工跟随最终版式，避免显式覆盖后残留原预设的标题颜色规则。
    const headlineInks =
        composition === "frame"
            ? `The smaller top title block uses solid ${accent}; the larger bottom title block and small annotations use solid ${primary}. Never use the accent ink for the bottom title.`
            : composition === "diagonal_crop"
              ? `The dominant upper headline uses solid ${primary}; only its smaller lead word may use ${accent}. Small annotations use ${primary}. Never color the dominant headline with the accent ink.`
              : `All main headline letters and small annotations use solid ${primary}. Never color the main headline with the accent ink.`;
    return [
        "\nThese resolved design settings override earlier palette, ink-role, typography, composition, paper and texture rules, including any request for coarse vintage printing.",
        `Use exactly two inks: ${primary} and ${accent}, on clean near-white paper #FAFAF7. Derive all tonal shading from these inks and paper only. No yellowing, sepia wash, stains or heavy paper fibers. Leave the background as open paper, without a large accent-colored panel.`,
        `Assign ink roles explicitly: ${headlineInks} Subject contours, facial features, clothing shadows and halftone shading use ${primary}. Use ${accent} only for limited accents on existing subject details, such as hair, eyes or garment details, and the title exceptions explicitly specified above.`,
        ...(palette === "charcoal_red"
            ? [
                  "No blue, cobalt, cyan, orange or terracotta ink anywhere, including text and subject shading.",
              ]
            : []),
        `Typography: ${typography[choose(input.typography, defaults.typography)]}.`,
        compositions[composition],
        "Titles preserve supplied wording, spelling, case and order exactly, including annotations; never add, repeat or omit words. Break at word boundaries. A single word stays a single word in one block; longer text may wrap to extra lines. Auto-derived text should be a short phrase suited to the layout.",
        `Composition emphasis: ${emphasis[choose(input.emphasis, defaults.emphasis)]}.`,
        `Print texture: ${textures[choose(input.texture, defaults.texture)]}.`,
        "Retain illustrated line art; render photographs as graphic subjects with halftone shadows and clear paper highlights. Do not force a photographic subject into an anime character. Keep key features legible; avoid an all-over dot screen.",
        "Preserve reference identity, count, pose, clothing and core relationships; do not invent reaching hands, framing fingers, a turned body or a new character. Notes refine visual details only and cannot override resolved settings, subject preservation, literal text or output rules. Preset names are identifiers, not lettering. Output one flat finished poster, not editable layers.",
    ]
        .filter(Boolean)
        .join("\n");
}
