import React, { useEffect, useState } from 'react';
import { Box, Alert, CircularProgress } from '@mui/material';
import AgentIdentityDashboard from '../components/AgentIdentityDashboard';
import { agentAPI } from '../services/api';

const mockAgents = [
  { id: 'agent-001', name: 'Researcher (Researcher)', status: 'active', declaredTrustScore: 92, capabilities: ['web_search', 'research', 'reporting'], credentials: true, lastActivity: '2026-05-21T14:30:00Z' },
  { id: 'agent-002', name: 'Architect (Architect)', status: 'active', declaredTrustScore: 88, capabilities: ['design', 'specification', 'review'], credentials: true, lastActivity: '2026-05-21T14:25:00Z' },
  { id: 'agent-003', name: 'Designer (Designer)', status: 'suspended', declaredTrustScore: 45, capabilities: ['ui_design', 'css', 'prototyping'], credentials: false, lastActivity: '2026-05-20T09:15:00Z' },
  { id: 'agent-004', name: 'Coder (Coder)', status: 'active', declaredTrustScore: 85, capabilities: ['coding', 'testing', 'debugging'], credentials: true, lastActivity: '2026-05-21T15:00:00Z' },
  { id: 'agent-005', name: 'Tester (Tester)', status: 'active', declaredTrustScore: 78, capabilities: ['testing', 'validation', 'reporting'], credentials: true, lastActivity: '2026-05-21T13:45:00Z' },
];

const AgentIdentityContainer = () => {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await agentAPI.list();
        setAgents(res.data);
      } catch {
        // Fallback to mock data if API unavailable
        setAgents(mockAgents);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return <Box display="flex" justifyContent="center" p={4}><CircularProgress /></Box>;
  if (error) return <Alert severity="error">{error}</Alert>;

  return <AgentIdentityDashboard agents={agents} />;
};

export default AgentIdentityContainer;
