import React from 'react';
import {
  Box, Typography, Card, CardContent, LinearProgress, Chip,
  Alert, Tooltip, Divider,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningIcon from '@mui/icons-material/Warning';
import ErrorIcon from '@mui/icons-material/Error';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import DescriptionIcon from '@mui/icons-material/Description';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import GavelIcon from '@mui/icons-material/Gavel';

// 2026-11-10 (scribe): the hardcoded FRAMEWORKS array was deleted.
//
// It listed four frameworks with hardcoded control counts (ISO 27001 = 114,
// SOC 2 = 64, GDPR = 99, EU AI Act = 42). None of those numbers matched
// either the v1 mock backend (ISO 27001 = 93, SOC 2 = 64, GDPR = 68,
// EU AI Act = 42) or the live engine (CSA_AI_CM = 184, NIST_AI_RMF = 12,
// ISO_27001 = 3, DORA = 3, OWASP_LLM_TOP_10 = 10, OWASP_AST10 = 10,
// OWASP_MCP_TOP_10 = 10, ISO_42001 = 38). The IDs did not match either:
// the array used iso27001/soc2/gdpr/aiact, the engine uses
// CSA_AI_CM / NIST_AI_RMF / ISO_27001 / DORA / OWASP_* / ISO_42001.
//
// The framework list, the control counts, and the scores now all come from
// the API response. The icon map below is presentation only — it maps a
// known framework ID to an icon, and falls back to a neutral icon for any
// framework the server adds later.

const FRAMEWORK_ICONS = {
  ISO_27001: <VerifiedUserIcon />,
  CSA_AI_CM: <DescriptionIcon />,
  NIST_AI_RMF: <VerifiedUserIcon />,
  DORA: <CloudDoneIcon />,
  ISO_42001: <DescriptionIcon />,
  OWASP_LLM_TOP_10: <GavelIcon />,
  OWASP_AST10: <GavelIcon />,
  OWASP_MCP_TOP_10: <GavelIcon />,
};

const STATUS_STYLE = {
  CRITICAL: { color: 'error', icon: <ErrorIcon color="error" /> },
  NON_COMPLIANT: { color: 'error', icon: <ErrorIcon color="error" /> },
  PARTIAL: { color: 'warning', icon: <WarningIcon color="warning" /> },
  COMPLIANT: { color: 'success', icon: <CheckCircleIcon color="success" /> },
  NOT_ASSESSED: { color: 'default', icon: <InfoOutlinedIcon color="disabled" /> },
};

const formatStatus = (s) => (s ? s.replace(/_/g, ' ').toUpperCase() : 'UNKNOWN');

const ComplianceMapping = ({ posture = null, evidence = null, frameworks = [] }) => {
  const frameworkPostures = posture?.frameworks || [];

  // Metadata from /frameworks (id, name, version) merged with the posture
  // entry for that framework. The engine is the source of truth for
  // counts and scores; the catalogue only supplies display names.
  const catalogueById = {};
  for (const f of frameworks) {
    if (f?.id) catalogueById[f.id] = f;
  }

  const rows = frameworkPostures.map((p) => {
    const meta = catalogueById[p.frameworkId] || {};
    return {
      id: p.frameworkId,
      name: p.frameworkName || meta.name || p.frameworkId,
      version: meta.version || null,
      status: p.status,
      score: typeof p.score === 'number' ? p.score : 0,
      percentage: typeof p.percentage === 'number' ? p.percentage : 0,
      controlsAssessed: p.controlsAssessed ?? 0,
      controlsTotal: p.controlsTotal ?? 0,
      compliantControls: p.compliantControls ?? 0,
      nonCompliantControls: p.nonCompliantControls ?? 0,
      openGaps: p.openGaps ?? 0,
    };
  });

  const totalEvidence = evidence?.totalEvidence ?? 0;
  const evidenceByStatus = evidence?.byStatus || {};

  // The honest aggregate: how much of the declared surface has actually
  // been assessed. This is NOT the same as the compliance score, and the
  // two must not be conflated on the dashboard.
  const totals = rows.reduce(
    (acc, r) => ({
      assessed: acc.assessed + r.controlsAssessed,
      controls: acc.controls + r.controlsTotal,
      gaps: acc.gaps + r.openGaps,
    }),
    { assessed: 0, controls: 0, gaps: 0 }
  );

  const coveragePct = totals.controls > 0
    ? Math.round((totals.assessed / totals.controls) * 100)
    : 0;

  return (
    <Box>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={600} gutterBottom>Compliance Mapping</Typography>
        <Typography variant="body2" color="text.secondary">
          Framework coverage, audit readiness, and evidence collection status
        </Typography>
      </Box>

      {totals.assessed === 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          No controls have been assessed. Every framework below shows 0
          compliant controls because no assessment has been recorded — this
          is an absence of measurement, not a measured failure. Run an
          evidence collection and record assessments to populate these
          figures.
        </Alert>
      )}

      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(320px, 1fr))" gap={2} mb={3}>
        {rows.map((r) => {
          const style = STATUS_STYLE[r.status] || STATUS_STYLE.NOT_ASSESSED;
          const assessed = r.controlsAssessed > 0;
          return (
            <Card key={r.id} variant="outlined">
              <CardContent>
                <Box display="flex" alignItems="center" gap={1} mb={1}>
                  {FRAMEWORK_ICONS[r.id] || <InfoOutlinedIcon color="disabled" />}
                  <Typography variant="h6" fontWeight={600}>{r.name}</Typography>
                  <Box flexGrow={1} />
                  {style.icon}
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {r.id}{r.version ? ` · v${r.version}` : ''}
                </Typography>

                <Box mb={1}>
                  <Box display="flex" justifyContent="space-between" mb={0.5}>
                    <Typography variant="body2">Controls assessed</Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {r.controlsAssessed}/{r.controlsTotal}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={r.controlsTotal > 0 ? (r.controlsAssessed / r.controlsTotal) * 100 : 0}
                    color={style.color}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                </Box>

                <Box mb={1}>
                  <Box display="flex" justifyContent="space-between" mb={0.5}>
                    <Typography variant="body2">Compliant</Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {r.compliantControls}/{r.controlsTotal}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={r.controlsTotal > 0 ? (r.compliantControls / r.controlsTotal) * 100 : 0}
                    color={style.color}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                </Box>

                <Box display="flex" gap={1} mt={2} flexWrap="wrap">
                  <Chip label={formatStatus(r.status)} size="small" color={style.color} variant="outlined" />
                  <Chip label={`${r.controlsTotal} controls`} size="small" variant="outlined" />
                  {r.openGaps > 0 && (
                    <Chip label={`${r.openGaps} open gaps`} size="small" color="warning" variant="outlined" />
                  )}
                  {!assessed && (
                    <Tooltip title="No assessment recorded for this framework yet">
                      <Chip label="Not assessed" size="small" variant="outlined" />
                    </Tooltip>
                  )}
                </Box>
              </CardContent>
            </Card>
          );
        })}
      </Box>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" fontWeight={600} gutterBottom>Audit Readiness</Typography>
          <Divider sx={{ mb: 2 }} />

          <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))" gap={2}>
            <Box>
              <Typography variant="body2" color="text.secondary">Overall status</Typography>
              <Typography variant="h6" fontWeight={600}>
                {formatStatus(posture?.overallStatus)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">Control assessment coverage</Typography>
              <Typography variant="h6" fontWeight={600}>
                {totals.assessed}/{totals.controls} ({coveragePct}%)
              </Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">Evidence collected</Typography>
              <Typography variant="h6" fontWeight={600}>{totalEvidence}</Typography>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary">Open gaps</Typography>
              <Typography variant="h6" fontWeight={600}>
                {posture?.openGaps ?? totals.gaps}
                {posture?.criticalGaps ? ` (${posture.criticalGaps} critical)` : ''}
              </Typography>
            </Box>
          </Box>

          {Object.keys(evidenceByStatus).length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="body2" color="text.secondary" gutterBottom>Evidence by status</Typography>
              <Box display="flex" gap={1} flexWrap="wrap">
                {Object.entries(evidenceByStatus).map(([status, count]) => (
                  <Chip key={status} label={`${status}: ${count}`} size="small" variant="outlined" />
                ))}
              </Box>
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
};

export default ComplianceMapping;
