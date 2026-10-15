import { alpha, createTheme } from '@mui/material/styles';

import { AUDIT_DECISION, CONSTRAINT_T3, METRIC_VALUE } from './domainAliases';
import { SEVERITY_RAMP } from './severityRamp';

// Alpha-tint family. These rgba() literals were previously hand-decoded in
// AppHeader.js and AppSidebar.js, so the tints could not follow the tokens
// they were derived from: AppSidebar's `rgba(0, 229, 255, 0.1)` is
// primary.main at 10% alpha, but if primary.main moved the tint would not
// follow it. Built from the palette below with MUI's alpha() so each entry
// stays derived from its source token. Consumed as `theme.palette.overlay.*`.
// A #hex scan cannot see rgba() and this is why: a 0-hit rgba() grep over the
// component tree is a broken scan, not a clean component tree.
const OVERLAY = {
  // Hover wash on a dark surface (was rgba(255,255,255,0.05) in 3 places).
  hover: alpha('#ffffff', 0.05),
  // Hairline divider between dark surfaces (was rgba(255,255,255,0.08)).
  divider: alpha('#ffffff', 0.08),
  // Stronger hairline: the AppBar bottom border (was rgba(255,255,255,0.1)).
  dividerStrong: alpha('#ffffff', 0.1),
  // Brand tint for the active nav item — derived from primary, not hand-coded.
  active: alpha('#00e5ff', 0.1),
};

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#00e5ff',
      light: '#6effff',
      dark: '#00b2cc',
    },
    secondary: {
      // Was #7c4dff, which measures 2.84:1 on background.paper and so fails
      // WCAG AA for body text. #a180ff measures 4.58:1 on paper and 5.95:1 on
      // background.default. This is the one change in this commit that is NOT
      // zero-visual-change — it is a deliberate, measured contrast fix, and it
      // is the value the three domain aliases below were derived against, so
      // landing them apart would leave the aliases shadowing a value no longer
      // in the theme.
      main: '#a180ff', // 4.58:1 on paper, 5.95:1 on default — AA body text
      light: '#d6c7ff',
      dark: '#8f6fff',
    },
    // Explicit `info` ramp, declared at exactly MUI v5.18's own resolved
    // defaults so this is GOVERNANCE ONLY and provably zero-visual-change.
    //
    // Why declare it at all: `palette.info` was UNDECLARED, so it resolved to
    // a third-party default that can move under the product on any MUI
    // upgrade. Governance is the fix; re-hue is a separate, deliberate act.
    // Verified against the real createTheme: an undeclared `info` resolves to
    // these exact three values, so declaring them changes no rendered pixel.
    //
    // Why it stays in MUI's blue family (hue ~198.7deg) and is NOT folded into
    // the severity ramp: `info` is NOMINAL — AuditTrailViewer's
    // request/response/decision peers, which have no inherent order — whereas
    // `severity` is ORDINAL. A nominal value and an ordinal step that happen to
    // share a hue family are indistinguishable, which is how a ramp stops
    // reading as a ramp. The cyan family stays reserved for the ordinal ramp.
    info: {
      main: '#29b6f6',
      light: '#4fc3f7',
      dark: '#0288d1',
    },
    error: {
      main: '#ff1744',
      light: '#ff616f',
      dark: '#c5001e',
      // PINNED, and this is the only fill whose derived label failed AA.
      // MUI's contrastThreshold derivation resolves rgba(0,0,0,0.87) for the
      // other five semantic fills and #fff for red ALONE -- red is the sole
      // outlier in the derived family, and the sole failure: white on #ff1744
      // is 3.85:1, below the 4.5:1 text bar, and it renders (Chip color="error"
      // in KillSwitchControls.js, the alert Badge in AppHeader.js, and seven
      // more components).
      //
      // Pinning the DERIVED value is the fix; darkening the fill is not. The
      // fill does double duty -- label background AND border/icon accent -- so
      // it owes 4.5:1 to its label and 3.0:1 to each surface. #d32f2f fixes
      // the label (4.98:1) and breaks the surface use (2.74:1 on paper).
      // Pinning contrastText fixes the label (5.05:1) and leaves #ff1744 --
      // and therefore every border, icon and outline using it -- untouched.
      //
      // Guarded for the whole derived family, not just this slot, by
      // test/unit/ui/fill-contrast.test.js.
      contrastText: 'rgba(0, 0, 0, 0.87)',
    },
    warning: {
      main: '#ff9100',
      light: '#ffc246',
      dark: '#c56200',
    },
    success: {
      main: '#00e676',
      light: '#6effa6',
      dark: '#00b248',
    },
    // Muted foreground for de-emphasised / unknown-status UI. Was a hardcoded
    // magic number in StatusIndicator.js; promoted to a token. 6.85:1 on
    // background.default, 5.27:1 on background.paper — clears AA body text.
    text: {
      muted: '#90a4ae',
    },
    background: {
      default: '#0a1929',
      paper: '#132f4c',
    },
    // ORDINAL anomaly-severity ramp (4 levels), not a categorical set.
    // Severity is an ordered quantity, so the ramp is a single hue at
    // monotonically descending lightness: contrast against the dark surfaces
    // descends with it, so the ORDER survives greyscale, forced-colors mode,
    // and for any viewer who cannot separate hues. Measurement, gamut
    // ceiling, and the known 4th-level limit are documented in
    // ./severityRamp.js and re-verified by test/unit/ui/severity-ramp.test.js.
    //
    // NAMING (settled 2026-10-07, designer): `severity` is the ANOMALY axis
    // and keeps this name. It is the axis the API wire contract speaks —
    // src/monitoring/severity-contract.js normalises to CRITICAL|HIGH|MEDIUM|
    // LOW — so the UI reads the API's own nouns rather than a second
    // vocabulary. The T0..T4 constraint ladder is a DIFFERENT axis (how much
    // supervision an agent is under, per ADR-058) and must never share this
    // lookup path; one name for two axes is precisely how a lookup returns
    // undefined for every consumer.
    severity: { ...SEVERITY_RAMP },
    overlay: OVERLAY,
    // Named per-domain aliases, so the semantic domains that used to share
    // `secondary` can be re-hued independently (t_6839c54a). Byte-identical
    // to secondary today, so this introduces no visual difference; what it
    // fixes is blast radius. Keys MUST stay flat — Chip and SvgIcon resolve
    // `theme.palette[color]` without traversing a dotted path. Pinned by
    // test/unit/ui/domain-aliases.test.js.
    constraintT3: CONSTRAINT_T3,
    metricValue: METRIC_VALUE,
    auditDecision: AUDIT_DECISION,
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h4: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          borderRadius: 12,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
  },
});

export default theme;