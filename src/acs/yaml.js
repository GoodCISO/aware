// src/acs/yaml.js
// A minimal YAML parser and renderer for ACS manifests.
//
// WHY NOT A YAML LIBRARY
// ----------------------
// The repository has deliberately kept its runtime dependency set small,
// and the task says not to add a heavy dependency without justification in
// DESIGN.md. An ACS manifest is a small, well-defined document: mappings,
// sequences, scalars, and quoted strings.
//
// THE FAIL-CLOSED RULE
// -------------------
// A parser that GUESSES is a parser that can change the meaning of a
// policy document. Anything this parser cannot read with certainty is
// REFUSED with an error, never guessed at.
//
// That means it refuses, rather than approximating:
//   - anchors and aliases (&x, *x)
//   - tags (!!str, !custom)
//   - multi-document streams (---)
//   - block scalars (|, >) with the chomping indicators
//   - flow collections spanning multiple lines
//   - a tab used for indentation
//
// The supported grammar is a strict SUBSET of YAML 1.2. A manifest that
// uses anything outside it is rejected, and the rejection says why.

'use strict';

/**
 * Raised when the YAML cannot be parsed with certainty.
 */
class YamlError extends Error {
  /**
   * @param {string} message - What went wrong.
   * @param {number} [line] - The 1-based line number.
   */
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/**
 * The YAML constructs this parser refuses, because guessing at them would
 * change a policy document's meaning.
 */
const REFUSED_CONSTRUCTS = [
  { pattern: /(^|\s)[&*][A-Za-z0-9_-]+/, what: 'anchors and aliases' },
  { pattern: /(^|\s)!!?[A-Za-z]/, what: 'tags' },
  { pattern: /^---/, what: 'multi-document streams' },
  { pattern: /:\s*[|>][-+]?\s*$/, what: 'block scalars' },
  { pattern: /:\s*[|>][-+]?[^|>]/, what: 'block scalars' },
];

/**
 * Parse a scalar value.
 *
 * @param {string} text - The scalar text.
 * @param {number} line - The line number, for errors.
 * @returns {*} The parsed value.
 * @throws {YamlError} When the scalar cannot be parsed with certainty.
 */
function parseScalar(text, line) {
  const trimmed = text.trim();

  if (trimmed === '') return '';
  if (trimmed === '~' || trimmed === 'null' || trimmed === 'Null' || trimmed === 'NULL') return null;
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true;
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false;

  // A quoted string is always a string.
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new YamlError(`the double-quoted string is not valid JSON: ${err.message}`, line);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    // A single-quoted YAML string escapes a quote by doubling it.
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  // An inline flow collection on a single line.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFlowSequence(trimmed, line);
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseFlowMapping(trimmed, line);
  }

  // A number.
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);

  // Anything else is a plain string.
  return trimmed;
}

/**
 * Split a flow sequence body on its top-level commas.
 *
 * @param {string} body - The body between the brackets.
 * @param {number} line - The line number.
 * @returns {string[]} The parts.
 */
function splitFlow(body, line) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) throw new YamlError('an unterminated quoted string', line);
  if (depth !== 0) throw new YamlError('an unbalanced flow collection', line);
  if (current.trim() !== '' || parts.length > 0) parts.push(current);
  return parts;
}

/**
 * Parse a single-line flow sequence.
 *
 * @param {string} text - The text, including the brackets.
 * @param {number} line - The line number.
 * @returns {Array} The parsed sequence.
 */
function parseFlowSequence(text, line) {
  const body = text.slice(1, -1).trim();
  if (body === '') return [];
  return splitFlow(body, line).map((part) => parseScalar(part, line));
}

/**
 * Parse a single-line flow mapping.
 *
 * @param {string} text - The text, including the braces.
 * @param {number} line - The line number.
 * @returns {Object} The parsed mapping.
 */
function parseFlowMapping(text, line) {
  const body = text.slice(1, -1).trim();
  const out = {};
  if (body === '') return out;
  for (const part of splitFlow(body, line)) {
    const idx = part.indexOf(':');
    if (idx === -1) throw new YamlError('a flow mapping entry has no colon', line);
    const key = String(parseScalar(part.slice(0, idx), line));
    out[key] = parseScalar(part.slice(idx + 1), line);
  }
  return out;
}

/**
 * Split a block line into its key and its value.
 *
 * @param {string} line - The line.
 * @param {number} lineNumber - The line number.
 * @returns {{key: string, value: string}} The key and the raw value.
 * @throws {YamlError} When the line has no key.
 */
function splitKey(line, lineNumber) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === line.length || line[i + 1] === ' ')) {
      const rawKey = line.slice(0, i).trim();
      if (rawKey === '') throw new YamlError('a mapping entry has an empty key', lineNumber);
      const key = rawKey.startsWith('"') || rawKey.startsWith("'")
        ? String(parseScalar(rawKey, lineNumber))
        : rawKey;
      return { key, value: line.slice(i + 1).trim() };
    }
  }
  throw new YamlError(`the line has no "key: value" form: ${line}`, lineNumber);
}

/**
 * Parse a YAML document into a JavaScript value.
 *
 * @param {string} text - The document.
 * @returns {*} The parsed value.
 * @throws {YamlError} When the document cannot be parsed with certainty.
 */
function parseSimpleYaml(text) {
  if (typeof text !== 'string') throw new YamlError('the document is not text');

  for (const refused of REFUSED_CONSTRUCTS) {
    if (refused.pattern.test(text)) {
      throw new YamlError(`this parser refuses ${refused.what}, and guessing at them could change a policy document's meaning`);
    }
  }

  const lines = text.split('\n');
  const parsedLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.includes('\t')) {
      throw new YamlError('a tab is used for indentation', i + 1);
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    parsedLines.push({ indent, text: raw.trim(), line: i + 1 });
  }

  if (parsedLines.length === 0) return null;

  const [value, consumed] = parseBlock(parsedLines, 0, parsedLines[0].indent);
  if (consumed < parsedLines.length) {
    throw new YamlError(
      `unexpected content at line ${parsedLines[consumed].line}`,
      parsedLines[consumed].line,
    );
  }
  return value;
}

/**
 * Parse a block at a given indentation.
 *
 * @param {Array} lines - The significant lines.
 * @param {number} start - The first line index.
 * @param {number} indent - The indentation of the block.
 * @returns {[*, number]} The value and the index after the block.
 */
function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  if (lines[start].text.startsWith('- ') || lines[start].text === '-') {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

/**
 * Parse a block mapping.
 *
 * @param {Array} lines - The significant lines.
 * @param {number} start - The first line index.
 * @param {number} indent - The indentation of the block.
 * @returns {[Object, number]} The mapping and the index after the block.
 */
function parseMapping(lines, start, indent) {
  const out = {};
  let i = start;

  while (i < lines.length) {
    const entry = lines[i];
    if (entry.indent < indent) break;
    if (entry.indent > indent) {
      throw new YamlError(`unexpected indentation at line ${entry.line}`, entry.line);
    }

    const { key, value } = splitKey(entry.text, entry.line);

    if (value === '') {
      // A nested block, or an empty value.
      const next = i + 1;
      if (next < lines.length && lines[next].indent > indent) {
        const [child, consumed] = parseBlock(lines, next, lines[next].indent);
        out[key] = child;
        i = consumed;
        continue;
      }
      if (next < lines.length && lines[next].indent === indent
        && (lines[next].text.startsWith('- ') || lines[next].text === '-')) {
        // A sequence at the SAME indentation as its key.
        const [child, consumed] = parseSequence(lines, next, indent);
        out[key] = child;
        i = consumed;
        continue;
      }
      out[key] = null;
      i += 1;
      continue;
    }

    out[key] = parseScalar(value, entry.line);
    i += 1;
  }

  return [out, i];
}

/**
 * Parse a block sequence.
 *
 * @param {Array} lines - The significant lines.
 * @param {number} start - The first line index.
 * @param {number} indent - The indentation of the block.
 * @returns {[Array, number]} The sequence and the index after the block.
 */
function parseSequence(lines, start, indent) {
  const out = [];
  let i = start;

  while (i < lines.length) {
    const entry = lines[i];
    if (entry.indent < indent) break;
    if (entry.indent > indent) {
      throw new YamlError(`unexpected indentation at line ${entry.line}`, entry.line);
    }
    if (!entry.text.startsWith('- ') && entry.text !== '-') break;

    const rest = entry.text === '-' ? '' : entry.text.slice(2).trim();
    const itemIndent = indent + 2;

    if (rest === '') {
      const next = i + 1;
      if (next < lines.length && lines[next].indent > indent) {
        const [child, consumed] = parseBlock(lines, next, lines[next].indent);
        out.push(child);
        i = consumed;
        continue;
      }
      out.push(null);
      i += 1;
      continue;
    }

    // `- key: value` starts a mapping whose first key is on the dash line.
    if (splitKeySafe(rest) !== null) {
      const synthetic = [{ indent: itemIndent, text: rest, line: entry.line }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= itemIndent) {
        synthetic.push(lines[j]);
        j += 1;
      }
      const [child] = parseMapping(synthetic, 0, itemIndent);
      out.push(child);
      i = j;
      continue;
    }

    out.push(parseScalar(rest, entry.line));
    i += 1;
  }

  return [out, i];
}

/**
 * Split a key off a line, returning null when there is no key.
 *
 * @param {string} line - The line.
 * @returns {Object|null} The split, or null.
 */
function splitKeySafe(line) {
  try {
    return splitKey(line, 0);
  } catch (err) {
    return null;
  }
}

/**
 * Render a JavaScript value as YAML.
 *
 * @param {*} value - The value.
 * @param {number} [indent] - The current indentation.
 * @returns {string} The YAML text.
 */
function renderYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return renderScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts = value.map((item) => {
      if (isPlainObject(item) || Array.isArray(item)) {
        const rendered = renderYaml(item, indent + 2);
        return `${pad}- ${rendered.trimStart()}`;
      }
      return `${pad}- ${renderYaml(item)}`;
    });
    return parts.join('\n');
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const parts = [];
    for (const key of keys) {
      const child = value[key];
      if (isPlainObject(child) && Object.keys(child).length > 0) {
        parts.push(`${pad}${renderKey(key)}:`);
        parts.push(renderYaml(child, indent + 2));
      } else if (Array.isArray(child) && child.length > 0) {
        parts.push(`${pad}${renderKey(key)}:`);
        parts.push(renderYaml(child, indent + 2));
      } else {
        parts.push(`${pad}${renderKey(key)}: ${renderYaml(child, indent)}`);
      }
    }
    return parts.join('\n');
  }
  return 'null';
}

/**
 * Test whether a value is a plain object.
 *
 * @param {*} value - The value.
 * @returns {boolean} True when it is a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Render a mapping key.
 *
 * @param {string} key - The key.
 * @returns {string} The rendered key.
 */
function renderKey(key) {
  if (/^[A-Za-z0-9_.-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

/**
 * Render a scalar string.
 *
 * @param {string} value - The value.
 * @returns {string} The rendered scalar.
 */
function renderScalar(value) {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_./@:+-]+$/.test(value) && !/^\d+$/.test(value)) return value;
  return JSON.stringify(value);
}

module.exports = {
  YamlError,
  parseSimpleYaml,
  renderYaml,
};
