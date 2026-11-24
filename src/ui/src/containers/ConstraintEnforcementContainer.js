// eslint-disable-next-line no-undef
import React, { useEffect, useState } from 'react';
import { Box, Alert, CircularProgress } from '@mui/material';
import ConstraintEnforcementView from '../components/ConstraintEnforcementView';
import { constraintAPI } from '../services/api';

const mockAgents = [
  { id: 'agent-001', name: 'Researcher', status: 'active', declaredTrustScore: 92, constraintLevel: 'T2', capabilities: ['research'] },
  { id: 'agent-002', name: 'Architect', status: 'active', declaredTrustScore: 88, constraintLevel: 'T2', capabilities: ['design'] },
  { id: 'agent-003', name: 'Designer', status: 'suspended', declaredTrustScore: 45, constraintLevel: 'T4', capabilities: ['ui_design'] },
  { id: 'agent-004', name: 'Coder', status: 'active', declaredTrustScore: 85, constraintLevel: 'T2', capabilities: ['coding'] },
  { id: 'agent-005', name: 'Tester', status: 'active', declaredTrustScore: 78, constraintLevel: 'T3', capabilities: ['testing'] },
];

const mockConstraints = [
  { id: 'c1', level: 'T2', name: 'No external API calls without approval', status: 'enforced', agentId: 'agent-004' },
  { id: 'c2', level: 'T2', name: 'Read-only filesystem access', status: 'enforced', agentId: 'agent-004' },
  { id: 'c3', level: 'T3', name: 'Sandboxed execution only', status: 'enforced', agentId: 'agent-005' },
  { id: 'c4', level: 'T4', name: 'No execution privileges', status: 'enforced', agentId: 'agent-003' },
];

const ConstraintEnforcementContainer = () => {
  const [constraints, setConstraints] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [cRes, aRes] = await Promise.all([
          constraintAPI.list(),
          agentAPI.list(),
        ]);
        setConstraints(cRes.data);
        setAgents(aRes.data);
      } catch {
        setConstraints(mockConstraints);
        setAgents(mockAgents);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return <Box display="flex" justifyContent="center" p={4}><CircularProgress /></Box>;

  return <ConstraintEnforcementView constraints={constraints} agents={agents} />;
};

export default ConstraintEnforcementContainer;
