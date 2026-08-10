# Source provenance

- Runtime Skill: `tait-crt-interface-prompt`
- Upstream repository: `https://github.com/TaiT-tt/tait-crt-interface-skill`
- Upstream Skill path: `SKILL.md`
- Upstream callable name: `tait-crt-interface-skill`
- Resolved commit: `972a99bc85f725537bddadae6a6cea53516470f2`
- Resolved tree: `5c28e91993e5dba7a08bed44b67131dc7de14145`
- Upstream `SKILL.md` SHA-256: `b3f9bbab118e839a5ae7e79f3406e8bebd3383e3f3ad18c8ed91b9efa30c04a9`
- Upstream palette registry SHA-256: `f43f9256acf846a9c0334a8b9d6d499b8698156857adc24ab7fe9bcd1e6205ac`
- Upstream requirements ledger SHA-256: `dba22bf4426077c187849fe79754b10280e90e21f6fa2b968dba089b190c3885`
- Upstream finalizer SHA-256: `a067504467d6ff8b8fc48716192a9326d915082884a4d82064f80d84a9cba8d0`
- Local lock record: `skills-lock.json`
- Reviewed on: `2026-08-10`
- License: not declared (`NOASSERTION`). The resolved Git tree contains no `LICENSE`, `COPYING`, or SPDX declaration. A release owner must confirm redistribution and production-use rights before publishing this snapshot outside an authorized environment.

## Review inventory

The resolved source contains `SKILL.md`, two required reference files, one Python finalizer, Codex UI metadata, a bilingual README, two interaction assets, ten source examples, and ten generated examples. The required color card and representative output were inspected. Example images are illustrative and are excluded from the application artifact.

The Python finalizer imports only the standard library and Pillow. It reads one local raster, quantizes it to a supplied two-to-five-color palette, applies a same-resolution grid and edge warp, adds scanlines and the locked signature, creates the destination directory, and writes a new PNG. It has no network access, Secret reads, command execution, deletion, or broad filesystem writes. It rejects an existing output path and refuses to overwrite the input. The current production Agent cannot run scripts or load Pillow, so the script is not installed as Runtime authority; an owned image Capability must implement and test the equivalent finalization contract.

## Adaptations

The upstream Skill is a high-authority interactive Codex image-generation workflow. This Runtime snapshot narrows it to one server-owned prompt compiler:

- palette and aspect ratio are required Business Process fields, so the two-turn Codex intake and bundled color-card interaction are removed;
- the Agent never receives the uploaded image or asset identifier; the downstream image editor performs subject recognition against the source image resolved by the owned Capability;
- the palette registry, subject-roster rules, abstraction blueprint, variation axes, four-part prompt shape, shared lattice, CRT surface, signature, and quality constraints are retained in one loadable `SKILL.md`;
- the Agent returns strict JSON to the Registration and cannot call Tools, generate images, run the Python finalizer, inspect outputs, retry, read files, or access the network;
- GPT Image 2 editing, source-asset resolution, same-resolution finalization, validation, persistence, and URL lifecycle belong to the narrow CRT Rendering Capability;
- example rasters, the color-card asset, UI metadata, references, and script are excluded because the production Runtime loads one `SKILL.md` and has no need for interactive assets or executable code.

Rollback restores the previous application artifact, whose production catalog did not register `crt-interface-image/v1`, and removes this bundled Runtime Skill with that artifact. Updating the source requires a new immutable commit and hashes, a fresh security and license review, deterministic tests, an explicit GPT Image smoke, and a new application release.
