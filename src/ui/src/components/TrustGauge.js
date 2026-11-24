/**
 * TrustGauge — the ONE trust-gauge component in the UI.
 *
 * It exists because the agent screen (AgentIdentityDashboard.js) already had
 * a trust gauge and this screen needed one too, and a second copy is how two
 * screens end up disagreeing about what "low trust" looks like. This
 * component is EXTRACTED from that gauge, not invented: the agent screen's
 * own cut points (>80 high, >50 medium, else low) and its own colour
 * mapping (success / warning / error) are preserved exactly, so switching
 * AgentIdentityDashboard over to it is a ZERO-VISUAL-CHANGE.
 *
 * `entityKind` is the parameter the card's AC4 asks for:
 *
 *   entityKind="agent"    the unit is a 0..100 TRUST score (NHI). Colour is
 *                          success / warning / error, per the agent screen's
 *                          existing behaviour. NOTE: the STORED trust score
 *                          is a fraction in [0,1]; the call site converts with
 *                          `normaliseTrustScore(...) * 100` before passing it
 *                          here. This component's own unit remains 0..100.
 *   entityKind="operator" the unit is a 0..1 ANOMALY score (OHI). Colour is
 *                          INVERTED: a high anomaly score is a BAD operator,
 *                          so the ramp runs the other way.
 *
 * The two units cannot share one threshold function, so the band is chosen
 * by entityKind and passed in as `band`. The colour is then derived from
 * the band, and the band -> colour mapping lives here so both screens agree.
 *
 * THE BAR ENCODES TRUST IN BOTH MODES (t_cf4bcef5).
 *
 * The COLOUR was inverted for operators (the parent card t_1980c9b1 did
 * that), but the BAR GEOMETRY was not: the fill was computed from the raw
 * anomaly score, so the bar grew as the operator got WORSE. The result was
 * a meter whose shape contradicted its own colour -- a BLOCKED operator
 * (anomaly 0.95) rendered as a FULL red bar, which a glance reads as "great
 * operator" because the AGENT screen uses the same component and there a
 * full bar DOES mean great. One shared component, two screens, and the bar
 * length meant opposite things in each.
 *
 * So for an operator the fill is `1 - anomaly`: a full bar means the same
 * thing on both screens, and the bar agrees with the colour it is drawn
 * with. The band, its cut points and the OHI/NHI vocabulary are untouched;
 * only the geometry moved. The sparkline is deliberately NOT changed -- it
 * plots the raw anomaly score on its own labelled 0..1 axis, which is
 * correct and self-describing.
 *
 * `gaugeFillPercent` is exported so the direction is TESTABLE as behaviour
 * rather than only as source text. Every guard that existed for this
 * component was a source-text scan, which cannot see the meaning of a
 * number -- that is how the backwards gauge shipped with every guard green.
 *
 * COLOUR SOURCE. The colours are MUI palette token NAMES ("success",
 * "warning", "error"), never hex literals. The theme resolves them; a hex
 * here would freeze the colour and break the token-discipline guards in
 * test/unit/ui/token-literals.test.js.
 *
 * The card's AC5 names `--color-trust-high/medium/low` as the tokens to
 * reuse. Those CSS custom properties exist only in the archived S1
 * DESIGN.md -- they were never implemented as MUI theme tokens in this
 * repo, and there is no CSS-custom-property layer to read them from (the
 * theme is JS; the stylesheet is a base reset). The governed equivalent
 * here is the theme's semantic palette: `success` / `warning` / `error`,
 * which are the three colours the trust ramp has always been made of in
 * this UI. See the note in the task card's comment for the full account.
 */

import React from 'react';
import { Box, LinearProgress, Tooltip, Typography } from '@mui/material';

import { TRUST_BAND_HIGH, TRUST_BAND_LOW, TRUST_BAND_MEDIUM } from '../constants/operators';

/**
 * Band -> MUI palette token name. Flat keys: Chip and SvgIcon resolve
 * `theme.palette[color]` without traversing a dotted path.
 */
export const BAND_COLOR = {
  [TRUST_BAND_HIGH]: 'success',
  [TRUST_BAND_MEDIUM]: 'warning',
  [TRUST_BAND_LOW]: 'error',
};

/**
 * The bar's fill, as a percentage of the track.
 *
 * The fill ALWAYS encodes TRUST, in both vocabularies:
 *
 *   agent     the value IS a trust score, so the fill is the score.
 *   operator  the value is an ANOMALY score, so the fill is `1 - anomaly`.
 *
 * Before this was inverted for operators, the fill was the raw anomaly
 * score, so a BLOCKED operator (anomaly 0.95) drew a FULL bar in the
 * colour of a LOW trust band. The shape of the meter then contradicted
 * its own colour -- and contradicted the AGENT screen, where the same
 * component draws a full bar for a GOOD agent.
 *
 * Exported so the direction is testable as behaviour. Every pre-existing
 * guard for this component was a source-text scan, and a source scan
 * cannot see the meaning of a number -- which is how the backwards gauge
 * shipped with the whole suite green.
 *
 * @param {number} value the score, in the unit implied by entityKind
 * @param {number} [max] the top of the scale (default 100)
 * @param {'agent'|'operator'} [entityKind] which vocabulary the score is in
 * @returns {number} 0..100
 */
export const gaugeFillPercent = (value, max = 100, entityKind = 'agent') => {
  // Number(null) is 0 and Number('') is 0, so a MISSING score would coerce
  // to "no anomaly" and invert into a FULL bar for an operator. An absent
  // score is an unreadable score, not a zero score: it renders an EMPTY
  // bar, the same way it bands as LOW trust (constants/operators.js
  // bandForAnomalyScore). Guard the empty cases before coercing.
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  const safeMax = Number(max) > 0 ? Number(max) : 100;
  if (!Number.isFinite(numeric)) return 0;

  // An operator's score is an ANOMALY score: higher means WORSE. The bar
  // fills with TRUST, so it is the inverse. Clamping happens AFTER the
  // inversion, so an anomaly of 0 (a perfect match of the operator's
  // baseline) is a full bar and an anomaly of 1 is an empty one.
  const filled = entityKind === 'operator'
    ? safeMax - numeric
    : numeric;

  return Math.min(100, Math.max(0, (filled / safeMax) * 100));
};

/**
 * A labelled trust gauge.
 *
 * @param {object} props
 * @param {number} props.value the score, in the unit implied by entityKind
 * @param {number} [props.max] the top of the scale (default 100)
 * @param {'high'|'medium'|'low'} props.band the trust band
 * @param {'agent'|'operator'} [props.entityKind] which vocabulary the score is in
 * @param {string} [props.label] tooltip text
 * @param {string} [props.valueLabel] the numeric readout beside the gauge
 */
const TrustGauge = ({ value, max = 100, band, entityKind = 'agent', label, valueLabel }) => {
  const color = BAND_COLOR[band] || 'error';
  const pct = gaugeFillPercent(value, max, entityKind);

  const tooltip = label || `Trust band: ${band}`;

  return (
    <Box display="flex" alignItems="center" gap={1}>
      <Tooltip title={tooltip}>
        <Box width={120}>
          <LinearProgress
            variant="determinate"
            value={pct}
            color={color}
            aria-label={tooltip}
            sx={{ height: 8, borderRadius: 4 }}
          />
        </Box>
      </Tooltip>
      {valueLabel ? (
        <Typography variant="body2" fontFamily="monospace" color="text.secondary">
          {valueLabel}
        </Typography>
      ) : null}
      {entityKind === 'operator' ? (
        <Typography variant="caption" color="text.secondary">
          {band}
        </Typography>
      ) : null}
    </Box>
  );
};

export default TrustGauge;
