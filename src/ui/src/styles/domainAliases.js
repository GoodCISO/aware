/**
 * Domain colour aliases (t_6839c54a).
 *
 * `secondary.main` was a single token serving three unrelated semantic
 * domains: an ORDINAL constraint tier, a dashboard KPI value, and a NOMINAL
 * audit-trail chip axis. The hex was correct on every one of them, so this
 * module changes no pixels -- what it fixes is blast radius. A future re-hue
 * of any one domain can no longer silently re-tint the other two.
 *
 * This lives outside theme.js, and imports nothing, for two reasons:
 *   - theme.js must stay the only module that talks to MUI;
 *   - the test suite runs under `node --test` from the repo root, where
 *     @mui/* does not resolve (the UI is a separate deployable with its own
 *     node_modules). A pure data module is importable from both.
 *     Same split the sibling severity ramp uses.
 */

/** The token every alias shadows. Contrast figures are WCAG 2.x, dark surfaces. */
export const SECONDARY = {
  // 4.58:1 on background.paper, 5.95:1 on background.default — AA body text.
  main: '#a180ff',
  light: '#d6c7ff',
  dark: '#8f6fff',
  // Pinned explicitly rather than left to MUI's auto-derivation. MUI computes
  // this field only for its six built-in colour names (createPalette.js), so a
  // custom palette key receives `contrastText: undefined` — and Chip calls
  // alpha() on it (Chip.js:167), which throws during render. This is the same
  // value MUI derives for `secondary` in dark mode (text.primary), which is
  // what keeps an alias byte-identical to the token it shadows.
  contrastText: 'rgba(0, 0, 0, 0.87)',
};

// ORDINAL domain — the T0..T4 constraint ladder's T3 "Guardrailed" step.
// Ordinal, not nominal: its neighbours in the ranking are `info` (T1) and
// `warning` (T2), and its meaning comes from its position, not its hue. Do NOT
// repoint this at a generic accent; if the ladder is ever rebuilt on a single
// hue (design item D2), this alias moves with the rest of the ramp.
export const CONSTRAINT_T3 = { ...SECONDARY };

// Domain 2 — the "Constraints Enforced" dashboard KPI: its h4 value text and
// its Gavel icon. A display value, not a rank and not a category.
export const METRIC_VALUE = { ...SECONDARY };

// NOMINAL domain — the audit trail's request / response / decision / other chip
// axis. Categorical: the four members are peers with no inherent order, and
// "decision" is violet only by historical accident. This is the alias that
// matters most, because sharing the tier's token is what conflated a
// categorical choice with an ordinal rank.
export const AUDIT_DECISION = { ...SECONDARY };

/**
 * The three aliases by the name components pass to MUI's `color` prop, plus
 * the domain each one owns. Keys are the palette paths consumed at render.
 *
 * Shape constraint, verified against MUI 5.18 by rendering: these MUST be
 * FLAT keys. Chip (Chip.js:168) and SvgIcon (SvgIcon.js:60) resolve
 * `theme.palette[color]`, so a nested `constraint.t3` is looked up as a
 * single literal key and resolves to undefined. The flat names encode the
 * domain in the identifier instead.
 */
export const DOMAIN_ALIASES = {
  constraintT3: CONSTRAINT_T3,
  metricValue: METRIC_VALUE,
  auditDecision: AUDIT_DECISION,
};

/** Ordinal vs nominal, for the test that guards the distinction. */
export const DOMAIN_KIND = {
  constraintT3: 'ordinal',
  metricValue: 'nominal',
  auditDecision: 'nominal',
};
