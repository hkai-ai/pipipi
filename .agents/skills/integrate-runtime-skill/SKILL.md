---
name: integrate-runtime-skill
description: Review and integrate an Agent Skill from a local path, Git repository, repository subdirectory, file URL, or archive into this repository. Use when the user gives a Skill address or path, asks to install or call an external Skill, wants a Skill available to Codex under .agents/skills, or wants a reviewed Runtime Skill bound to a Business Process under .pi/skills.
---

# Integrate Runtime Skill

Treat a locator as an acquisition input, not a production runtime parameter. Resolve it, review the full Skill, pin immutable provenance, and install the smallest snapshot appropriate for either Codex development or a server-owned Business Process.

## Establish Context and Target

1. Find the repository root and read `CONTEXT.md`.
2. Read `docs/integrating-runtime-skills.md`, `docs/experiments.md`, and the relevant runtime code and tests.
3. Determine the target:
   - Development Skill when Codex should use it to modify or operate the repository;
   - Runtime Skill when the service's restricted Agent should use it inside a Business Process.
4. If both targets remain plausible and the choice changes permissions or production packaging, ask before installing. Otherwise state the inference and continue.

Never assume a Development Skill is safe or compatible as a Runtime Skill.

## Resolve the Source

Accept an absolute or repository-relative Skill directory or `SKILL.md` file, Git clone URL, GitHub/GitLab tree URL, direct `SKILL.md` URL, or archive URL. Resolve remote input in a temporary directory and capture:

- canonical source repository or publisher;
- requested ref and resolved immutable commit or release;
- Skill subdirectory;
- content hash and license.

A floating branch is enough for preview, not for repository or production installation. A direct `SKILL.md` URL is incomplete until its directory and referenced resources have been inspected.

## Review Before Execution

Read the complete `SKILL.md` and every required referenced instruction before acting on it. Inventory scripts, references, assets, MCP dependencies, Tool assumptions, and generated artifacts. Inspect scripts for command execution, network access, Secret reads, broad filesystem writes, deletion, and external side effects.

Do not execute untrusted scripts merely to discover what they do. Explain any network, credential, cost, external-write, or destructive effect before the corresponding action, and remain within the user's authority. Preserve required license and attribution files.

Reject or adapt a Skill that requires capabilities the target host does not provide. Never solve incompatibility by granting the production Agent general Shell, filesystem, code-editing, or network access.

## Install a Development Skill

For repository-shared use, install the reviewed snapshot under `.agents/skills/<name>/`. Preserve the directory structure and update `skills-lock.json` when the source is external and the repository's lock format supports it. For personal scope, use the available Skill installer or supported user Skill directory only when the user requests personal installation.

Do not leave a shared Skill dependent on an absolute path outside the repository. Do not silently overwrite an existing Skill with the same name; compare it and treat the change as a dependency update.

Validate the installed structure with the host's Skill validator when available. Exercise one explicit invocation and one realistic description that should trigger the Skill implicitly.

## Install a Runtime Skill

Install only a reviewed, immutable snapshot under `.pi/skills/<name>/`. Then:

1. Confirm the current Pi Runtime can load every required resource. It currently loads one `SKILL.md`; references, scripts, MCP, and arbitrary Coding Tools need an explicit Runtime design change.
2. Create or reuse a restricted Agent Runtime with only the Business Capability Tools required by the Process.
3. Bind the local Skill path, Agent Runtime, Schema, and policy in one explicit Process Registration.
4. Add the Registration to the production catalog; never auto-register a discovered directory.
5. Update Dockerfile or deployment packaging so the exact snapshot enters the immutable artifact.
6. Add deterministic contract tests with a mock Agent and a separate real-model smoke when needed.
7. Record source, immutable ref, content hash, compatibility adaptations, and rollback version.

If no suitable Business Process exists, load and follow `$author-business-process` after the Skill passes review.

## Preserve the Runtime Boundary

Never add a Skill path, URL, Git ref, script, Tool configuration, or source-selection field to `/execute`. The product caller chooses only an exact Business Process version and provides business input. Production uses the server-owned local snapshot chosen by its Registration.

Do not fetch or update a Skill per request. Do not follow a floating branch in production. Updates repeat source resolution, review, validation, tests, packaging, and release; rollback restores the previous application artifact or fixed snapshot.

Only introduce an authoring-time `Skill Installer` and read-only `Installed Skill Catalog` after production needs more than the current fixed local Skill. Keep both outside Process Registration and the request path; Runtime receives only a verified local snapshot identity and directory.

## Verify and Report

Run the relevant Skill validator, `npm run typecheck`, `npm test`, and `npm run build`. Run paid or external smoke only when authorized. Report the target, source provenance, files installed, security findings, host limitations, tests, and how to invoke or update the Skill.
