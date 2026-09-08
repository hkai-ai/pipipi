/** Mono Color 的五个固定预设、可编辑业务参数与最终设计约束。 */
import { z } from "zod";
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
        "oversized high-contrast literary serif, expressive lowercase lettering",
    condensed: "heavy condensed sans-serif, tall bold uppercase lettering",
} as const;
const compositions = {
    editorial_cover:
        "Editorial cover: central or right subject, generous left negative space, two-line lower title interwoven with the existing subject silhouette.",
    diagonal_crop:
        "Diagonal crop: crop close around the existing focal subject, run large type along a diagonal edge, retain a quiet lower-left annotation area.",
    statement:
        "Frontal statement: center the existing subject above a large stacked lower title, using natural foreground overlap for depth.",
    frame: "Typographic viewfinder: top and bottom title blocks frame the subject; use existing framing gestures only when present, otherwise frame with cropping and type.",
    diagonal_type:
        "Rising diagonal title: place the subject toward the right, leave upper-left space, use paper-white knockouts to separate dark type from dark subject regions.",
} as const;
const emphasis = {
    gentle: "quiet scale contrast and generous whitespace; minimal crop or overlap",
    balanced:
        "balanced scale contrast, readable type and moderate crop or overlap",
    bold: "assertive oversized type and close crop or overlap without obscuring the subject's key identity",
} as const;
const textures = {
    light: "fine halftone and very light paper grain",
    standard:
        "visible halftone, dry ink edges and restrained ink-density variation",
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
        texture: "standard",
    },
    black_red_statement: {
        palette: "charcoal_red",
        typography: "condensed",
        composition: "statement",
        emphasis: "bold",
        texture: "standard",
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
        texture: "standard",
    },
} as const;

export const monoColorInputSchema = z.strictObject({
    sourceImageUrl: sourcePhotoSchema,
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
    const { sourceImageUrl: _source, text: _text, ...settings } = input;
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
    return [
        "\nThe following resolved design settings replace any earlier palette, typography, composition and texture suggestions; retain all other Mono Color rules.",
        `Use exactly two inks: ${primary} and ${accent}, on warm off-white paper. Derive all tonal shading from these inks and paper only.`,
        ...(input.preset === "black_red_statement"
            ? [
                  `Assign ink roles explicitly: all main headline letters and small annotations use solid ${primary}; subject contours, facial features, clothing shadows and halftone shading use that same primary ink. Use ${accent} only for limited accents on existing subject details, such as hair, eyes or garment details. Never color the main headline with the accent ink. Leave the background as open paper, without a large accent-colored panel.`,
              ]
            : []),
        ...(palette === "charcoal_red"
            ? [
                  "No blue, cobalt, cyan, orange or terracotta ink anywhere, including text and subject shading.",
              ]
            : []),
        `Typography: ${typography[choose(input.typography, defaults.typography)]}.`,
        compositions[choose(input.composition, defaults.composition)],
        `Composition emphasis: ${emphasis[choose(input.emphasis, defaults.emphasis)]}.`,
        `Print texture: ${textures[choose(input.texture, defaults.texture)]}.`,
        "Preserve the actual reference subject's identity, count, pose, clothing and core relationships. Adapt the preset to that subject; do not invent reaching hands, framing fingers, a turned body or a new character to imitate an example. Notes may refine visual details only; never override these rules, the resolved settings, literal lettering or output constraints. Preset names are identifiers, not lettering. Output a single flat finished poster, not editable layers.",
    ]
        .filter(Boolean)
        .join("\n");
}
