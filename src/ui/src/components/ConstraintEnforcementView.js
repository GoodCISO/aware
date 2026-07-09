import React from 'react';
import { Box, Typography, Card, CardContent, Chip, LinearProgress, Button, Tooltip } from '@mui/material';
import SecurityIcon from '@mui/icons-material/Security';
import WarningIcon from '@mui/icons-material/Warning';

const CONSTRAINT_LEVELS = [
  { id: 'T0', name: 'Audit Trail',     desc: "Every action is logged — foundational, always on", color: 'info' },
  { id: 'T1', name: 'Crypto Identity', desc: "Every agent gets a non-human identity it can't fake — foundational, always on", color: 'info' },
  { id: 'T2', name: 'Guardrailed',     desc: 'Operational policies constrain what the agent can do', color: 'warning' },
  { id: 'T3', name: 'Policy-Driven',   desc: 'Advanced governance — rate limits, decision routing', color: 'secondary' },
  { id: 'T4', name: 'Autonomous',      desc: 'Full self-operation under declared constraints', color: 'success' },
];

const ConstraintEnforcementView = ({ constraints = [], agents = [] }) => {
  const getAgentCount = (levelId) =>
    agents.filter((a) => (a.constraintLevel || 'T2') === levelId).length;

  const getEnforcementRate = (levelId) => {
    const total = getAgentCount(levelId);
    const enforced = constraints.filter(
      (c) => c.level === levelId && c.status === 'enforced'
    ).length;
    return total > 0 ? Math.round((enforced / total) * 100) : 0;
  };

  return (
    <Box>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={600} gutterBottom>
          Constraint Enforcement
        </Typography>
        <Typography variant="body2" color="text.secondary">
          T0–T4 constraint tiers control what agents are permitted to do
        </Typography>
      </Box>

      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(320px, 1fr))" gap={2}>
        {CONSTRAINT_LEVELS.map((level) => {
          const count = getAgentCount(level.id);
          const rate = getEnforcementRate(level.id);
          return (
            <Card key={level.id} variant="outlined" sx={{ borderColor: `var(--mui-palette-${level.color}-main)` }}>
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                  <Chip label={level.id} color={level.color} size="small" />
                  <Typography variant="h6">{count}</Typography>
                </Box>
                <Typography variant="subtitle1" fontWeight={600}>{level.name}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {level.desc}
                </Typography>
                <Box mb={1}>
                  <Typography variant="caption" color="text.secondary">
                    Enforcement: {rate}%
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={rate}
                    color={rate > 90 ? 'success' : rate > 70 ? 'warning' : 'error'}
                    sx={{ height: 6, borderRadius: 3, mt: 0.5 }}
                  />
                </Box>
                {rate < 100 && (
                  <Button size="small" startIcon={<WarningIcon />} color="warning" variant="text">
                    {100 - rate} agents not enforced
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </Box>
    </Box>
  );
};

export default ConstraintEnforcementView;
