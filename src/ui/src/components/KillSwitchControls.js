import React, { useState } from 'react';
import { Box, Typography, Card, CardContent, Button, TextField, Dialog, DialogTitle, DialogContent, DialogActions, Alert, Chip, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper } from '@mui/material';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import BlockIcon from '@mui/icons-material/Block';
import RestoreIcon from '@mui/icons-material/Restore';
import WarningIcon from '@mui/icons-material/Warning';
import StatusIndicator from './StatusIndicator';
import { formatTrustScore } from '../constants/trust-score.js';

const KillSwitchControls = ({ agents = [], onRevoke, onRestore, onEmergencyShutdown }) => {
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [reason, setReason] = useState('');
  const [confirmAgent, setConfirmAgent] = useState('');

  const activeAgents = agents.filter((a) => a.status !== 'revoked' && a.status !== 'shutdown');
  const revokedAgents = agents.filter((a) => a.status === 'revoked' || a.status === 'shutdown');

  const handleRevoke = () => {
    if (selectedAgent && reason) {
      onRevoke?.(selectedAgent.id, reason);
      setRevokeDialogOpen(false);
      setSelectedAgent(null);
      setReason('');
      setConfirmAgent('');
    }
  };

  const openRevoke = (agent) => {
    setSelectedAgent(agent);
    setRevokeDialogOpen(true);
  };

  return (
    <Box>
      <Box mb={3}>
        <Typography variant="h5" fontWeight={600} gutterBottom>Kill Switch Controls</Typography>
        <Typography variant="body2" color="text.secondary">Emergency revocation and shutdown of AI agents</Typography>
      </Box>

      <Alert severity="error" icon={<WarningIcon />} sx={{ mb: 3 }}>
        Kill switch actions are irreversible for 24 hours. A revoked agent loses all credentials and capabilities immediately.
      </Alert>

      <Typography variant="subtitle1" fontWeight={600} gutterBottom>Active Agents ({activeAgents.length})</Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Agent</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Trust Score</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {activeAgents.map((agent) => (
              <TableRow key={agent.id}>
                <TableCell>{agent.name}</TableCell>
                <TableCell><StatusIndicator status={agent.status} /></TableCell>
                <TableCell>{formatTrustScore(agent.declaredTrustScore)}</TableCell>
                <TableCell>
                  <Box display="flex" gap={1}>
                    <Button size="small" variant="outlined" color="warning" startIcon={<BlockIcon />} onClick={() => openRevoke(agent)}>
                      Revoke
                    </Button>
                    <Button size="small" variant="contained" color="error" startIcon={<PowerSettingsNewIcon />} onClick={() => onEmergencyShutdown?.(agent.id)}>
                      Emergency Stop
                    </Button>
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {revokedAgents.length > 0 && (
        <>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>Revoked Agents ({revokedAgents.length})</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Agent</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Revoked At</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {revokedAgents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>{agent.name}</TableCell>
                    <TableCell><Chip label={agent.status} color="error" size="small" /></TableCell>
                    <TableCell>{agent.revokedAt ? new Date(agent.revokedAt).toLocaleString() : '—'}</TableCell>
                    <TableCell>{agent.revokeReason || '—'}</TableCell>
                    <TableCell>
                      <Button size="small" startIcon={<RestoreIcon />} onClick={() => onRestore?.(agent.id)}>
                        Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <Dialog open={revokeDialogOpen} onClose={() => setRevokeDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Revoke Agent: {selectedAgent?.name}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This action will immediately revoke all credentials for {selectedAgent?.name}. The agent will no longer be able to operate.
          </Alert>
          <TextField
            fullWidth
            label="Revocation Reason"
            multiline
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            sx={{ mb: 2 }}
            required
          />
          <TextField
            fullWidth
            label={`Type "${selectedAgent?.name}" to confirm`}
            value={confirmAgent}
            onChange={(e) => setConfirmAgent(e.target.value)}
            required
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRevokeDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleRevoke}
            disabled={!reason || confirmAgent !== selectedAgent?.name}
          >
            Revoke Agent
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default KillSwitchControls;
