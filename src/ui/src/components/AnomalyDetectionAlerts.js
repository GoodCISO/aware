import React, { useState, useMemo } from 'react';
import { Box, Typography, Card, CardContent, Chip, Button, Collapse, Badge, Tabs, Tab } from '@mui/material';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import InfoIcon from '@mui/icons-material/Info';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

// Canonical severity contract. SEVERITY_LEVELS is ordered most-severe-first
// and drives both the filter tab set and the stat counters, so the tab count
// can never drift from the enum length again.
//
// The import stays INSIDE src/ui/src on purpose: react-scripts' ModuleScopePlugin
// rejects any import resolving outside this tree, and the UI is a separate
// deployable with its own package.json and Dockerfile. The server-side copy
// of this contract lives at src/monitoring/severity-contract.js and is held
// identical by test/unit/monitoring/severity-contract.test.js, which runs both
// implementations over a shared fixture corpus. See src/ui/src/constants/severity.js
// for the full rationale.
import {
  SEVERITY_LEVELS,
  normalizeAnomalies,
  countBySeverity,
  normalizeSeverity,
} from '../constants/severity';

/**
 * Per-level icon. The ramp is ordinal and the levels are 4, so the icons
 * escalate in a way that survives greyscale: filled > outline > dot.
 * Severity is ALSO rendered as a text label on every card (see below) because
 * a 4-step single-hue ramp cannot guarantee a distinguishable 4th step --
 * colour alone must never be the only carrier of meaning (WCAG 1.4.1).
 */
const SEVERITY_ICONS = {
  CRITICAL: <ErrorIcon fontSize="small" color="error" />,
  HIGH: <WarningIcon fontSize="small" color="warning" />,
  MEDIUM: <InfoIcon fontSize="small" color="info" />,
  LOW: <InfoIcon fontSize="small" color="disabled" />,
};

const AnomalyDetectionAlerts = ({ anomalies = [] }) => {
  const [expanded, setExpanded] = useState({});
  const [filter, setFilter] = useState('all');

  // Normalise at the render boundary, not just at the producer. The bug this
  // replaces was a UI that compared `a.severity` against strings it
  // invented; a payload from an older or newer deploy is now coerced before
  // anything counts or compares it, so a stale vocabulary degrades to the
  // documented fallback instead of to a wrong colour and a 0 counter.
  const normalized = useMemo(() => normalizeAnomalies(anomalies), [anomalies]);

  const stats = useMemo(() => countBySeverity(normalized), [normalized]);

  const filtered = filter === 'all'
    ? normalized
    : normalized.filter((a) => a.severity === filter);

  const toggleExpand = (id) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // The severity ramp is an ORDINAL scale on one hue with monotonically
  // descending lightness (theme.palette.severity.*). Measuring the token
  // here rather than hardcoding a hex keeps the component on the theme, and
  // the ramp values are contrast-verified in
  // test/unit/ui/severity-ramp.test.js.
  const severityColor = (severity) => `severity.${normalizeSeverity(severity)}`;

  const getSeverityIcon = (severity) =>
    SEVERITY_ICONS[normalizeSeverity(severity)] || SEVERITY_ICONS.LOW;

  return (
    <Box>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={600} gutterBottom>Anomaly Detection Alerts</Typography>
        <Typography variant="body2" color="text.secondary">
          Behavioral deviations detected by the AWARE monitoring layer
        </Typography>
      </Box>

      <Box display="flex" gap={2} mb={3} flexWrap="wrap">
        {SEVERITY_LEVELS.map((level) => (
          <Card key={level} sx={{ flex: 1, minWidth: 140, bgcolor: 'background.paper' }}>
            <CardContent>
              <Typography variant="h3" sx={{ color: severityColor(level) }}>{stats[level]}</Typography>
              <Typography variant="body2" color="text.secondary">{level}</Typography>
            </CardContent>
          </Card>
        ))}
        <Card sx={{ flex: 1, minWidth: 140, bgcolor: 'background.paper' }}>
          <CardContent>
            <Typography variant="h3" color="success.main">{stats.acknowledged}</Typography>
            <Typography variant="body2" color="text.secondary">Acknowledged</Typography>
          </CardContent>
        </Card>
      </Box>

      {/* One tab per canonical level, plus All. Previously this was a fixed
          3-tab critical/warning/info set, which could not represent a 4-level
          ramp at all -- so the tab set itself was wrong, not just the colours. */}
      <Tabs value={filter} onChange={(e, v) => setFilter(v)} sx={{ mb: 2 }}>
        <Tab value="all" label={`All (${stats.total})`} />
        {SEVERITY_LEVELS.map((level) => (
          <Tab key={level} value={level} label={`${level} (${stats[level]})`} />
        ))}
      </Tabs>

      <Box display="flex" flexDirection="column" gap={1}>
        {filtered.map((anomaly) => (
          <Card key={anomaly.id} variant="outlined" sx={{
            borderLeft: `4px solid`,
            borderColor: severityColor(anomaly.severity),
            opacity: anomaly.acknowledged ? 0.6 : 1,
          }}>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between">
                <Box display="flex" alignItems="center" gap={1}>
                  {getSeverityIcon(anomaly.severity)}
                  <Typography variant="subtitle2" fontWeight={600}>
                    {anomaly.title || anomaly.description}
                  </Typography>
                  {/* Text label: the non-colour channel for severity. */}
                  <Chip
                    label={normalizeSeverity(anomaly.severity)}
                    size="small"
                    sx={{ color: severityColor(anomaly.severity) }}
                  />
                  {anomaly.acknowledged && <Chip label="Ack" size="small" color="success" />}
                </Box>
                <Box display="flex" alignItems="center" gap={1}>
                  <Typography variant="caption" color="text.secondary">
                    {new Date(anomaly.detectedAt).toLocaleString()}
                  </Typography>
                  <Button size="small" onClick={() => toggleExpand(anomaly.id)}>
                    {expanded[anomaly.id] ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  </Button>
                </Box>
              </Box>
              <Collapse in={expanded[anomaly.id]}>
                <Box mt={1} p={1} bgcolor="background.default" borderRadius={1}>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    {anomaly.description}
                  </Typography>
                  <Box display="flex" gap={1} mt={1} flexWrap="wrap">
                    {anomaly.agentName && <Chip label={`Agent: ${anomaly.agentName}`} size="small" />}
                    {anomaly.agentId && <Chip label={`Agent: ${anomaly.agentId}`} size="small" />}
                    {anomaly.metric && <Chip label={anomaly.metric} size="small" />}
                    {anomaly.deviation !== undefined && (
                      <Chip label={`Deviation: ${anomaly.deviation}`} size="small" color="error" />
                    )}
                  </Box>
                  {!anomaly.acknowledged && (
                    <Box mt={1}>
                      <Button size="small" variant="outlined" startIcon={<CheckCircleIcon />}>
                        Acknowledge
                      </Button>
                    </Box>
                  )}
                </Box>
              </Collapse>
            </CardContent>
          </Card>
        ))}
      </Box>
    </Box>
  );
};

export default AnomalyDetectionAlerts;