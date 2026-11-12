/**
 * Tier border colours, resolved against the REAL theme.
 *
 * WHY THIS MODULE EXISTS (t_892465f7)
 *
 * The constraint ladder's five cards (T0-T4) each draw an accent border in
 * their tier's colour. That border was originally written as a CSS custom
 * property string -- a `var()` reference to a `--mui-palette-*` property.
 *
 * That form only resolves under MUI's `CssVarsProvider` + `experimental_
 * extendTheme`. This app uses a plain `createTheme` + `ThemeProvider`
 * (src/ui/src/index.js:15), so NO `--mui-palette-*` property is ever emitted
 * and the reference resolves to nothing. The border then fell back to the
 * Card's own hairline, which means all five tier borders had been rendering
 * in the same default colour since the component was written: the accent the
 * code intended to draw was carried by nothing, and nothing failed.
 *
 * The repair is to resolve the colour through the real theme object. This
 * module holds that resolution so it can be TESTED WITHOUT A RENDER, and so
 * the fallback is defined once rather than per call site.
 *
 * WHY IT IS HERE AND NOT IN theme.js: this module imports nothing and takes
 * the theme as an argument, so it is importable from both the ESM UI tree and
 * the CommonJS `node --test` suite without a babel bridge (the UI is a
 * separate deployable whose @mui/* does not resolve from the repo root --
 * see helpers/ui-esm.js and helpers/ui-real-theme.js). Same split the
 * sibling domainAliases.js and severityRamp.js use.
 *
 * WHY THE FALLBACK IS LOUD
 *
 * A missing palette key is a PROGRAMMING ERROR, not a design state: the
 * ladder names its tokens and the theme is expected to hold them. Silently
 * rendering the default hairline is exactly the failure this module exists
 * to end -- it is what made the original defect invisible for so long. So an
 * unknown key warns and falls back to a VISIBLE token rather than producing
 * an undefined border colour, and the guard test asserts both halves.
 */

/**
 * The token an unknown tier colour falls back to.
 *
 * `palette.divider` is the Card's own outline colour, so the fallback is a
 * border that is actually visible -- never `transparent`, never `undefined`.
 * A tier whose colour token is missing therefore renders a real (if
 * unremarkable) border instead of an invisible one.
 */
export const TIER_BORDER_FALLBACK_TOKEN = 'divider';

/**
 * Palette keys already warned about.
 *
 * The resolver runs inside a render, so an unguarded warning would repeat
 * once per tier per frame and bury the signal it is meant to raise. Warn
 * ONCE per key: the first occurrence is the diagnostic, the rest are
 * consequences of it.
 */
const warned = new Set();

/** Clear the warn-once memory. Exported for the guard test only. */
export function resetTierBorderWarnings() {
  warned.clear();
}

/** A usable CSS colour: a non-empty string. */
const isCssColour = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Resolve a tier's palette token to a concrete CSS colour.
 *
 * Accepts the three shapes a palette entry can take:
 *   - a colour RAMP (`{ main, light, dark }`) -> `main`;
 *   - a FLAT colour string (`divider`) -> the string itself;
 *   - a MISSING key -> the visible fallback, with a warning.
 *
 * @param {object} theme a resolved MUI theme
 * @param {string} colorKey the palette key the tier names
 * @returns {string} a CSS colour, never undefined
 */
export function resolveTierBorder(theme, colorKey) {
  const palette = (theme && theme.palette) || {};

  // hasOwnProperty, not a bare lookup: a bare lookup would resolve
  // inherited Object.prototype members ('constructor', 'toString') to a
  // function, which is not a colour and would defeat the fallback.
  const entry = Object.prototype.hasOwnProperty.call(palette, colorKey)
    ? palette[colorKey]
    : undefined;

  if (entry && typeof entry === 'object' && isCssColour(entry.main)) {
    return entry.main;
  }
  if (isCssColour(entry)) {
    return entry;
  }

  // Loud, not silent: the original defect was a colour reference that
  // resolved to nothing and nobody noticed for the life of the component.
  if (!warned.has(colorKey)) {
    warned.add(colorKey);
    console.warn(
      `[tierBorder] no palette token named "${colorKey}"; `
      + `falling back to ${TIER_BORDER_FALLBACK_TOKEN}`,
    );
  }

  const fallback = palette[TIER_BORDER_FALLBACK_TOKEN];
  return isCssColour(fallback) ? fallback : 'transparent';
}
