// src/compliance/framework-mapper.js
// Framework Mapper — Maps AWARE components to compliance framework controls
// ADR (internal): Compliance Mapping & Reporting

const { AICM_V1_DOMAINS, AICM_V1_CONTROL_IDS } = require('./aicm-v1-catalog');
const { MCP_TOP_10_CONTROLS, MCP_TOP_10_CONTROL_IDS } = require('./mcp-top10-catalog');
const { ISO_42001_CONTROLS, ISO_42001_CONTROL_IDS } = require('./iso42001-catalog');

/**
 * Compliance Framework Definitions
 */
const FRAMEWORKS = {
  CSA_AI_CM: {
    id: 'CSA_AI_CM',
    name: 'CSA AI Controls Matrix',
    version: 'v1',
    source: 'https://cloudsecurityalliance.org/artifacts/ai-controls-matrix',
    catalogRef: './aicm-v1-catalog',
    // AICM v1 uses domain-grouped control IDs (e.g. 'IAM-01', 'MDS-03', 'DSP-17').
    // The full 184-control subset lives in aicm-v1-catalog.js; we expose it
    // through `controls` so the existing getFrameworkControls() path works
    // uniformly across CSA_AI_CM, NIST_AI_RMF, ISO_27001, and OWASP_LLM_TOP_10.
    controls: AICM_V1_DOMAINS,
    controlIds: AICM_V1_CONTROL_IDS,
    // Legacy `categories` view preserved for any caller still iterating by
    // domain. Each domain is exposed with its full name and a count of
    // controls so the existing iteration pattern (catId -> cat.name) still
    // works without forcing a refactor of downstream callers.
    categories: Object.fromEntries(
      Object.entries(AICM_V1_DOMAINS).map(([domId, ctrls]) => [
        domId,
        {
          name: domId,
          description: `CSA AICM v1 ${domId} domain — ${Object.keys(ctrls).length} controls`,
        },
      ])
    )
  },
  NIST_AI_RMF: {
    id: 'NIST_AI_RMF',
    name: 'NIST AI Risk Management Framework',
    version: '1.0',
    functions: {
      'GOVERN': { name: 'Govern', description: 'Governance structures' },
      'MAP': { name: 'Map', description: 'Risk assessment' },
      'MEASURE': { name: 'Measure', description: 'Measurement and analysis' },
      'MANAGE': { name: 'Manage', description: 'Risk management' }
    },
    // NOTE: control IDs below use NIST CSF subcategory format (PR.AC, DE.CM,
    // etc.). These are the IDs referenced by AWARE component mappings; the
    // NIST_AI_RMF label is retained for the framework-mapper API. A future
    // ADR should reconcile the CSF vs AI RMF ID scheme. (Pre-existing
    // inconsistency, flagged during OWASP LLM Top 10 mapping PR.)
    controls: {
      'GV.PO': { name: 'Govern — Policies, Processes, and Procedures', description: 'Organisational policies, processes, and procedures for AI risk management are established.' },
      'GV.RM': { name: 'Govern — Risk Management Strategy', description: 'AI risk management strategy is established and integrated.' },
      'PR.AC': { name: 'Protect — Access Control', description: 'Identities, credentials, and access management for AI system components.' },
      'PR.IP': { name: 'Protect — Information Protection', description: 'Information protection processes and procedures for AI systems.' },
      'PR.AA': { name: 'Protect — Awareness and Training', description: 'Personnel are trained on AI security and operational responsibilities.' },
      'DE.CM': { name: 'Detect — Continuous Monitoring', description: 'AI systems and assets are monitored to detect anomalies and events.' },
      'DE.AE': { name: 'Detect — Anomalies and Events', description: 'Anomalous activity on AI systems is detected and the potential impact is understood.' },
      'RS.RP': { name: 'Respond — Response Planning', description: 'Response processes and procedures for AI incidents are executed and maintained.' },
      'RS.MA': { name: 'Respond — Analysis', description: 'Analysis is performed to establish what has taken place during an AI event.' },
      'RS.MI': { name: 'Respond — Mitigation', description: 'Activities are performed to prevent expansion of an AI event and mitigate its effects.' },
      'RA-1': { name: 'Risk Assessment — Asset Vulnerability', description: 'Asset vulnerabilities are identified, validated, and recorded.' },
      'RA-3': { name: 'Risk Assessment — Threat Modelling', description: 'Threats, both internal and external, are identified and recorded.' }
    }
  },
  ISO_27001: {
    id: 'ISO_27001',
    name: 'ISO/IEC 27001:2022',
    version: '2022',
    categories: {
      'A.9': { name: 'Access Control', description: 'User access management' },
      'A.12': { name: 'Operations Security', description: 'Operational procedures' },
      'A.16': { name: 'Incident Management', description: 'Security incident management' }
    }
  },
  DORA: {
    id: 'DORA',
    name: 'Digital Operational Resilience Act',
    version: '2022',
    articles: {
      '12': { name: 'Internal Control Frameworks', description: 'ICT risk management' },
      '26': { name: 'ICT Incidents', description: 'Operational resilience' },
      '27': { name: 'Threat Intelligence', description: 'Cyber threat intelligence' }
    },
    controls: {
      'Art.12': { name: 'Internal Governance and Control', description: 'Financial entities must have an internal governance and control framework for ICT risk management, including roles, responsibilities, and risk tolerance.' },
      'Art.26': { name: 'Major ICT-Related Incident Reporting', description: 'Financial entities must define, document, and implement processes to detect, manage, log, and classify ICT-related incidents.' },
      'Art.27': { name: 'Cyber Threat Intelligence and Penetration Testing', description: 'Financial entities must maintain threat intelligence capabilities and conduct regular threat-led penetration testing.' }
    }
  },
  OWASP_LLM_TOP_10: {
    id: 'OWASP_LLM_TOP_10',
    name: 'OWASP Top 10 for Large Language Model Applications',
    // ADR-050 §2 (Decision 1): the bound spec is OWASP-Top-10-LLM-2025
    // (published 2025-03-12). The framework identity `OWASP_LLM_TOP_10`
    // is stable across AWARE releases; the rebinding from v1.1 (2023)
    // to 2025 happened via ADR-050 §5 GAP-1. Per-control descriptions
    // paraphrase the 2025 spec; the canonical source-of-truth list
    // lives in docs/compliance/llm-top-10.md §"Per-risk coverage" and
    // ADR-050 §1.1 (drift table). The deprecated 2023 (v1.1) ID set
    // is preserved at the framework ID `OWASP_LLM_TOP_10_v1_1` (not
    // wired into AWARE_COMPONENT_MAPPINGS) for traceability.
    version: '2025',
    controls: {
      'LLM01': { name: 'Prompt Injection', description: 'Manipulating LLMs via crafted inputs can lead to unauthorised access, data breaches, and compromised decision-making.' },
      'LLM02': { name: 'Sensitive Information Disclosure', description: 'Failure to protect against disclosure of sensitive information in LLM outputs can result in legal consequences or a loss of competitive advantage.' },
      'LLM03': { name: 'Supply Chain', description: 'Depending upon compromised components, services or datasets undermines system integrity, causing data breaches and system failures.' },
      'LLM04': { name: 'Data and Model Poisoning', description: 'Tampered training data or model weights can impair LLM models leading to responses that may compromise security, accuracy, or ethical behaviour.' },
      'LLM05': { name: 'Improper Output Handling', description: 'Neglecting to validate LLM outputs may lead to downstream security exploits, including code execution that compromises systems and exposes data.' },
      'LLM06': { name: 'Excessive Agency', description: 'Granting LLMs unchecked autonomy to take action can lead to unintended consequences, jeopardising reliability, privacy, and trust.' },
      'LLM07': { name: 'System Prompt Leakage', description: 'Exposing the system prompt to user input or to logs can reveal security policy, role, or allowed tools to parties who should not see them.' },
      'LLM08': { name: 'Vector and Embedding Weaknesses', description: 'Attacks on the RAG / embedding store layer (injection via stored documents, embedding inversion, cross-tenant retrieval contamination) compromise the integrity of retrieved context.' },
      'LLM09': { name: 'Misinformation', description: 'LLM-originated false content AND downstream overreliance on it lead to compromised decision making, security vulnerabilities, and legal liabilities.' },
      'LLM10': { name: 'Unbounded Consumption', description: 'Volumetric (DoS), cost (token spend), and scraping (model theft by sampling) abuse vectors against the LLM application.' }
    }
  },
  // ADR-043 — OWASP Agentic Skills Top 10 (AST10) v1.0-2026.
    // The control list is sourced from src/compliance/ast10-catalog.js (the
    // pinned JSON-style JS module shipped with this AWARE release) so the
    // control claim is reproducible across re-deploys. The risk-class
    // descriptions, severity strings, and IDs MUST match ast10-catalog.js
    // — any divergence is a bug.
    //
    // Rationale for adding this as a fifth supported framework lives in
    // ADR-043 ("Decision") and docs/compliance/ast10.md. AST10 is the only
    // published control catalogue that names the *behaviour-layer* attack
    // surface (skills themselves, not MCP or the model) that AWARE 2.0's
    // hook-based auto-interception sits in front of.
    OWASP_AST10: {
      id: 'OWASP_AST10',
      name: 'OWASP Agentic Skills Top 10',
      version: 'v1.0-2026',
      source: 'https://github.com/OWASP/www-project-agentic-skills-top-10',
      catalogRef: './ast10-catalog',
      // Flat AST01..AST10 control list. Severity is pinned to upstream;
      // descriptions are short — full per-class coverage lives in
      // docs/compliance/ast10.md.
      controls: {
        'AST01': { name: 'Malicious Skills', severity: 'Critical', description: 'Skill whose prose or behaviour instructs the agent to perform an attack (e.g. exfiltrate secrets, drop malware).' },
        'AST02': { name: 'Supply Chain Compromise', severity: 'Critical', description: 'Compromise of a skill, dependency, or publisher upstream of the agent.' },
        'AST03': { name: 'Over-Privileged Skills', severity: 'High', description: 'Skill requests permissions broader than its functionality requires.' },
        'AST04': { name: 'Insecure Metadata', severity: 'High', description: 'Skill manifest metadata parsed by an unsafe loader, allowing deserialization or template injection.' },
        'AST05': { name: 'Untrusted External Instructions', severity: 'High', description: 'Skill fetches and follows instructions from a host not on the agent allowlist.' },
        'AST06': { name: 'Weak Isolation', severity: 'High', description: 'Skill shares memory, FS, or process namespace with the host/agent without a sandbox boundary.' },
        'AST07': { name: 'Update Drift', severity: 'Medium', description: 'Skill installed without a content-hash pin; updates may silently change behaviour.' },
        'AST08': { name: 'Poor Scanning', severity: 'Medium', description: 'No behavioural or content scan before install; static-pattern scanners miss semantic attacks.' },
        'AST09': { name: 'No Governance', severity: 'Medium', description: 'Decisions are not centrally logged with an execution-receipt vector; no human review trail.' },
        'AST10': { name: 'Cross-Platform Reuse', severity: 'Medium', description: 'Skill loaded from one manifest format is reused on another platform with lossy translation.' }
      }
    },
    // ADR-051 — OWASP MCP Top 10 (2025). Spec pinned to upstream commit
    // 1b369f3270be0fc09f8d406537ec9a2195ca2e6a (2026-07-19 fetch). The
    // control list is sourced from src/compliance/mcp-top10-catalog.js
    // (the pinned JSON-style JS module shipped with this AWARE release)
    // so the control claim is reproducible across re-deploys. The
    // risk-class descriptions, severity strings, and IDs MUST match
    // mcp-top10-catalog.js — any divergence is a bug.
    //
    // Rationale for adding this as a sixth supported framework lives in
    // ADR-051 ("Decision") and docs/compliance/mcp-top-10.md. MCP Top 10
    // is the protocol-layer threat model; AST10 (behaviour), LLM Top 10
    // (model), and AISVS (verification) are the adjacent layers.
    OWASP_MCP_TOP_10: {
      id: 'OWASP_MCP_TOP_10',
      name: 'OWASP Top 10 for Model Context Protocol',
      version: '2025',
      source: 'https://github.com/OWASP/www-project-mcp-top-10',
      catalogRef: './mcp-top10-catalog',
      controls: MCP_TOP_10_CONTROLS,
      controlIds: MCP_TOP_10_CONTROL_IDS,
    },
    // ADR-055 — ISO/IEC 42001:2023 (AI Management System). Catalog pinned to
    // the ISMS.online third-party mirror (fetched 2026-07-28; the official
    // 42-control Annex A is paywalled + Cloudflare-walled on iso.org). The
    // 38-control subset shipped in v1 is the ISMS.online enumeration; an ISO
    // corrigendum or amendment is a NEW AWARE release and a NEW catalogue
    // file (D1 pin discipline) — do NOT edit iso42001-catalog.js in place.
    //
    // License posture: ISO standards are NOT Creative Commons; the catalog
    // uses control IDs + short titles from the public ISMS.online mirror
    // and paraphrased descriptions. No ISO normative text reproduced
    // anywhere in the repo. SPDX stays Apache-2.0 for the code; attribution
    // to ISMS.online lives in the catalog file header (D2).
    //
    // Scope statement: AWARE asserts Annex A control coverage only. Does
    // NOT assert clause 4-10 (management-system body) coverage. Does NOT
    // claim ISO/IEC 42001:2023 certification.
    //
    // Per ADR-055 §D3, per-entry `awareness: 'mapped' | 'partial' | 'gap'`
    // marks the 13 / 19 / 6 breakdown (research §6.1). A.6.2.8 (event logs)
    // is the canonical load-bearing mapping — surfaced via the audit chain
    // that compliance-mapping, anomaly-detection, and kill-switch ride.
    ISO_42001: {
      id: 'ISO_42001',
      name: 'ISO/IEC 42001:2023 — AI Management System',
      version: 'v1.0-2026-07-28',
      source: 'https://www.isms.online/iso-42001/annex-a-controls/',
      // Per ADR-055 D1: pin URL + fetch date; ISO corrigendum = new release.
      pinDate: '2026-07-28',
      // Per ADR-055 D2: SPDX stays Apache-2.0; attribution in catalog header.
      license: 'Apache-2.0 (code) / no upstream CC (control IDs + titles from ISMS.online)',
      attribution: 'Control IDs and titles sourced from ISMS.online public summary of ISO/IEC 42001:2023 Annex A (fetched 2026-07-28). Descriptions paraphrased; no ISO normative text reproduced.',
      catalogRef: './iso42001-catalog',
      // Flat 38-control list, ISMS.online nav order. Per ADR-055 §D3 each
      // entry carries { name, description, awareness, awareComponents,
      // crosswalkConfidence, ismsRef, clause }.
      controls: ISO_42001_CONTROLS,
      controlIds: ISO_42001_CONTROL_IDS,
      // Per ADR-055 §D3: 13 mapped / 19 partial / 6 gap of 38.
      awarenessBreakdown: { mapped: 13, partial: 19, gap: 6, total: 38 },
      // Per ADR-055 §"Scope statement": Annex A only; no clause 4-10.
      scopeNote: 'Annex A control coverage only; does NOT assert clause 4-10 management-system body coverage; does NOT claim certification.'
    }
  };

/**
 * AWARE Component to Control Mappings
 *
 * AICM v1 mappings below use real CSA AICM v1 control IDs (e.g. 'IAM-04',
 * 'MDS-08', 'DSP-17'). They were previously placeholders ('AI.ID-01' etc.)
 * that did not exist in the AICM spec. See src/compliance/aicm-v1-catalog.js
 * for the full control universe and scripts/regenerate-aicm-catalog.js for
 * the regeneration source.
 */
const AWARE_COMPONENT_MAPPINGS = {
  // Phase 1.1: Agent Registry — register AI agents, track metadata, lifecycle.
  'agent-registry': {
    'CSA_AI_CM': ['IAM-01', 'GRC-02'],
    'NIST_AI_RMF': ['PR.AC', 'DE.CM'],
    'ISO_27001': ['A.9.2', 'A.9.4'],
    'DORA': ['Art.12'],
    // ADR-050 §3: LLM05 (v1.1 Supply Chain) → LLM03:2025; LLM10 (v1.1 Model Theft) → LLM02:2025.
    'OWASP_LLM_TOP_10': ['LLM03', 'LLM02'],
    // ADR-043: agent-registry covers AST02 (supply-chain, via publisher-key machinery).
    'OWASP_AST10': ['AST02'],
    // ADR-055 §D5 / research §4: agent-registry is the canonical AWARE
    // surface for A.3.2 (roles/responsibilities), A.4.2 (resource inventory),
    // A.4.3 (data resources, partial), A.4.5 (compute resources, partial),
    // A.6.2.2 (requirements per agent), A.6.2.5 (deployment state),
    // A.7.2 (data for development), A.9.4 (intended use), A.10.2
    // (responsibility allocation).
    'ISO_42001': ['A.3.2', 'A.4.2', 'A.4.3', 'A.4.5', 'A.6.2.2', 'A.6.2.5', 'A.7.2', 'A.9.4', 'A.10.2']
  },

  // Phase 1.2: Per-Agent Sandbox Policies — execution isolation, input validation.
  'sandbox-policies': {
    'CSA_AI_CM': ['AIS-08', 'DSP-17', 'UEM-13'],
    'NIST_AI_RMF': ['PR.IP', 'DE.AE'],
    'ISO_27001': ['A.12.1', 'A.12.4'],
    'DORA': ['Art.12'],
    // ADR-050 §3: LLM04 (v1.1 Model DoS) → LLM10:2025; LLM07 (v1.1 Plugin Design) → LLM05:2025; LLM08 (v1.1 Excessive Agency) → LLM06:2025.
    'OWASP_LLM_TOP_10': ['LLM10', 'LLM05', 'LLM06'],
    // ADR-043: sandbox-policies covers AST06 (weak isolation) directly.
    'OWASP_AST10': ['AST06'],
    // ADR-051 §2.2: sandbox policies deny shell=True / eval / exec, which is
    // the runtime defence for MCP05 (Command Injection & Execution) regardless
    // of whether the call originated from an MCP-derived tool call.
    'OWASP_MCP_TOP_10': ['MCP05'],
    // ADR-055 §D5: sandbox-policies is one of the two AWARE surfaces for
    // A.6.1.3 (responsible design & development processes); tool-access-control
    // is the other half of the H-confidence mapping.
    'ISO_42001': ['A.6.1.3']
  },

  // Phase 1.3: Behavioural Baseline — per-agent behavioural baseline for anomaly scoring.
  'behavioral-baseline': {
    'CSA_AI_CM': ['LOG-03', 'MDS-05'],
    'NIST_AI_RMF': ['DE.CM', 'RS.MA'],
    'ISO_27001': ['A.12.4'],
    'DORA': ['Art.26', 'Art.27'],
    // ADR-050 §3: LLM03 (v1.1 Training Data Poisoning) → LLM04:2025 (Data and Model Poisoning); LLM09 stays.
    'OWASP_LLM_TOP_10': ['LLM04', 'LLM09'],
    // ADR-043: behavioral-baseline flags anomalous skill behaviour post-call,
    // which is the AST05 (untrusted external instructions) defence surface.
    'OWASP_AST10': ['AST05'],
    // ADR-055 §D5 / research §4: behavioral-baseline provides the reference
    // distribution for A.6.2.4 (V&V) and out-of-scope detection for A.9.4
    // (intended use).
    'ISO_42001': ['A.6.2.4', 'A.9.4']
  },

  // Phase 1.4: Kill Switch — emergency termination of misbehaving agents.
  'kill-switch': {
    'CSA_AI_CM': ['SEF-03', 'LOG-13'],
    'NIST_AI_RMF': ['RS.MI', 'RS.RP'],
    'ISO_27001': ['A.16.1'],
    'DORA': ['Art.26'],
    // ADR-050 §3: LLM04 (v1.1 Model DoS) → LLM10:2025; LLM08 (v1.1 Excessive Agency) → LLM06:2025.
    'OWASP_LLM_TOP_10': ['LLM10', 'LLM06'],
    // ADR-043: kill-switch is the AST06 (weak isolation) blast-radius terminator.
    'OWASP_AST10': ['AST06'],
    // ADR-055 §D5 / research §4: kill-switch chain events feed A.6.2.6
    // (operation & monitoring) and A.8.4 (communication of incidents).
    'ISO_42001': ['A.6.2.6', 'A.8.4']
  },

  // Phase 2.1: Pheromone Specialists — specialised detection heuristics (per Good CISO SimuRA).
  // ADR-043 §1 does NOT enumerate an AST10 row for pheromone-specialists
  // (the heuristic scoring it does is captured under anomaly-detection /
  // security-heuristic instead). Per docs/compliance/ast10.md this is
  // explicit: "(none — ADR-043 §1 does not enumerate this row)".
  'pheromone-specialists': {
    'CSA_AI_CM': ['TVM-08', 'MDS-08'],
    'NIST_AI_RMF': ['PR.IP'],
    'ISO_27001': ['A.12.1'],
    'DORA': ['Art.12'],
    'OWASP_LLM_TOP_10': ['LLM09']
    // No 'OWASP_AST10' key — by design. Cross-checked against
    // docs/compliance/ast10.md §"AWARE component → AST10 coverage".
    // ADR-055 §D5: pheromone-specialists has no ISO_42001 mapping either
    // (heuristic-only; same posture as the AST10/MCP/AIDEFEND exclusions).
  },

  // Phase 2.2: Security-Weighted Heuristic — risk-weighted decision routing.
  'security-heuristic': {
    'CSA_AI_CM': ['TVM-01', 'GRC-09'],
    'NIST_AI_RMF': ['RA-1', 'RA-3'],
    'ISO_27001': ['A.12.1'],
    'DORA': ['Art.12'],
    // ADR-050 §3: LLM02 (v1.1 Insecure Output Handling) → LLM05:2025 (Improper Output Handling); LLM01 stays.
    'OWASP_LLM_TOP_10': ['LLM01', 'LLM05'],
    // ADR-043: security-heuristic scores behavioural anomalies — the AST08
    // (poor scanning) defence surface, partial coverage.
    'OWASP_AST10': ['AST08'],
    // ADR-055 §D5 / research §4: security-heuristic participates in A.6.2.4
    // (V&V, scoring decisions against expected behaviour) and A.6.2.2
    // (verifying that an agent meets its declared requirements).
    'ISO_42001': ['A.6.2.2', 'A.6.2.4']
  },

  // Phase 3.1A: Agent Identity & Authentication — agent identity, authN, authZ.
  'identity-provider': {
    'CSA_AI_CM': ['IAM-04', 'IAM-09', 'CEK-21'],
    'NIST_AI_RMF': ['PR.AC', 'PR.AA'],
    'ISO_27001': ['A.9.2', 'A.9.4'],
    'DORA': ['Art.12'],
    // ADR-050 §3: v1.1 LLM07 (Plugin Design) drops — AST10 covers the plugin provenance
    // class per ADR-043. v1.1 LLM05/06/10 (Supply Chain / Sensitive Disclosure / Model Theft)
    // collapse into LLM02:2025 (Sensitive Information Disclosure, the broader 2025 scope).
    // v1.1 LLM05 also → LLM03:2025 (Supply Chain). Net: [LLM03, LLM02, LLM02, LLM02].
    'OWASP_LLM_TOP_10': ['LLM03', 'LLM02', 'LLM02', 'LLM02'],
    // ADR-043: identity-provider signing-key machinery covers AST01
    // (malicious skills) + AST02 (supply-chain, publisher keys).
    'OWASP_AST10': ['AST01', 'AST02'],
    // ADR-051 §2.2: identity-provider signing-key machinery is shape-compatible
    // with MCP-server signing (JWS / COSE); the publisher-key surface covers
    // MCP01 (token / secret exposure), MCP04 (supply-chain, pending identity
    // header SPIKE), and MCP07 (mTLS).
    'OWASP_MCP_TOP_10': ['MCP01', 'MCP04', 'MCP07'],
    // ADR-055 §D5 / research §4: identity-provider covers A.3.2 (roles)
    // and A.10.3 (suppliers) — publisher-key machinery is the supplier-
    // identity surface for AI components.
    'ISO_42001': ['A.3.2', 'A.10.3']
  },

  // Phase 3.1B: Behavioural Anomaly Detection — detect anomalous AI agent behaviour.
  'anomaly-detection': {
    'CSA_AI_CM': ['LOG-05', 'MDS-09', 'SEF-06'],
    'NIST_AI_RMF': ['DE.CM', 'DE.AE', 'RS.MA'],
    'ISO_27001': ['A.12.4'],
    'DORA': ['Art.26', 'Art.27'],
    // ADR-050 §3: v1.1 LLM03 (Training Data Poisoning) → LLM04:2025 (Data and Model Poisoning);
    // v1.1 LLM06 (Sensitive Disclosure) + LLM10 (Model Theft) → LLM02:2025 (Sensitive Information
    // Disclosure, broader 2025 scope); LLM01/LLM09 stay.
    'OWASP_LLM_TOP_10': ['LLM01', 'LLM04', 'LLM02', 'LLM09', 'LLM02'],
    // ADR-043: anomaly-detection covers AST01/AST05/AST08 (behavioural
    // observations) and AST09 (audit-chain governance).
    'OWASP_AST10': ['AST01', 'AST05', 'AST08', 'AST09'],
    // ADR-051 §2.2: anomaly-detection fires on MCP03 (tool/schema poisoning
    // attempts) and MCP06 (intent flow subversion) once the new MCP adapter
    // starts emitting mcp_message source events.
    'OWASP_MCP_TOP_10': ['MCP03', 'MCP06'],
    // ADR-055 §D5 / research §4: anomaly-detection participates in A.3.3
    // (concerns — observation events record), A.6.2.4 (V&V), A.6.2.6
    // (operation & monitoring), A.6.2.8 (event logs — via chain events;
    // A.6.2.8 is the canonical ISO 42001 mapping and rides the same chain),
    // and A.8.4 (incident communication).
    'ISO_42001': ['A.3.3', 'A.6.2.4', 'A.6.2.6', 'A.6.2.8', 'A.8.4']
  },

  // Phase 3.1C: Tool Access Control — fine-grained tool invocation control.
  'tool-access-control': {
    'CSA_AI_CM': ['IAM-08', 'DSP-05', 'AIS-07'],
    'NIST_AI_RMF': ['PR.AC', 'PR.IP'],
    'ISO_27001': ['A.9.4'],
    'DORA': ['Art.12'],
    // ADR-050 §3: v1.1 LLM02 (Insecure Output Handling) → LLM05:2025; v1.1 LLM04 (Model DoS) → LLM10:2025;
    // v1.1 LLM05 (Supply Chain) → LLM03:2025; v1.1 LLM07 (Plugin Design) drops — AST10 covers;
    // v1.1 LLM08 (Excessive Agency) → LLM06:2025; LLM01 stays.
    'OWASP_LLM_TOP_10': ['LLM01', 'LLM05', 'LLM10', 'LLM03', 'LLM03', 'LLM06'],
    // ADR-043: tool-access-control is the central surface for AST01/AST03/AST04/AST07.
    // AST03 (over-privilege) is enforced by permission-model.js; the AST10 mapper's
    // over-privilege-write rule (sensitive target → AST03 H) is fed from here.
    'OWASP_AST10': ['AST01', 'AST03', 'AST04', 'AST07'],
    // ADR-051 §2.2: tool-access-control is the central runtime gate for the
    // MCP-protocol surface — MCP02 (scope creep / per-call authZ),
    // MCP03 (tool/schema poisoning observation), MCP05 (parameter validation),
    // MCP07 (per-call authorization). The same per-call RBAC pipeline that
    // backs AST01/AST03/AST04/AST07 also fires on MCP-derived tool calls.
    'OWASP_MCP_TOP_10': ['MCP02', 'MCP03', 'MCP05', 'MCP07'],
    // ADR-055 §D5 / research §4: tool-access-control is the central surface
    // for A.6.1.3 (design & development processes), A.7.3 (data acquisition
    // allowlist), and A.9.2 (responsible use — runtime RBAC is the
    // enforcement mechanism).
    'ISO_42001': ['A.6.1.3', 'A.7.3', 'A.9.2']
  },

  // Phase 3.x: Tool Observation Proxy — observes model-input classifications
  // (LLM07 system-prompt-elicit) and review-loop annotations (LLM09
  // misinformation). Per ADR-050 §5 GAP-4 + GAP-6.
  //
  // The proxy's two emission paths both ride the existing audit chain:
  //   - src/policies/tool-observation-proxy.js::observeModelInput() emits
  //     `model_input_classification` source events with
  //     action.classification.rule === 'system-prompt-elicit' (commit 3d299d6).
  //   - src/compliance/llm09-mapper.js emits `review_required` annotations
  //     chained to the source model-output event (commit 4abdc20).
  //
  // Both project to LLMNN:2025 IDs via the DonkAI replay harness's
  // componentToLlm projection (test/standards/owasp-donkai/helpers.js).
  'tool-observation-proxy': {
    'CSA_AI_CM': ['LOG-05', 'MDS-09', 'SEF-06'],
    'NIST_AI_RMF': ['DE.CM', 'DE.AE', 'RS.MI'],
    'ISO_27001': ['A.12.4'],
    'DORA': ['Art.26', 'Art.27'],
    // ADR-050 §5 GAP-4 + GAP-6 — closes LLM07 + LLM09 coverage.
    'OWASP_LLM_TOP_10': ['LLM07', 'LLM09'],
    // ADR-043: observation participation in the audit-chain governance surface.
    'OWASP_AST10': ['AST09'],
    // ADR-055 §D5 / research §4: tool-observation-proxy records data flows
    // (input/output classification) and concerns — A.3.3 (concerns reporting),
    // A.4.3 (data resources — observation events are the access record), and
    // A.6.2.6 (operation & monitoring).
    'ISO_42001': ['A.3.3', 'A.4.3', 'A.6.2.6']
  },

  // Phase 3.2: Compliance Mapping — cross-framework mapping + posture reporting.
  'compliance-mapping': {
    'CSA_AI_CM': ['GRC-04', 'A&A-05'],
    'NIST_AI_RMF': ['GV.PO', 'GV.RM'],
    'ISO_27001': ['A.12.4'],
    'DORA': ['Art.12', 'Art.26'],
    'OWASP_LLM_TOP_10': ['LLM09'],
    // ADR-043: compliance-mapping emits the AST09 (no governance) audit
    // surface — the OWASP "execution-receipt" vector that AST09 calls for.
    'OWASP_AST10': ['AST09'],
    // ADR-051 §2.2: compliance-mapping surfaces MCP08 (audit/telemetry —
    // the compliance-report output is part of the audit evidence chain)
    // and MCP09 (shadow MCP — the report answers "which MCP servers
    // are we compliant against?").
    'OWASP_MCP_TOP_10': ['MCP08', 'MCP09'],
    // ADR-055 §D5 / research §4: compliance-mapping is the broadest ISO 42001
    // surface — emits the formal reports referenced by A.2.2 / A.2.3 (AI
    // policy + alignment), A.6.1.2 (responsible development objectives),
    // A.6.2.3 (design documentation), A.6.2.7 (technical documentation),
    // A.6.2.8 (event logs — compliance reports are part of the audit chain
    // that IS the A.6.2.8 evidence), A.7.5 (data provenance), A.8.2
    // (system documentation), A.8.3 (external reporting), A.8.5 (interested-
    // party information), A.9.3 (responsible-use objectives), and A.10.4
    // (customer-facing commitments).
    'ISO_42001': ['A.2.2', 'A.2.3', 'A.2.4', 'A.6.1.2', 'A.6.2.3', 'A.6.2.7', 'A.6.2.8', 'A.7.5', 'A.8.2', 'A.8.3', 'A.8.5', 'A.9.3', 'A.10.4']
  },

  // ADR-051 §2.2 — AWARE components not yet in the framework-mapper
  // component list. These four exist as real source files in src/policies/
  // but were not previously enumerated as AWARE components. ADR-051 §2.2
  // requires OWASP_MCP_TOP_10 mappings for them; other frameworks'
  // mappings will land in subsequent cards (cross-walk effort is not
  // this card's scope).

  // Per-call tool observation: every tool call AWARE sees passes through
  // src/policies/tool-observation-proxy.js, regardless of whether the
  // call originated from an MCP-derived tool call. ADR-051 §2.2 maps
  // this to MCP03 (schema/description poisoning observation),
  // MCP06 (intent-flow subversion, MCP resources/read content),
  // MCP08 (audit/telemetry surface), MCP10 (cross-session context).
  'tool-observation-proxy': {
    'OWASP_MCP_TOP_10': ['MCP03', 'MCP06', 'MCP08', 'MCP10'],
    // ADR-055 §D5 / research §4: tool-observation-proxy is the canonical
    // observation surface for A.3.3 (concerns reporting), A.4.3 (data
    // resources — observation events are the access record), and A.6.2.6
    // (operation & monitoring). The earlier 'tool-observation-proxy' row
    // (line 424, added in the Phase 3.x block) is overridden by this one
    // in JS, so the ISO_42001 mapping lives here.
    'ISO_42001': ['A.3.3', 'A.4.3', 'A.6.2.6']
  },

  // Per-call RBAC: src/policies/permission-model.js evaluates
  // deny-by-default permissions per request. ADR-051 §2.2 maps this to
  // MCP02 (scope creep — static enforcement only; drift detection
  // deferred to AWARE 2.2) and MCP07 (per-call authorization).
  'permission-model': {
    'OWASP_MCP_TOP_10': ['MCP02', 'MCP07']
    // No 'ISO_42001' key — research §4 does not enumerate a per-component
    // permission-model mapping. Per-call RBAC is captured under
    // tool-access-control's A.9.2 (responsible-use processes) mapping;
    // adding a duplicate row here would inflate the crosswalk without
    // adding evidence. Cross-checked against ADR-055 §D5 (which also does
    // not enumerate permission-model).
  },

  // Tool-level shadow detection: src/policies/shadow-detector.js flags
  // unregistered tool calls after 3 in a 5-min window. ADR-051 §2.2
  // maps this to MCP09 (Shadow MCP Servers) — the tool-level surface
  // is a partial mitigation; protocol-level MCP-server-instance
  // allowlist is a follow-up (deferred).
  'shadow-detector': {
    'OWASP_MCP_TOP_10': ['MCP09']
    // No 'ISO_42001' key — research §4 does not enumerate a shadow-detector
    // mapping. Tool-level shadow detection is a partial mitigation for
    // MCP09 (shadow MCP servers); it does not surface as a distinct ISO
    // 42001 control per ADR-055 §D5.
  },

  // Tool-output credential classifier:
  // src/policies/credential-classifier.js scans every tool-output
  // payload for known credential patterns (APTS-MR-019). ADR-051 §2.2
  // maps this to MCP01 (Token Mismanagement & Secret Exposure) — the
  // tool-output layer is the only MCP01 surface wired today; env-var /
  // MCP-config / prompt-template secret coverage requires the new MCP
  // adapter and is deferred.
  'credential-classifier': {
    'OWASP_MCP_TOP_10': ['MCP01'],
    // ADR-055 §D5 / research §4: credential-classifier covers A.7.4
    // (data quality for sensitive content — only the secret/PII quality
    // dimension is wired today).
    'ISO_42001': ['A.7.4']
  }
};

/**
 * Framework Mapper class
 */
class FrameworkMapper {
  constructor() {
    this.frameworks = FRAMEWORKS;
    this.mappings = AWARE_COMPONENT_MAPPINGS;
  }

  /**
   * Get all frameworks
   * @returns {Object}
   */
  getFrameworks() {
    return { ...this.frameworks };
  }

  /**
   * Get framework by ID
   * @param {string} frameworkId
   * @returns {Object|null}
   */
  getFramework(frameworkId) {
    return this.frameworks[frameworkId] || null;
  }

  /**
   * Get all component mappings
   * @returns {Object}
   */
  getAllMappings() {
    return { ...this.mappings };
  }

  /**
   * Get mapping for a specific component
   * @param {string} componentId
   * @returns {Object|null}
   */
  getComponentMapping(componentId) {
    return this.mappings[componentId] || null;
  }

  /**
   * Get all controls for a specific framework
   * @param {string} frameworkId
   * @returns {Array}
   */
  getFrameworkControls(frameworkId) {
    const framework = this.frameworks[frameworkId];
    if (!framework) return [];

    const controls = [];

    // CSA AICM v1: iterate the real control universe from aicm-v1-catalog.js.
    // Each control ID is a domain-prefixed code (e.g. 'IAM-01', 'MDS-08', 'DSP-17').
    if (frameworkId === 'CSA_AI_CM') {
      for (const [domId, domainCtrls] of Object.entries(framework.controls || {})) {
        for (const [ctrlId, ctrl] of Object.entries(domainCtrls)) {
          controls.push({
            id: ctrlId,
            category: domId,
            categoryName: domId,
            name: ctrl.name,
            description: ctrl.description,
          });
        }
      }
    }

    // ISO 27001 has Annex A categories
    if (frameworkId === 'ISO_27001') {
      for (const [catId, cat] of Object.entries(framework.categories || {})) {
        controls.push({
          id: `${catId}`,
          category: catId,
          categoryName: cat.name,
          description: cat.description
        });
      }
    }

    // OWASP LLM Top 10 has flat LLM01-LLM10 controls
    if (frameworkId === 'OWASP_LLM_TOP_10') {
      for (const [ctrlId, ctrl] of Object.entries(framework.controls || {})) {
        controls.push({
          id: ctrlId,
          category: ctrlId,
          categoryName: ctrl.name,
          description: ctrl.description
        });
      }
    }

    // OWASP AST10 has flat AST01-AST10 controls (same shape as LLM Top 10).
    // Per ADR-043 — the framework entry here is the structural surface;
    // the per-rule annotations live in src/compliance/ast10-mapper.js.
    if (frameworkId === 'OWASP_AST10') {
      for (const [ctrlId, ctrl] of Object.entries(framework.controls || {})) {
        controls.push({
          id: ctrlId,
          category: ctrlId,
          categoryName: ctrl.name,
          severity: ctrl.severity || null,
          description: ctrl.description
        });
      }
    }

    // OWASP MCP Top 10 has flat MCP01-MCP10 controls (same shape as AST10
    // and LLM Top 10). Per ADR-051 — the framework entry here is the
    // structural surface; per-rule annotations will live in
    // src/compliance/mcp-top10-classifier.js (separate kanban card).
    if (frameworkId === 'OWASP_MCP_TOP_10') {
      for (const [ctrlId, ctrl] of Object.entries(framework.controls || {})) {
        controls.push({
          id: ctrlId,
          category: ctrlId,
          categoryName: ctrl.name,
          severity: ctrl.severity || null,
          description: ctrl.description
        });
      }
    }

    // ISO/IEC 42001:2023 — flat A.X.Y controls with per-entry awareness.
    // Per ADR-055 §D3 the entry shape is { name, description, awareness,
    // awareComponents, crosswalkConfidence, ismsRef, clause }. We expose
    // awareness + awareComponents + crosswalkConfidence so the compliance
    // report can render the 13/19/6 breakdown and operators can drill
    // from a control back to AWARE components.
    if (frameworkId === 'ISO_42001') {
      for (const [ctrlId, ctrl] of Object.entries(framework.controls || {})) {
        controls.push({
          id: ctrlId,
          category: ctrlId,
          categoryName: ctrl.name,
          description: ctrl.description,
          awareness: ctrl.awareness || null,
          awareComponents: ctrl.awareComponents || [],
          crosswalkConfidence: ctrl.crosswalkConfidence || null,
          ismsRef: ctrl.ismsRef || null,
          clause: ctrl.clause || null
        });
      }
    }

    // DORA uses Art.NN prefixed controls (matches mapping format)
    if (frameworkId === 'DORA') {
      for (const [ctrlId, ctrl] of Object.entries(framework.controls || {})) {
        controls.push({
          id: ctrlId,
          category: ctrlId,
          categoryName: ctrl.name,
          description: ctrl.description
        });
      }
    }

    // NIST AI RMF controls (CSF subcategory format) — see note in FRAMEWORKS
    if (frameworkId === 'NIST_AI_RMF') {
      for (const [ctrlId, ctrl] of Object.entries(framework.controls || {})) {
        controls.push({
          id: ctrlId,
          category: ctrlId,
          categoryName: ctrl.name,
          description: ctrl.description
        });
      }
    }

    return controls;
  }

  /**
   * Map component to all its compliance controls
   * @param {string} componentId
   * @returns {Array}
   */
  mapComponent(componentId) {
    const mapping = this.mappings[componentId];
    if (!mapping) return [];

    const results = [];

    for (const [frameworkId, controlIds] of Object.entries(mapping)) {
      const framework = this.frameworks[frameworkId];
      if (!framework) continue;

      for (const controlId of controlIds) {
        results.push({
          componentId,
          frameworkId,
          frameworkName: framework.name,
          controlId
        });
      }
    }

    return results;
  }

  /**
   * Generate compliance matrix for all components
   * @returns {Object}
   */
  generateComplianceMatrix() {
    const matrix = {};

    for (const [componentId, mapping] of Object.entries(this.mappings)) {
      matrix[componentId] = {};

      for (const [frameworkId, controlIds] of Object.entries(mapping)) {
        const framework = this.frameworks[frameworkId];
        if (!framework) continue;

        matrix[componentId][frameworkId] = {
          frameworkName: framework.name,
          controls: controlIds.map(id => ({
            id,
            status: 'IMPLEMENTED' // Default status
          }))
        };
      }
    }

    return matrix;
  }

  /**
   * Check if a component covers a specific control
   * @param {string} componentId
   * @param {string} frameworkId
   * @param {string} controlId
   * @returns {boolean}
   */
  componentCoversControl(componentId, frameworkId, controlId) {
    const mapping = this.mappings[componentId];
    if (!mapping) return false;

    const frameworkControls = mapping[frameworkId];
    if (!frameworkControls) return false;

    return frameworkControls.includes(controlId);
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create FrameworkMapper singleton
 * @returns {FrameworkMapper}
 */
function getFrameworkMapper() {
  if (!instance) {
    instance = new FrameworkMapper();
  }
  return instance;
}

module.exports = {
  FrameworkMapper,
  getFrameworkMapper,
  FRAMEWORKS,
  AWARE_COMPONENT_MAPPINGS
};
