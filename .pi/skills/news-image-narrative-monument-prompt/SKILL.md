---
name: news-image-narrative-monument-prompt
description: Compile factual news into a narrative-monument editorial cover prompt.
---

# Narrative monument news cover

Compile only. Do not generate images, invoke Tools, read files, access the network or write artifacts. Return only the JSON requested by the Agent.

Treat the title and summary as the complete factual source. Preserve the event, core tension and minimum reality anchor. Do not invent identities, numbers, causes, locations or conclusions. Freeze one physical Scene Kernel instead of turning news nouns into icons.

## Visual system

- One condensed vertical person or monolithic subject on the right half.
- The posture is inward, still, bearing weight or looking back; never a victory pose.
- Express conflict through erasure, incompleteness, displacement, turning away or partial survival.
- At most one incomplete old-gold ring. No explanatory icon list.
- The left 40–50% is quiet warm ivory mineral paper and one 4–6 Chinese-character cobalt-blue title.
- The right subject uses charcoal black, ink green-gray or dark brown with charcoal, diluted ink, plaster dust, stone debris and erased edges.
- Only the exact short Chinese title is allowed. No subtitle, signature, date, logo or pseudo-text.

## Prompt contract

Compile one 300–8,000 character English prompt with these headings in order: `Use case: stylized-concept`, `Asset type: horizontal editorial main visual, composed safely for a 4:3 crop`, `NEWS RELATION:`, `ONE SCENE KERNEL:`, `COMPOSITION:`, `PHYSICAL MAKING RECIPE:`, `TEXT:`, `NEGATIVE CONSTRAINTS:`.

The recipe must lay warm ivory mineral paper, print one large cobalt-blue Chinese Song/Ming title on the left, rub one dark figure or monolithic subject into the right with dry charcoal and diluted black ink, erase edges with chalk and plaster dust, add at most one incomplete old-gold ring, then stop before digital cleanup.

The `TEXT` section must say: `Add only the exact Chinese title “<4–6 Chinese characters>” on the left. No other words or pseudo-text.`

Reject paired portraits, photorealism, cinematic poster lighting, armor, neon, portals, celebrity portraits, full brown coverage, icon lists, extra text, logos, watermarks and HUDs.

Return exactly `newsIdentity`, `coreTension`, `realityAnchor`, `factExclusions`, `sceneKernel`, and `prompt` as JSON.
