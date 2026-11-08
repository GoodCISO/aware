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
        const [agentsRes, anomaliesRes, complianceRes] = await Promise.allSettled([
          agentAPI.list(),
          anomalyAPI.getStats(),
          complianceAPI.getCoverage(),
        ]);

        const agents = agentsRes.status === 'fulfilled' ? agentsRes.value.data : [];
        const anomalies = anomaliesRes.status === 'fulfilled' ? anomaliesRes.value.data : { critical: 0 };
        const coverage = complianceRes.status === 'fulfilled' ? complianceRes.value.data : {};

        setStats({
          totalAgents: agents.length,
          activeAgents: agents.filter((a) => a.status === 'active').length,
          criticalAlerts: anomalies.critical || 0,
          complianceScore: coverage.overall || 0,
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
            value={stats.activeAgents}
            subtitle={`${stats.totalAgents} total registered`}
            icon={<SecurityIcon color="primary" />}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricsCard
            title="Revieweral Alerts"
            value={stats.criticalAlerts}
            subtitle="Require immediate attention"
            icon={<WarningIcon color="error" />}
            color="error"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <MetricsCard
            title="Compliance Score"
            value={`${stats.complianceScore}%`}
            subtitle="Framework coverage across all standards"
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
