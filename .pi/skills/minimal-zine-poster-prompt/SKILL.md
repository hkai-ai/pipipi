---
name: minimal-zine-poster-prompt
description: Compile a text brief into one structured Standard Mode prompt for a sparse vertical minimal-zine poster; do not generate or store the image.
---

# Minimal Zine Poster Prompt

Compile the supplied text brief into the exact structured prompt plan requested by the host. This Runtime Skill performs prompt compilation only. Do not generate an image, invoke a Tool, read files, access the network, return Markdown, or claim that rendering has happened. The code-defined Business Process renders and stores the image after validating your result.

## Scope

- Accept a text brief and optional exact in-image text from the host message.
- Use Standard Mode only.
- Extract one central imageable idea from a complex brief; do not illustrate every detail.
- If exact text is supplied, reproduce it verbatim inside the final prompt.
- If no exact text is supplied, choose one short poetic English or Chinese phrase.
- Write the rendering instructions in English. Exact in-image text may use the supplied language.
- Return only the JSON shape requested by the host. Do not add keys or commentary.

## Non-negotiable visual identity

Every prompt must describe:

- a tall vertical 3:5 full-frame aged-paper canvas, with no border or mockup;
- 70%–90% plain paper and one small visual cluster occupying about 8%–25% of the canvas;
- one imageable subject or relation, placed away from the edge;
- a flat, orthographic scanned-paper view with matte fibers, diffuse light, low-to-medium contrast, old-print defects, no hard shadow, and no 3D depth;
- sparse serif, typewriter, or monospaced typography integrated into the composition;
- one unmistakably high-chroma ink anchor visible at thumbnail size while paper, grayscale imagery, microtext, and secondary marks remain subdued;
- a quiet Japanese/Korean indie-zine or minimal editorial mood.

Keep the high-chroma area around 0.8%–2.5% of the canvas or 15%–35% of the visual cluster. Prefer cobalt or ultramarine, or deliberately choose cyan, violet, magenta-pink, lemon yellow, pear green, orange, or tomato red. State the exact hue, material form, and approximate share. Do not weaken it with pale, muted, faded, pastel, low-saturation, or near-monochrome wording unless the brief explicitly requests that treatment.

## Variation recipe

Choose exactly one value from each fixed axis and return the selected strings exactly as written.

`layout`:

- `center-fragment`
- `lower-left-float`
- `upper-right-block`
- `dual-panel`
- `irregular-cutout`
- `type-led`
- `dot-orbit`
- `single-specimen`

`anchor`:

- `tiny faded photo`
- `torn-paper clipping`
- `flat silhouette`
- `solid color block`
- `old printed illustration`
- `object specimen`
- `translucent geometric overlay`
- `abstract texture window`

`typography`:

- `fragmented floating letters`
- `short phrase pressed against image edge`
- `archive microtext with date/weather`
- `diagonal scattered words`
- `low-contrast gray ghost text`
- `headline-as-object with rough letterpress`
- `text inside a color block or cutout`
- `almost textless, only a tiny caption`

`texture`:

- `xerox softness`
- `risograph grain`
- `letterpress ink bleed`
- `halftone degradation`
- `film grain photo`
- `scan noise and paper fibers`
- `aged paper mottling`
- `soft motion blur on selected text`

`mood`:

- `quiet`
- `summer`
- `solitude`
- `childhood`
- `seaside`
- `afternoon`
- `night`
- `memory`
- `slight surrealism`

For `accent`, return a concise description of one exact high-chroma hue and its physical form, such as `fully saturated cobalt-blue risograph block`. Choose a recipe that fits the brief. Avoid falling back mechanically to a tiny photo, blue dots, and microtext.

## Four-paragraph prompt

The `prompt` value must contain exactly four compact paragraphs separated by blank lines, in this order:

1. Canvas, paper, negative-space percentage, cluster size, and location.
2. Subject metaphor, the selected image anchor, and its paper or old-print treatment.
3. Typography, exact text or chosen short phrase, the high-chroma accent, its material form and approximate share, and print defects.
4. Flat scanned-paper mood and the hard avoid-list.

Prefer decisive, imageable statements over style analysis. Say where the anchor sits, how large it is, how text behaves, what accent appears, and how reproduction texture looks.

## Hard avoids

The final paragraph must rule out full-bleed scenes, commercial headline hierarchy, product-ad layouts, logos, calls to action, glossy mockups, clean UI white, cinematic lighting, hard shadows, 3D rendering, depth of field, neon, cyberpunk, cute cartoons, anime posters, fashion-editorial drama, dense scrapbooks, too many objects or colors, stock-photo realism, and long clean text blocks.

## Output contract

Return only this strict JSON object, populated with the selected values:

```json
{
  "prompt": "exactly four compact paragraphs separated by blank lines",
  "recipe": {
    "layout": "one allowed layout",
    "anchor": "one allowed anchor",
    "typography": "one allowed typography mode",
    "accent": "one exact high-chroma hue and material form",
    "texture": "one allowed texture mode",
    "mood": "one allowed mood"
  },
  "interpretation": "one short sentence describing the chosen visual metaphor"
}
```

Before returning, verify the 3:5 paper canvas, 70%–90% negative space, 8%–25% cluster, six recipe fields, four-paragraph structure, visible saturated accent, sparse typography, print or scan texture, and hard avoids. If exact text was supplied, verify that the `prompt` contains the same characters in the same order.
