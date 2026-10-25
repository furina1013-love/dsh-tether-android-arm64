import { tokenCount } from './tokens.js';

/**
 * Pure, deterministic, fail-open compression. No model calls, no I/O, no
 * clock. Callers pass the token budget; the helpers fit output to it.
 */

const MARK = (omitted) => `… [omitted ${omitted} tokens] …`;

function alreadyFits(text, budget) {
  return tokenCount(text) <= budget;
}

function extensionOf(path) {
  const value = String(path ?? '').toLowerCase();
  const index = value.lastIndexOf('.');
  return index === -1 ? '' : value.slice(index);
}

/** Decide which structural compressor applies. */
export function detectKind(text, path = '') {
  const ext = extensionOf(path);
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') return 'json';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // Not JSON; preserve it as text.
    }
  }
  if (ext === '' && looksLikeCsv(text)) return 'csv';
  return 'text';
}

function looksLikeCsv(text) {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  if (line.length === 0) return false;
  const commas = (line.match(/,/g) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  return Math.max(commas, tabs) >= 2 && text.includes('\n');
}

/** Compress one result and report the structural savings. */
export function compressPayload(input, options = {}) {
  const original = typeof input === 'string' ? input : String(input ?? '');
  const budget = Math.max(0, Math.floor(options.budget ?? 400));
  const originalTokens = tokenCount(original);
  if (original.length === 0) {
    return { text: '', kind: 'text', originalTokens: 0, tokens: 0, saved: 0, truncated: false };
  }
  if (budget === 0) {
    return { text: MARK(originalTokens), kind: 'text', originalTokens, tokens: tokenCount(MARK(originalTokens)), saved: 0, truncated: true };
  }
  try {
    const kind = detectKind(original, options.path);
    let body = original;
    let structural = kind;
    if (kind === 'json') {
      const compressed = compressJson(original, budget);
      body = compressed.body;
      structural = compressed.kind;
    } else if (kind === 'csv') {
      const compressed = compressCsv(original, budget);
      body = compressed.body;
      structural = compressed.kind;
    }
    const fitted = fitBody(body, budget, structural);
    const tokens = tokenCount(fitted.text);
    return {
      text: fitted.text,
      kind: structural,
      originalTokens,
      tokens,
      saved: Math.max(0, originalTokens - tokens),
      truncated: fitted.truncated || tokens < originalTokens
    };
  } catch {
    // Fail open: never turn a large but valid result into a tool failure.
    const fallback = fitBody(original, budget, 'text');
    const tokens = tokenCount(fallback.text);
    return {
      text: fallback.text,
      kind: 'text',
      originalTokens,
      tokens,
      saved: Math.max(0, originalTokens - tokens),
      truncated: fallback.truncated
    };
  }
}

/** Fit an already-selected body into a token budget. */
export function fitBody(body, budget, kind = 'text') {
  const text = String(body ?? '');
  if (alreadyFits(text, budget)) return { text, truncated: false };
  if (kind === 'text' || text.includes('\n')) return fitText(text, budget);
  return truncateMiddle(text, budget);
}

function compressJson(text, budget) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'text', body: text };
  }
  const compact = JSON.stringify(value);
  if (alreadyFits(compact, budget)) return { kind: 'json', body: compact };
  const skeleton = jsonSkeleton(value, 0);
  return { kind: 'json', body: skeleton };
}

function jsonSkeleton(value, depth) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const limit = depth > 2 ? 48 : 120;
    return JSON.stringify(value.length > limit ? `${value.slice(0, limit)}…` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= 5) return `[array(${value.length})]`;
    const picks = [];
    const head = Math.min(3, value.length);
    for (let i = 0; i < head; i += 1) picks.push(jsonSkeleton(value[i], depth + 1));
    if (value.length > 3) picks.push(`…(${value.length - 3} more)`);
    else if (value.length > head) picks.push(`…(${value.length - head} more)`);
    return `[${picks.join(', ')}]`;
  }
  if (typeof value === 'object') {
    if (depth >= 5) return `{object(${Object.keys(value).length} keys)}`;
    const keys = Object.keys(value);
    const shown = keys.slice(0, 24);
    const pairs = shown.map((key) => `${JSON.stringify(key)}:${jsonSkeleton(value[key], depth + 1)}`);
    if (keys.length > shown.length) pairs.push(`…(${keys.length - shown.length} more keys)`);
    return `{${pairs.join(', ')}}`;
  }
  return '"?"';
}

function compressCsv(text, budget) {
  const delimiter = chooseDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length < 2 || rows[0].length < 2) return { kind: 'text', body: text };
  const header = rows[0];
  const body = rows.slice(1);
  const sample = [];
  const headCount = Math.min(3, body.length);
  for (let i = 0; i < headCount; i += 1) sample.push(body[i]);
  const tailCount = Math.min(2, Math.max(0, body.length - headCount));
  for (let i = Math.max(headCount, body.length - tailCount); i < body.length; i += 1) sample.push(body[i]);
  const omitted = body.length - headCount - tailCount;
  const lines = [
    `# csv rows=${body.length} cols=${header.length} delimiter=${JSON.stringify(delimiter)}`,
    header.join(delimiter),
    ...sample.map((row) => row.join(delimiter)),
    ...(omitted > 0 ? [`… [omitted ${omitted} rows] …`] : [])
  ];
  return { kind: 'csv', body: lines.join('\n') };
}

function chooseDelimiter(text) {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  const semis = (line.match(/;/g) ?? []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas && semis > 0) return ';';
  return ',';
}

/** Small quote-aware parser for the bounded CSV sampling path. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

export function fitText(text, budget) {
  const lines = collapseRuns(text.split(/\r?\n/));
  if (lines.length <= 4) return truncateMiddle(lines.join('\n'), budget);
  return fitLines(lines, budget);
}

function collapseRuns(lines) {
  const out = [];
  let previous;
  let count = 0;
  for (const line of lines) {
    if (line === previous) {
      count += 1;
      continue;
    }
    if (previous !== undefined) out.push(count > 1 ? `${previous} ×${count}` : previous);
    previous = line;
    count = 1;
  }
  if (previous !== undefined) out.push(count > 1 ? `${previous} ×${count}` : previous);
  return out;
}

function fitLines(lines, budget) {
  const markerFor = (omitted) => `\n… [omitted ${omitted} lines] …\n`;
  const markerTokens = tokenCount(markerFor(lines.length));
  const available = Math.max(0, budget - markerTokens - 8);
  const headBudget = Math.floor(available * 0.58);
  const tailBudget = available - headBudget;
  const head = [];
  const tail = [];
  let headTokens = 0;
  let tailTokens = 0;
  for (const line of lines) {
    const cost = tokenCount(line) + 1;
    if (headTokens + cost > headBudget && head.length > 0) break;
    head.push(line);
    headTokens += cost;
  }
  for (let i = lines.length - 1; i >= head.length; i -= 1) {
    const line = lines[i];
    const cost = tokenCount(line) + 1;
    if (tailTokens + cost > tailBudget && tail.length > 0) break;
    tail.unshift(line);
    tailTokens += cost;
  }
  const omitted = Math.max(0, lines.length - head.length - tail.length);
  const candidate = [...head, markerFor(omitted), ...tail].join('\n');
  if (alreadyFits(candidate, budget)) return { text: candidate, truncated: omitted > 0 };
  return truncateMiddle(candidate, budget);
}

/** Keep a head/tail window; the marker tells the model what was removed. */
export function truncateMiddle(text, budget) {
  if (budget <= 0) return { text: MARK(tokenCount(text)), truncated: true };
  if (alreadyFits(text, budget)) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const head = Math.ceil(keep * 0.64);
    const tail = keep - head;
    const omitted = Math.max(0, text.length - keep);
    const candidate = `${text.slice(0, head)}\n${MARK(omitted)}\n${tail > 0 ? text.slice(text.length - tail) : ''}`;
    if (tokenCount(candidate) <= budget) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  if (best.length > 0) return { text: best, truncated: true };
  return { text: MARK(tokenCount(text)), truncated: true };
}
