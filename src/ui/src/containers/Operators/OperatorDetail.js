/**
 * OperatorDetail — one operator's trust detail view.
 *
 * Shows the operator's current trust gauge (same shared TrustGauge the list
 * uses), their score-over-time sparkline, and the raw sample history.
 *
 * THE GAUGE COLOUR IS THE OPERATOR'S CURRENT BAND. The sparkline's line
 * takes the same band, so the two can never disagree. An operator the
 * gateway is currently HOLDING must not render as high-trust, so the band
 * comes from the operator's MOST RECENT sample, not their best one.
 */

import React from 'react';
import {
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import TrustGauge from '../../components/TrustGauge';
import OperatorSparkline from './OperatorSparkline';
import { formatScore, formatTimestamp } from '../../constants/operators';

/**
 * @param {object} props
 * @param {object|null} props.record the operator record (null when unknown)
 */
const OperatorDetail = ({ record }) => {
  if (!record) {
    return (
      <Box py={3}>
        <Typography variant="body2" color="text.secondary">
          Select an operator to see their trust history.
        </Typography>
      </Box>
    );
  }

  const latest = record.samples.length ? record.samples[record.samples.length - 1] : null;

  return (
    <Box>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="flex-start"
        flexWrap="wrap"
        gap={2}
        mb={2}
      >
        <Box>
          <Typography variant="h6" fontFamily="monospace">
            {record.operatorId}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {record.samples.length} recorded sample{record.samples.length === 1 ? '' : 's'}
          </Typography>
        </Box>
        <Box>
          <TrustGauge
            value={record.latestScore}
            max={1}
            band={record.latestBand}
            entityKind="operator"
            label={`Operator ${record.operatorId}: ${record.latestBand} trust`}
            valueLabel={formatScore(record.latestScore)}
          />
        </Box>
      </Box>

      {latest && latest.action ? (
        <Box mb={2}>
          <Chip size="small" variant="outlined" label={`Last action: ${latest.action}`} />
        </Box>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          Score over time
        </Typography>
        <OperatorSparkline samples={record.samples} band={record.latestBand} />
      </Paper>

      <Typography variant="subtitle2" gutterBottom>
        Sample history
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Scored At</TableCell>
              <TableCell>Score</TableCell>
              <TableCell>Trust Band</TableCell>
              <TableCell>Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {record.samples
              .slice()
              .reverse()
              .map((sample, index) => (
                <TableRow key={`${sample.id || sample.createdAt}-${index}`}>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {formatTimestamp(sample.createdAt)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" fontFamily="monospace">
                      {formatScore(sample.score)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {sample.band}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {sample.action || '--'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

export default OperatorDetail;
