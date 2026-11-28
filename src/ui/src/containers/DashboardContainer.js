import React, { useEffect, useState } from 'react';
import { Box, Typography, Grid, Alert } from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import WarningIcon from '@mui/icons-material/Warning';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import GavelIcon from '@mui/icons-material/Gavel';
import MetricsCard from '../components/MetricsCard';
import { agentAPI, anomalyAPI, complianceAPI } from '../services/api';

const DashboardContainer = () => {
  const [stats, setStats] = useState({
    totalAgents: 0,
    activeAgents: 0,
    criticalAlerts: 0,
    complianceScore: 0,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const loadStats = async () => {
      try {
        // 2026-11-25 (coder, t_fe706dd6): this called
        // `complianceAPI.getCoverage()`, a method that no longer exists --
        // d3f3089b removed it from src/ui/src/services/api.js when it
        // deleted the mockCoverage/mockEvidence/mockReadiness fixtures.
        // The call site was not updated, so the whole dashboard rendered as
        // one line: "Failed to load dashboard: getCoverage is not a
        // function".
        //
        // The replacement is `getPosture()` -- the durable compliance
        // surface d3f3089b introduced. `/compliance/coverage` NEVER
        // existed on the backend (measured: `git log -S"router.get
        // ('/coverage'" -- src/api/routes/compliance.js` is empty), so
        // restoring a client method for it would have restored a call that
        // can only ever 404. The posture endpoint is live and returns
        // {overallScore, overallPercentage, overallStatus, frameworks[]}.
        //
        // The score shown is `overallPercentage`, NOT `overall`: the
        // posture payload's `overallScore` is a 0..1 FRACTION, and the old
        // code read `coverage.overall` (the mock's 0..100 shape), so
        // reading `overallScore` would render "1%" for a perfect posture.
        //
        // WHY allSettled WAS NOT ENOUGH (measured): the array literal is
        // EVALUATED BEFORE allSettled is called, so `getCoverage()` threw
        // SYNCHRONOUSLY and allSettled was never invoked. The two
        // sibling promises were therefore orphaned and their 401s surfaced
        // as two unhandled rejections -- a pageerror the dashboard could
        // not have caught with its own try/catch. Fixing the method fixes
        // all three errors at once.
        const [agentsRes, anomaliesRes, complianceRes] = await Promise.allSettled([
          agentAPI.list(),
          anomalyAPI.getStats(),
          complianceAPI.getPosture(),
        ]);

        // 2026-11-25 (coder, t_fe706dd6): a REJECTED promise is an ABSENCE
        // OF MEASUREMENT, and the old code rendered that absence as a
        // measured ZERO: `agentsRes.status === 'fulfilled' ? ... : []` then
        // `totalAgents: agents.length`.
        //
        // On the live system /api/agents and /api/anomalies/stats both 401
        // (the gateway requires a bearer token the UI does not send -- see
        // the sibling card t_61ee5b0a), so the dashboard would have rendered
        // "0 total registered" and, worse, "0 Critical Alerts" on a
        // SECURITY screen. A dashboard that says "no alerts" when it never
        // managed to ask is the same failure mode as the mock fallbacks
        // d3f3089b deleted: a plausible number standing in for an
        // unanswered question.
        //
        // So each figure now carries its provenance. `null` means "not
        // retrieved" and renders as an explicit unavailable state; a number
        // means "measured". The two are never conflated.
        const agents = agentsRes.status === 'fulfilled' ? (agentsRes.value.data || []) : null;
        const anomalies = anomaliesRes.status === 'fulfilled' ? anomaliesRes.value.data : null;
        const posture = complianceRes.status === 'fulfilled' ? complianceRes.value.data : null;

        setStats({
          totalAgents: agents === null ? null : agents.length,
          activeAgents: agents === null ? null : agents.filter((a) => a.status === 'active').length,
          criticalAlerts: anomalies === null ? null : (anomalies.critical || 0),
          complianceScore: posture === null ? null : (posture.overallPercentage || 0),
          loading: false,
          error: null,
        });
      } catch (err) {
        setStats((prev) => ({ ...prev, loading: false, error: err.message }));
      }
    };

    loadStats();
  }, []);

  if (stats.error) {
    return <Alert severity="error">Failed to load dashboard: {stats.error}</Alert>;
  }

  // 2026-11-25 (coder, t_fe706dd6): a figure that could not be retrieved
  // renders as "Unavailable", never as 0. The distinction matters most on
  // the "Critical Alerts" card: a security dashboard that reads 0 alerts
  // when the alert API rejected the request is asserting an absence of
  // threats it never checked for.
  const unavailable = 'Unavailable';
  const orUnavailable = (value) => (value === null ? unavailable : value);

  return (
    <Box>
      <Typography variant="h4" fontWeight={600} gutterBottom>AWARE Control Plane</Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Security governance and observability for AI agents
      </Typography>

      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} md={3}>
          <MetricsCard
            title="Active Agents"
            value={orUnavailable(stats.activeAgents)}
            subtitle={stats.totalAgents === null
              ? 'Agent list unavailable'
              : `${stats.totalAgents} total registered`}
            icon={<SecurityIcon color="primary" />}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricsCard
            title="Revieweral Alerts"
            value={orUnavailable(stats.criticalAlerts)}
            subtitle={stats.criticalAlerts === null
              ? 'Alert stats unavailable — not zero alerts'
              : 'Require immediate attention'}
            icon={<WarningIcon color="error" />}
            color="error"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricsCard
            title="Compliance Score"
            value={stats.complianceScore === null
              ? unavailable
              : `${stats.complianceScore}%`}
            subtitle={stats.complianceScore === null
              ? 'Posture unavailable'
              : 'Framework coverage across all standards'}
            icon={<VerifiedUserIcon color="success" />}
            color="success"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricsCard
            title="Constraints Enforced"
            value="T2+"
            subtitle="Guardrailed and above"
            icon={<GavelIcon color="metricValue" />}
            color="metricValue"
          />
        </Grid>
      </Grid>
    </Box>
  );
};

export default DashboardContainer;
