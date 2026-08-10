---
name: tait-crt-interface-prompt
description: Compile one fixed-palette, fixed-ratio reference-image transformation prompt for a TaiT CRT computer-interface illustration; do not inspect, generate, finalize, or store images.
---

# TaiT CRT Interface Prompt

Compile the palette and aspect ratio supplied by the host into one structured prompt plan. This Runtime Skill performs prompt compilation only. Do not inspect an image, invoke a Tool, read files, access the network, run a script, generate or store an image, or claim that rendering has happened. The code-defined Business Process validates your plan, and the authorized CRT Rendering Capability resolves the uploaded source image, calls the image model, finalizes the raster, and stores it.

## Scope

- The host message always supplies one valid palette name and one supported aspect ratio.
- The source image is intentionally absent from the Agent session. Instruct the downstream image editor to recognize and anchor the subjects in its attached source image.
- Use one Standard Mode and select one value from every recipe axis.
- Return only the strict JSON object requested by the host. Do not add keys, Markdown, analysis, or commentary.
- Never put a source image ID, Skill name, model name, provider, storage location, or hidden implementation detail in the prompt.

## Palette registry

Use the exact colors for a named palette:

| Name | Colors |
| --- | --- |
| `经典` | `#dee4e0`, `#2e382d` |
| `粉黛` | `#f2d1d7`, `#7a3f43` |
| `极客01` | `#f2fcf6`, `#485446`, `#111e16`, `#13f81f` |
| `极客02` | `#e8e5df`, `#2ca770`, `#0d3d2d`, `#3e6a9e` |
| `复古01` | `#efca54`, `#5d9f58`, `#e870a1`, `#bbb8a5`, `#49473c` |
| `复古02` | `#e5e2be`, `#ef8a45`, `#317e50`, `#8e6442`, `#35342f` |
| `游戏01` | `#22e6da`, `#fabf37`, `#e90cbe`, `#2a4ac5`, `#1d2c6b` |
| `游戏02` | `#e7f5fe`, `#7bd699`, `#3bc4c4`, `#c97979`, `#29383a` |

For `如图`, tell the renderer to derive one coherent two-to-five-color palette from the source image. It must keep a clear light/dark pair, consolidate near-duplicates, and use no other colors. For every palette, use only its lightest and darkest colors as the endpoints of a regular 50% checkerboard midtone.

## Subject abstraction

The first prompt paragraph must direct the image editor to perform these steps against its attached source image:

- Identify every visually prominent or interacting person, creature, or object. Preserve each intended subject once, with its left/right/front/back order, relative scale, interaction, contact, occlusion, and held objects. Never omit, duplicate, merge, swap, or hybridize subjects.
- Retain only three-to-five high-information identity anchors per subject. Rebuild from the short semantic anchors instead of tracing, masking, contour-matching, or auto-pixelating the source.
- Exaggerate two or three traits and change at least three structural relationships, such as head/body ratio, facial spacing, limb thickness, pose angle, silhouette rhythm, object scale, or accessory size.
- Build one opinionated circa-1980s terminal cartoon from five-to-nine flat interlocking masses. Keep hands attached to the correct arms with plausible wrists, palms, contact, and either valid finger groups or an intentional mitten silhouette.
- Draw exactly one borderless wallpaper composition behind the windows. Its silhouette covers the selected 60%, 70%, or 80% of the frame and never falls below 50%. Preserve 20%-30% connected open field.

## Interface and pixel construction

The second and third prompt paragraphs must require:

- three-to-six foreground windows with clear large/medium/small hierarchy, staggered 5%-20% overlap, balanced multi-quadrant placement, one full-width menu, one open French drop-down, and exactly one cursor;
- one-to-three feature-extraction windows that show distinct partial details rather than a second full subject; multiple extractions must differ in feature, size, and aspect ratio;
- the exact lowercase signature `tait-crt-interface-skill` in the upper-right title bar, unobscured and rendered in the same bitmap grid as the interface;
- one square global content cell, about the short edge divided by 384, shared by subject, windows, borders, glyphs, icons, cursor, charts, accents, and checkerboard;
- hard integer-aligned stair steps with no half, stretched, rotated, shifted, isolated, antialiased, blurred, or smooth-transition cells;
- flat palette planes and a broad darkest/lightest checkerboard covering roughly 15%-35% of the visible subject.

## CRT surface

The fourth prompt paragraph must require dense palette-bound scanlines, sparse noise, hard-cell bloom, one-cell misregistration, short vertical persistence, one restrained sync disturbance, and unmistakable radial barrel curvature in the outer 10% of all four sides. Corners compress more than edge centers, long top and side lines visibly bow, and the inner 80% stays stable. Show no physical monitor, bezel, room, modern cards, glassmorphism, vector smoothness, gradients, alpha, 3D, game HUD, other logos, calls to action, or long text.

## Variation recipe

Choose exactly one allowed value for every field:

- `wallpaperPlacement`: `left-wall`, `right-wall`, `upper-crop`, `lower-rise`, `diagonal-left`, `diagonal-right`
- `crop`: `head-hands`, `head-shoulders`, `waist-up`, `compact-full`, `profile-mass`, `object-spread`
- `subjectCoverage`: `60`, `70`, `80`
- `windowCount`: `3`, `4`, `5`, `6`
- `windowConstellation`: `counter-corners`, `asymmetric-L`, `zigzag-cascade`, `sparse-orbit`, `split-diagnostic`, `corner-burst`, `underlay-cross`
- `sizeHierarchy`: `1L+1M+1S`, `1L+2M+1S`, `1L+1M+3S`, `1L+2M+3S`
- `dominantApplication`: `terminal`, `files`, `table`, `chart`, `warning`, `settings`
- `extractionCount`: `1`, `2`, `3`
- `extractionGeometry`: `square+wide`, `tall+square`, `wide+tall`, `square+wide+tall`
- `cartoonTreatment`: `block-caricature`, `terminal-mascot`, `symbolic-cutout`, `minimalist-geometric-pop-art`
- `caricatureMutation`: `oversized-feature+compressed-body`, `facial-spacing+silhouette-skew`, `blocky-limbs+awkward-pose`, `amplified-accessory+object-scale`, `mascot-collapse+comic-ugliness`
- `midtoneMap`: `face-side+garment`, `hair-underplane+limb`, `torso+hands`, `back-plane+accessory`, `distributed-large-planes`
- `polarity`: `light-field`, `dark-field`, `split-local-fields`
- `signalEmphasis`: `persistence`, `row-jitter`, `sync-band`, `edge-noise`, `pixel-misregistration`

Keep the recipe internally compatible. Use 80% subject coverage with three or four windows. Use six windows only with 60%-70% coverage. One extraction permits three-to-six total windows, two require four-to-six, and three require five or six. Match `extractionGeometry` to the extraction count: use two named shapes for one or two extractions, and `square+wide+tall` for three.

## Four-paragraph prompt

The `prompt` must contain exactly four compact English paragraphs separated by blank lines, in this order:

1. Selected ratio; downstream source-image roster recognition; identity anchors; semantic source severance; caricature mutations; five-to-nine-mass cartoon; hand topology; one wallpaper composition; selected crop, placement, and coverage.
2. Selected window count, constellation, hierarchy, overlap, feature extractions, French menu and labels, one cursor, connected open field, and reserved exact signature.
3. Exact named palette colors or the `如图` derivation rule; selected polarity and midtone map; darkest/lightest checkerboard; one shared content lattice.
4. CRT signal surface, mandatory outer-edge barrel warp, industrial mood, and hard avoids.

Use decisive geometry and measurable shares. The prompt must tell the editor to transform the attached source image, not merely describe a new unrelated scene. Never expose the prompt to the product caller; only return it to the host in the required JSON.

## Output contract

Return only this strict JSON object:

```json
{
  "prompt": "exactly four compact paragraphs separated by blank lines",
  "recipe": {
    "wallpaperPlacement": "one allowed value",
    "crop": "one allowed value",
    "subjectCoverage": 70,
    "windowCount": 4,
    "windowConstellation": "one allowed value",
    "sizeHierarchy": "one allowed value",
    "dominantApplication": "one allowed value",
    "extractionCount": 2,
    "extractionGeometry": "one allowed value",
    "cartoonTreatment": "one allowed value",
    "caricatureMutation": "one allowed value",
    "midtoneMap": "one allowed value",
    "polarity": "one allowed value",
    "signalEmphasis": "one allowed value"
  }
}
```

Before returning, verify the supplied ratio and palette, four-paragraph structure, one complete source-image roster, one 50%-80% wallpaper composition, 20%-30% open field, compatible window and extraction counts, one shared grid, checkerboard midtone, CRT edge warp, one cursor, French drop-down, exact signature, and hard avoids.
