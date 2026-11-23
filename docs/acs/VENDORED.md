# Vendored upstream notices

This directory contains copies of JSON Schema documents and data files from
third-party open-source projects. The originals remain under their own
licences and copyright. The copies here are unmodified except where a file
is explicitly noted as an adaptation.

AWARE is licensed Apache-2.0 (see `/LICENSE`). The vendored material below is
MIT-licensed, which is compatible with Apache-2.0.

---

## 1. Agent Control Specification (ACS)

- **Project**: https://github.com/responsibleai/agent-control-spec
- **Licence**: MIT (see `/LICENSE.acs` for the full upstream licence text)
- **Copyright**: Copyright (c) Microsoft Corporation
- **Release tag**: `v0.4.0-beta.2`
- **Commit**: `b11ae38b1bd53d299789c1724f4f94f80a0c6540`
- **Tree**: `51781ee9be8a56eb86cf304448facf80076ca9be`

### Files vendored from ACS

All files below are byte-identical copies taken from the pinned commit.

| File in this directory | Upstream path | SHA-256 |
| --- | --- | --- |
| `manifest.schema.json` | `spec/schema/manifest.schema.json` | `6a897f5930d500b470ba30369f530bdccd378aac080d8505d1ac4aca2007c570` |
| `policy-input.schema.json` | `spec/schema/wire/policy-input.schema.json` | `e0ee81de0f3f9fc2a98e3ef52966d888cc49c4eabe136cfe29b64bd71da38e38` |
| `verdict.schema.json` | `spec/schema/wire/verdict.schema.json` | `57971b0178826bcb15e8e58d0c70f5137053e7420d37ef99c1ddf3623ffdefe8` |
| `result.schema.json` | `spec/schema/wire/result.schema.json` | `9c7ba788ab8d2788bed5cfb805700db1446b717639fc6b858688efde4094fd72` |
| `request.schema.json` | `spec/schema/wire/request.schema.json` | `bbbfe0893f11cd197133f9bd53602cdd4b702b19777de7fd1d99d4ae5c37c190` |
| `snapshot.schema.json` | `spec/schema/wire/snapshot.schema.json` | `4bb8dff18b67e3d10c8340e68548dbfea69a3dc6e96e8f1fcb869a16560b37b8` |
| `approval.schema.json` | `spec/schema/approval.schema.json` | `780e4dd570b405f95a565a7080d0018808a26a698dbf76cd4988ac956b04ab43` |
| `reserved-reasons.json` | `spec/reserved-reasons.json` | `d54b1de88c0d32bbc18244c10d1525ba4d7862f09ca522c0436fd81f91c66cdb` |

A drift test (`test/unit/acs/schema-drift.test.js`) recomputes each SHA-256
above and fails if a vendored copy differs from the pinned value. The values
are recorded in `/docs/acs/VERSION`.

### Modified files

None. The vendored copies are unmodified.

---

## 2. Agent Hooks

- **Project**: https://github.com/responsibleai/agent-hooks
- **Licence**: MIT (see `/LICENSE.acs` for the full upstream licence text)
- **Copyright**: Copyright (c) Microsoft Corporation
- **Commit**: `7e13a74b34af30f2049d902cc656c247c81d2f95` (2026-11-20)

### Files vendored from Agent Hooks

| File in this directory | Upstream path | SHA-256 |
| --- | --- | --- |
| `interception-record.schema.json` | `spec/draft/schema/generated/interception-record.schema.json` | `82a08006a2e9b4b85277435c40c9a81d878c0456f8259b7a137ead7cadeaf3e5` |

This schema is the ACS **receipt** schema. The ACS specification defines the
receipt by reference to AGENT-HOOKS-0.1 section 10.3 rather than shipping its
own copy, so the receipt schema is vendored from the Agent Hooks project.

### Modified files

None. The vendored copy is unmodified.

---

## 3. Agent Governance Toolkit (AGT)

- **Project**: https://github.com/microsoft/agent-governance-toolkit
- **Licence**: MIT (see `/LICENSE.acs` for the full upstream licence text)
- **Copyright**: Copyright (c) Microsoft Corporation
- **Commit**: `f85abe1fffc5aaeed716a94bd6654677329215b9` (2026-11-18)

### Files vendored from AGT

None. AGT is consulted as a **reference implementation only**. No AGT source
file is copied into this repository. The AWARE host adapter in
`src/acs/host-adapter.js` is an independent implementation written against
the ACS specification text and the pinned schemas.

The AGT `examples/acs-email-tool` example is reproduced as an AWARE
conformance fixture under `test/unit/acs/fixtures/`, with the policy logic
rewritten in AWARE's own terms. The upstream example is MIT-licensed and its
notice is reproduced in `test/unit/acs/fixtures/README.md`.

---

## 4. Licence compatibility note

MIT is one of the licences Apache-2.0 is explicitly compatible with. The
vendored material above may be redistributed inside an Apache-2.0 project
provided the MIT notice and this notice are both retained, which they are:
`/docs/acs/LICENSE.acs` carries the MIT text and this file records the
provenance of every vendored file.

No vendored file is modified. If a future revision modifies one, that file
must be listed under a "Modified files" heading with the nature of the
change stated, per the terms of the MIT licence.
