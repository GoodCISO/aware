import React, { useState } from 'react';
import { Box, Typography, Card, CardContent, TextField, Button, Chip, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Pagination } from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import CallMadeIcon from '@mui/icons-material/CallMade';
import CallReceivedIcon from '@mui/icons-material/CallReceived';
import DecisionIcon from '@mui/icons-material/Gavel';
import SearchIcon from '@mui/icons-material/Search';
import FilterListIcon from '@mui/icons-material/FilterList';

const AuditTrailViewer = ({ decisions = [], routingLogs = {} }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  const filtered = decisions.filter((d) => {
    const matchesSearch = !searchQuery ||
      d.agentName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.decision?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.id?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filterType === 'all' || d.type === filterType;
    return matchesSearch && matchesType;
  });

  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  const getDecisionIcon = (type) => {
    switch (type) {
      case 'request': return <CallMadeIcon />;
      case 'response': return <CallReceivedIcon />;
      case 'decision': return <DecisionIcon />;
      default: return <HistoryIcon />;
    }
  };

  const getDecisionColor = (type) => {
    switch (type) {
      case 'request': return 'primary';
      case 'response': return 'info';
      // `decision` is a NOMINAL peer of request/response here, not an
      // ordinal rank, so it gets its own alias rather than borrowing the
      // token that means "T3 of the constraint ladder" (palette.constraintT3).
      // Sharing one token is what conflated a categorical choice with a rank.
      case 'decision': return 'auditDecision';
      default: return 'grey';
    }
  };

  return (
    <Box>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={600} gutterBottom>Audit Trail Viewer</Typography>
        <Typography variant="body2" color="text.secondary">Decision chain traceability and observable routing decisions</Typography>
      </Box>

      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" gap={2} flexWrap="wrap">
            <TextField
              placeholder="Search audit trail..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{ startAdornment: <SearchIcon sx={{ mr: 1, color: 'text.secondary' }} /> }}
              sx={{ flex: 1, minWidth: 250 }}
              size="small"
            />
            <Box display="flex" gap={1}>
              {['all', 'request', 'response', 'decision'].map((t) => (
                <Button
                  key={t}
                  size="small"
                  variant={filterType === t ? 'contained' : 'outlined'}
                  onClick={() => setFilterType(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </Button>
              ))}
            </Box>
          </Box>
        </CardContent>
      </Card>

      <Box display="flex" flexDirection="column" gap={1} mb={2}>
        {paginated.map((decision) => (
          <Card key={decision.id} variant="outlined">
            <CardContent sx={{ py: 1.5 }}>
              <Box display="flex" alignItems="flex-start" gap={2}>
                <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: 'primary.main', flexShrink: 0, mt: 0.5 }}>
                  {getDecisionIcon(decision.type)}
                </Box>
                <Box flex={1}>
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={0.5}>
                    <Typography variant="subtitle2" fontWeight={600}>{decision.decision}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(decision.timestamp).toLocaleString()}
                    </Typography>
                  </Box>
                  <Box display="flex" gap={1} flexWrap="wrap" mb={1}>
                    <Chip label={decision.type} size="small" color={getDecisionColor(decision.type)} />
                    <Chip label={`Agent: ${decision.agentName || decision.agentId}`} size="small" variant="outlined" />
                    {decision.routedTo && <Chip label={`Routed: ${decision.routedTo}`} size="small" variant="outlined" />}
                  </Box>
                  <Typography variant="body2" color="text.secondary">{decision.reasoning}</Typography>
                </Box>
              </Box>
            </CardContent>
          </Card>
        ))}
      </Box>

      {filtered.length > perPage && (
        <Box display="flex" justifyContent="center">
          <Pagination
            count={Math.ceil(filtered.length / perPage)}
            page={page}
            onChange={(e, v) => setPage(v)}
            color="primary"
          />
        </Box>
      )}
    </Box>
  );
};

export default AuditTrailViewer;
