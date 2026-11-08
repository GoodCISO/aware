import React from 'react';
import { Box, Typography } from '@mui/material';
import CircleIcon from '@mui/icons-material/Circle';

const StatusIndicator = ({ status, label }) => {
  const getColor = (s) => {
    switch (s?.toLowerCase()) {
      case 'active':
      case 'compliant':
      case 'trusted':
        return 'success';
      case 'warning':
      case 'degraded':
      case 'suspended':
        return 'warning';
      case 'revoked':
      case 'critical':
      case 'shutdown':
        return 'error';
      default:
        return 'text.secondary';
    }
  };

  // getColor() already returns a THEME TOKEN NAME, so sx can consume it
  // directly. The previous colorMap translated those names back into
  // hand-copied hexes of the very tokens they named -- a lookup that could
  // only ever return a stale value once the theme moved. The 10px CircleIcon
  // is a non-text indicator, so the applicable bar is 3:1 (WCAG 1.4.11) and
  // all four tokens clear it; this is token discipline, not an a11y fix.
  const color = getColor(status);

  return (
    <Box display="flex" alignItems="center" gap={1}>
      <CircleIcon sx={{ fontSize: 10, color }} />
      <Typography variant="body2" color="text.secondary">
        {label || status}
      </Typography>
    </Box>
  );
};

export default StatusIndicator;
