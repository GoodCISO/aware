# AWARE compliance matrix

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: node scripts/generate-compliance-matrix.js -->

This document is the human-readable expansion of the crosswalk held in `src/compliance/framework-mapper.js`. That module is the source of truth: the tables below are generated from it, so they cannot drift from the code.

AWARE maps **9** compliance frameworks across **14** AWARE components.

## Frameworks

| ID | Name | Version | Controls |
|---|---|---|---|
| `BOE_PRA_FCA_AI_CYBER` | PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | v1.0-2026-11-21 (UNVERIFIED) | 12 |
| `CSA_AI_CM` | CSA AI Controls Matrix | v1 | 18 |
| `DORA` | Digital Operational Resilience Act | 2022 | 3 |
| `ISO_27001` | ISO/IEC 27001:2022 | 2022 | 3 |
| `ISO_42001` | ISO/IEC 42001:2023 — AI Management System | v1.0-2026-07-28 | 38 |
| `NIST_AI_RMF` | NIST AI Risk Management Framework | 1.0 | 12 |
| `OWASP_AST10` | OWASP Agentic Skills Top 10 | v1.0-2026 | 10 |
| `OWASP_LLM_TOP_10` | OWASP Top 10 for Large Language Model Applications | 2025 | 10 |
| `OWASP_MCP_TOP_10` | OWASP Top 10 for Model Context Protocol | 2025 | 10 |

## Per-component crosswalk

Each table lists the control IDs a component maps to, per framework. A component with no mapping for a framework has no entry in that framework's column.

### `agent-registry`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `2.3`, `4.2`, `9.1` |
| CSA AI Controls Matrix | `IAM-01`, `GRC-02` |
| Digital Operational Resilience Act | `Art.12` |
| ISO/IEC 27001:2022 | `A.9.2`, `A.9.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.3.2`, `A.4.2`, `A.4.3`, `A.4.5`, `A.6.2.2`, `A.6.2.5`, `A.7.2`, `A.9.4`, `A.10.2` |
| NIST AI Risk Management Framework | `PR.AC`, `DE.CM` |
| OWASP Agentic Skills Top 10 | `AST02` |
| OWASP Top 10 for Large Language Model Applications | `LLM03`, `LLM02` |

### `anomaly-detection`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `8.2`, `10.2`, `10.4` |
| CSA AI Controls Matrix | `LOG-05`, `MDS-09`, `SEF-06` |
| Digital Operational Resilience Act | `Art.26`, `Art.27` |
| ISO/IEC 27001:2022 | `A.12.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.3.3`, `A.6.2.4`, `A.6.2.6`, `A.6.2.8`, `A.8.4` |
| NIST AI Risk Management Framework | `DE.CM`, `DE.AE`, `RS.MA` |
| OWASP Agentic Skills Top 10 | `AST01`, `AST05`, `AST08`, `AST09` |
| OWASP Top 10 for Large Language Model Applications | `LLM01`, `LLM04`, `LLM02`, `LLM09`, `LLM02` |
| OWASP Top 10 for Model Context Protocol | `MCP03`, `MCP06` |

### `behavioral-baseline`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `11.1` |
| CSA AI Controls Matrix | `LOG-03`, `MDS-05` |
| Digital Operational Resilience Act | `Art.26`, `Art.27` |
| ISO/IEC 27001:2022 | `A.12.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.6.2.4`, `A.9.4` |
| NIST AI Risk Management Framework | `DE.CM`, `RS.MA` |
| OWASP Agentic Skills Top 10 | `AST05` |
| OWASP Top 10 for Large Language Model Applications | `LLM04`, `LLM09` |

### `compliance-mapping`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `2.3`, `4.2`, `8.2`, `8.5`, `10.4`, `10.5`, `11.1` |
| CSA AI Controls Matrix | `GRC-04`, `A&A-05` |
| Digital Operational Resilience Act | `Art.12`, `Art.26` |
| ISO/IEC 27001:2022 | `A.12.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.2.2`, `A.2.3`, `A.2.4`, `A.6.1.2`, `A.6.2.3`, `A.6.2.7`, `A.6.2.8`, `A.7.5`, `A.8.2`, `A.8.3`, `A.8.5`, `A.9.3`, `A.10.4` |
| NIST AI Risk Management Framework | `GV.PO`, `GV.RM` |
| OWASP Agentic Skills Top 10 | `AST09` |
| OWASP Top 10 for Large Language Model Applications | `LLM09` |
| OWASP Top 10 for Model Context Protocol | `MCP08`, `MCP09` |

### `credential-classifier`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `4.4`, `7.5` |
| ISO/IEC 42001:2023 — AI Management System | `A.7.4` |
| OWASP Top 10 for Model Context Protocol | `MCP01` |

### `identity-provider`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `9.1` |
| CSA AI Controls Matrix | `IAM-04`, `IAM-09`, `CEK-21` |
| Digital Operational Resilience Act | `Art.12` |
| ISO/IEC 27001:2022 | `A.9.2`, `A.9.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.3.2`, `A.10.3` |
| NIST AI Risk Management Framework | `PR.AC`, `PR.AA` |
| OWASP Agentic Skills Top 10 | `AST01`, `AST02` |
| OWASP Top 10 for Large Language Model Applications | `LLM03`, `LLM02`, `LLM02`, `LLM02` |
| OWASP Top 10 for Model Context Protocol | `MCP01`, `MCP04`, `MCP07` |

### `kill-switch`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `8.5`, `9.1`, `10.2` |
| CSA AI Controls Matrix | `SEF-03`, `LOG-13` |
| Digital Operational Resilience Act | `Art.26` |
| ISO/IEC 27001:2022 | `A.16.1` |
| ISO/IEC 42001:2023 — AI Management System | `A.6.2.6`, `A.8.4` |
| NIST AI Risk Management Framework | `RS.MI`, `RS.RP` |
| OWASP Agentic Skills Top 10 | `AST06` |
| OWASP Top 10 for Large Language Model Applications | `LLM10`, `LLM06` |

### `permission-model`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `6.6` |
| OWASP Top 10 for Model Context Protocol | `MCP02`, `MCP07` |

### `pheromone-specialists`

| Framework | Control IDs |
|---|---|
| CSA AI Controls Matrix | `TVM-08`, `MDS-08` |
| Digital Operational Resilience Act | `Art.12` |
| ISO/IEC 27001:2022 | `A.12.1` |
| NIST AI Risk Management Framework | `PR.IP` |
| OWASP Top 10 for Large Language Model Applications | `LLM09` |

### `sandbox-policies`

| Framework | Control IDs |
|---|---|
| CSA AI Controls Matrix | `AIS-08`, `DSP-17`, `UEM-13` |
| Digital Operational Resilience Act | `Art.12` |
| ISO/IEC 27001:2022 | `A.12.1`, `A.12.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.6.1.3` |
| NIST AI Risk Management Framework | `PR.IP`, `DE.AE` |
| OWASP Agentic Skills Top 10 | `AST06` |
| OWASP Top 10 for Large Language Model Applications | `LLM10`, `LLM05`, `LLM06` |
| OWASP Top 10 for Model Context Protocol | `MCP05` |

### `security-heuristic`

| Framework | Control IDs |
|---|---|
| CSA AI Controls Matrix | `TVM-01`, `GRC-09` |
| Digital Operational Resilience Act | `Art.12` |
| ISO/IEC 27001:2022 | `A.12.1` |
| ISO/IEC 42001:2023 — AI Management System | `A.6.2.2`, `A.6.2.4` |
| NIST AI Risk Management Framework | `RA-1`, `RA-3` |
| OWASP Agentic Skills Top 10 | `AST08` |
| OWASP Top 10 for Large Language Model Applications | `LLM01`, `LLM05` |

### `shadow-detector`

| Framework | Control IDs |
|---|---|
| OWASP Top 10 for Model Context Protocol | `MCP09` |

### `tool-access-control`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `6.6` |
| CSA AI Controls Matrix | `IAM-08`, `DSP-05`, `AIS-07` |
| Digital Operational Resilience Act | `Art.12` |
| ISO/IEC 27001:2022 | `A.9.4` |
| ISO/IEC 42001:2023 — AI Management System | `A.6.1.3`, `A.7.3`, `A.9.2` |
| NIST AI Risk Management Framework | `PR.AC`, `PR.IP` |
| OWASP Agentic Skills Top 10 | `AST01`, `AST03`, `AST04`, `AST07` |
| OWASP Top 10 for Large Language Model Applications | `LLM01`, `LLM05`, `LLM10`, `LLM03`, `LLM03`, `LLM06` |
| OWASP Top 10 for Model Context Protocol | `MCP02`, `MCP03`, `MCP05`, `MCP07` |

### `tool-observation-proxy`

| Framework | Control IDs |
|---|---|
| PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI | `4.4`, `7.5` |
| ISO/IEC 42001:2023 — AI Management System | `A.3.3`, `A.4.3`, `A.6.2.6` |
| OWASP Top 10 for Model Context Protocol | `MCP03`, `MCP06`, `MCP08`, `MCP10` |

## See also

- `src/compliance/framework-mapper.js` — the source of truth for this table.
- [`docs/compliance/aicm-v1.md`](compliance/aicm-v1.md) — per-framework coverage detail.
- [`docs/compliance/boe-pra-fca-ai-cyber.md`](compliance/boe-pra-fca-ai-cyber.md) — per-framework coverage detail.
- [`docs/compliance/llm-top-10.md`](compliance/llm-top-10.md) — per-framework coverage detail.
- [`docs/compliance/mcp-top-10.md`](compliance/mcp-top-10.md) — per-framework coverage detail.
