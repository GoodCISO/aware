/**
 * OperatorList — the OHI operators table.
 *
 * One row per operator, with that operator's current trust gauge, their
 * most-recent recorded score, and when they were last scored. Selecting a
 * row opens the operator's detail view.
 *
 * DATA. Rows come from the v1 diary table (GET /api/diary/entries). The
 * table has no operator column -- the v0 producer stringifies its payload
 * into `content` -- so the operator identity and score are parsed out of
 * that JSON by src/ui/src/constants/operators.js.
 *
 * COLOUR. The gauge reuses the shared TrustGauge component, so this screen
 * cannot drift from the agent screen's gauge. No hex literals appear here.
 *
 * MONO. Operator IDs are identifiers, so they are rendered in a mono font
 * (DESIGN.md §7 "Use mono font for any identifier").
 */

import React from 'react';
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Typography,
} from '@mui/material';

import TrustGauge from '../../components/TrustGauge';
import { formatScore, formatTimestamp } from '../../constants/operators';

/**
 * @param {object} props
 * @param {object[]} props.records operator records, most-recently-scored first
 * @param {string|null} props.selectedOperatorId the open operator
 * @param {(id: string) => void} props.onSelect
 */
const OperatorList = ({ records = [], selectedOperatorId = null, onSelect }) => {
  if (!records || records.length === 0) {
    return (
      <Box py={3}>
        <Typography variant="body2" color="text.secondary">
          No operator scores recorded yet. The OHI scorer populates this list
          once it has scored an operator.
        </Typography>
      </Box>
    );
  }

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Operator</TableCell>
            <TableCell>Trust</TableCell>
            <TableCell>Score</TableCell>
            <TableCell>Last Action</TableCell>
            <TableCell>Last Scored</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((record) => {
            const isSelected = record.operatorId === selectedOperatorId;
            return (
              <TableRow
                key={record.operatorId}
                hover
                selected={isSelected}
                onClick={() => onSelect && onSelect(record.operatorId)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell>
                  <Typography variant="body2" fontFamily="monospace">
                    {record.operatorId}
                  </Typography>
                </TableCell>
                <TableCell>
                  <TrustGauge
                    value={record.latestScore}
                    max={1}
                    band={record.latestBand}
                    entityKind="operator"
                    label={`Operator ${record.operatorId}: ${record.latestBand} trust`}
                    valueLabel={formatScore(record.latestScore)}
                  />
                </TableCell>
                <TableCell>
                  <Typography variant="body2" fontFamily="monospace">
                    {formatScore(record.latestScore)}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" color="text.secondary">
                    {record.samples.length
                      ? record.samples[record.samples.length - 1].action || '--'
                      : '--'}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">
                    {formatTimestamp(record.latestCreatedAt)}
                  </Typography>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

export default OperatorList;
