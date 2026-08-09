# Source provenance

- Runtime Skill: `minimal-zine-poster-prompt`
- Upstream repository: `https://github.com/LiamGvchi/gc-minimal-zine-poster`
- Upstream Skill path: `SKILL.md`
- Upstream callable name: `gc-minimal-zine-poster-v0-1`
- Immutable source identity: SHA-256 `d4e1199623ee4d98e948189308eedc601f83ab0ae923568c6e9240f89c783b8b`
- Local lock record: `skills-lock.json`
- Reviewed on: `2026-08-09`
- License: MIT; see `LICENSE`

## Review inventory

The source contains one `SKILL.md`, three README translations, an MIT license, a `.gitignore`, and six example JPEG images. It contains no scripts, references required at runtime, MCP configuration, or declared external Tools. The JPEG files are illustrative outputs and are not needed by the Runtime prompt compiler, so they are excluded from the production snapshot.

## Adaptations

The upstream Development Skill both compiles a prompt and invokes built-in image generation. This Runtime snapshot keeps the Standard Mode prompt compiler, visual rules, variation axes, output checks, and attribution, but narrows its authority and output:

- it compiles text briefs only; reference-image input is not part of `minimal-zine-poster/v1`;
- it returns strict JSON instead of Markdown;
- it cannot generate images, call Tools, read files, or access the network;
- image rendering and storage belong to the code-bound Poster Rendering Capability;
- image inspection, cross-run variation memory, and automatic regeneration are omitted because the request-local Agent receives neither pixels nor prior runs.

Rollback restores the previous application artifact, whose production catalog did not register `minimal-zine-poster/v1`, and removes this bundled Runtime Skill with that artifact. Updating the source requires a new hash, a fresh review, deterministic tests, and a new application release.
