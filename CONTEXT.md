# Business Processing

This context defines versioned business processing behavior that product callers can execute without selecting its implementation mechanism.

## Language

**Business Process**:
A versioned business use case exposed to product callers.
_Avoid_: Workflow, pipeline

**Process Definition**:
The code-owned expression of one Business Process version's business behavior and contracts.
_Avoid_: Workflow definition, process configuration

**Process Registration**:
A validated, executable registration of one Business Process version. It associates that version with its Process Definition, authorized dependencies, and server-owned policy.
_Avoid_: Registry entry, raw Process Definition

**Process Registry**:
The immutable catalog of accepted Process Registrations, addressed by Business Process identifier and version. It resolves exact versions and never chooses a default or fallback.
_Avoid_: Process map, process list

**Process Runner**:
The runtime that governs one execution of a resolved Process Registration. It applies shared execution rules without knowing a Business Process's policy or dependency shape.
_Avoid_: Workflow engine, Process Registry

**Execution Context**:
The request-scoped execution metadata supplied by the Process Runner after a Process Registration accepts input. Authorized dependencies and stable policy belong to the Process Registration instead.
_Avoid_: Global capability bag, dependency bag
