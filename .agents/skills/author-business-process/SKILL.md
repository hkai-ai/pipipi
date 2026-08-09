---
name: author-business-process
description: Turn a natural-language workflow brief into a versioned, code-defined Business Process in this repository. Use when the user asks to add, package, implement, or revise a business workflow, Process Definition, Process Registration, process version, or production catalog entry, even when the brief is incomplete or uses the word workflow instead of Business Process.
---

# Author Business Process

Convert the user's business intent into the smallest stable product Interface, then implement it behind the repository's existing Process Registration Seam. Treat a short natural-language brief as valid input and make safe, visible assumptions.

## Establish Context

1. Find the repository root and read `CONTEXT.md`.
2. Read `docs/authoring-business-processes.md`, `docs/development.md`, and the relevant sections of `docs/process-runtime-design.md`.
3. Inspect the current registrations, production catalog, adjacent tests, and documentation before choosing a shape.
4. Use the repository's Business Process vocabulary. Map the user's word “workflow” to Business Process unless they clearly mean a development automation.

## Turn the Brief into a Contract

Extract or infer:

- the business goal and caller;
- input and output Schema;
- success semantics and stable public errors;
- external dependencies and irreversible side effects;
- timeout, cancellation, data sensitivity, and acceptance examples;
- whether the change is a new Process, a new version, or an Implementation-only change.

Infer safe defaults from current code and record them in the handoff. Ask the user only when different answers would materially change the public contract, authority, cost, or irreversible effects. Do not require the user to write a technical design.

Use a new exact version for incompatible public behavior. Never add `latest`, a default version, automatic discovery, or version fallback.

## Design the Module Boundary

Keep Schema, Process Definition, authorized dependencies, and stable policy local to one Registration factory. Prefer deepening an existing Module. Add a new Seam only when two real Adapters or a confirmed replacement need justify it.

Process Definition code depends on narrow Business Capability Interfaces. Keep provider SDKs, protocols, credentials, retries, and remote errors inside Adapters. Execution Context contains request-level runtime metadata, not a capability bag.

If the brief includes a local or remote Skill source, load and follow `$integrate-runtime-skill` first. Bind only its reviewed local Runtime snapshot; never add the source locator to the product request.

## Implement

1. Add or update a `create…Registration` factory with fixed identity, input Schema, output Schema, and Process Definition.
2. Inject only authorized dependencies and stable policy through the factory.
3. Return expected Agent or dependency failures with `failProcess`; let unexpected exceptions reach Process Runner for safe conversion.
4. Add the Registration to `createBusinessProcessExecutor`'s explicit production catalog.
5. Keep the HTTP caller unaware of internal Agent, Skill, Tool, and Adapter choices.

Preserve unrelated user changes. Do not create a JSON workflow language, runtime registration API, generic capability bag, or request-controlled execution path.

## Verify and Document

Test through public Seams:

- Registration authoring invariants and strict Schema behavior;
- authorized Capability and Tool calls;
- success, expected failure, unexpected failure, timeout, and cancellation;
- a real local `POST /execute` path for product behavior;
- exact catalog lookup for the new `(id, version)`.

Run `npm run typecheck`, `npm test`, and `npm run build`. Keep real model, network, storage, or paid checks in explicit smoke commands and state why they were or were not run.

Update `README.md`, `CONTEXT.md`, `docs/development.md`, relevant design docs, and release docs when their stated facts change. Report the chosen contract, assumptions, tests, and any production work still required.
