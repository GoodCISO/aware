// src/disclosure/index.js
// Disclosure Module — Public API for ADR-079 (Disclosure record generator)

const {
  PublicationGranularity,
  GRANULARITY_LEGACY_ALIAS,
  RENDERABLE_GRANULARITIES,
  DISCLOSURE_RECORD_VERSION,
  GENESIS_HASH,
  buildDisclosureRecord,
  verifyChainWindow,
  verifyFullChain,
  canonicalSerialize,
  computeWindowRecordHash
} = require('./disclosure-record');

module.exports = {
  // Granularity ladder
  PublicationGranularity,
  GRANULARITY_LEGACY_ALIAS,
  RENDERABLE_GRANULARITIES,

  // Record construction + verification
  buildDisclosureRecord,
  verifyChainWindow,
  verifyFullChain,

  // Constants + utilities
  DISCLOSURE_RECORD_VERSION,
  GENESIS_HASH,
  canonicalSerialize,
  computeWindowRecordHash
};
