/**
 * OperatorSparkline — the operator's score-over-time trace.
 *
 * A rolling sparkline of one operator's recorded scores, oldest first.
 * Charts are Recharts (already in src/ui's dependencies; DESIGN.md §9 rule 4
 * names it as the charting library).
 *
 * COLOUR. The line and the area fill take their colour from the OPERATOR's
 * current trust band, passed in as `band` and resolved through the shared
 * TrustGauge's BAND_COLOR map. That way the sparkline and the list gauge
 * for the same operator can never disagree about colour, and no hex
 * literal appears in this file (the token-discipline guards in
 * test/unit/ui/token-literals.test.js forbid hex literals in the component
 * tree).
 *
 * WHY THE COLOUR IS THE BAND, NOT THE SERIES. The operator's score is an
 * ANOMALY score -- high means the operator is off their baseline and the
 * gateway is holding or blocking their message. So the trace is coloured by
 * how the operator is doing NOW (their most recent band), and the shape of
 * the line shows the history. A trace coloured per-point would flash green
 * on an operator who is currently being blocked.
 *
 * AXIS LABELS. DESIGN.md §9 rule 4 requires axis labels and units on
 * charts. The Y axis is labelled with the score's unit (anomaly score,
 * 0..1); the X axis is the sample timestamp.
 */

import React from 'react';
import { Box, Typography } from '@mui/material';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { BAND_COLOR } from '../../components/TrustGauge';
import { formatScore, formatTimestamp } from '../../constants/operators';

// Axis tick styling. No `fontSize` here on purpose: a bare number in a
// typography prop is a hand-copied length (the F5 guard in
// test/unit/ui/token-literals.test.js forbids it), and the theme owns the
// axis scale.
const AXIS_TICK_STYLE = {};

/**
 * @param {object} props
 * @param {object[]} props.samples ascending-by-time observations
 * @param {'high'|'medium'|'low'} props.band the operator's CURRENT trust band
 */
const OperatorSparkline = ({ samples = [], band }) => {
  const color = BAND_COLOR[band] || 'error';
  const data = samples.map((sample) => ({
    ts: sample.createdAt,
    score: Number.isFinite(sample.score) ? sample.score : null,
    label: formatTimestamp(sample.createdAt),
  }));

  if (data.length === 0) {
    return (
      <Box py={2}>
        <Typography variant="body2" color="text.secondary">
          No score history for this operator yet.
        </Typography>
      </Box>
    );
  }

  return (
    <Box width="100%" height={220}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
          <defs>
            <linearGradient id="operatorScoreFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="ts"
            tickFormatter={formatTimestamp}
            tick={{ ...AXIS_TICK_STYLE }}
            stroke="text.secondary"
          />
          <YAxis
            domain={[0, 1]}
            tick={{ ...AXIS_TICK_STYLE }}
            stroke="text.secondary"
            label={{
              value: 'anomaly score (0-1)',
              angle: -90,
              position: 'insideLeft',
              style: { ...AXIS_TICK_STYLE, fill: 'currentColor' },
            }}
          />
          <Tooltip
            formatter={(value) => formatScore(value)}
            labelFormatter={(_, payload) =>
              payload && payload.length ? payload[0].payload.label : ''
            }
          />
          <Area
            type="monotone"
            dataKey="score"
            stroke={color}
            strokeWidth={2}
            fill="url(#operatorScoreFill)"
            connectNulls
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
};

export default OperatorSparkline;
