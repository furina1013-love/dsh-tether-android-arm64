/**
 * Token counting is exact when js-tiktoken can be loaded and deterministic
 * heuristic otherwise. It is never allowed to break a tool call.
 */
const FALLBACK_DIVISOR = 3.5;
let counter = fallbackCount;
let exact = false;
let initializing;

function fallbackCount(text) {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(Array.from(text).length / FALLBACK_DIVISOR));
}

/** Initialize the pure-JS tokenizer once; failure falls back without throwing. */
export function initTokenizer(logger) {
  if (initializing !== undefined) return initializing;
  initializing = (async () => {
    try {
      const mod = await import('js-tiktoken');
      const enc = mod.getEncoding('cl100k_base');
      // Exact for bounded results and schemas. Long inputs use sampled
      // head/tail encoding: some repetitive strings make full BPE encoding
      // quadratic in practice, which would stall a tool call.
      const MAX_EXACT_CHARS = 1600;
      const SAMPLE_CHARS = 800;
      counter = (text) => {
        if (text.length <= MAX_EXACT_CHARS) return enc.encode(text).length;
        const head = enc.encode(text.slice(0, SAMPLE_CHARS)).length;
        const tail = enc.encode(text.slice(-SAMPLE_CHARS)).length;
        const density = (head + tail) / (SAMPLE_CHARS * 2);
        return Math.max(1, Math.ceil((head + tail + density * (text.length - SAMPLE_CHARS * 2)) * 1.05));
      };
      exact = true;
    } catch (error) {
      exact = false;
      logger?.warn?.(() => `tether: js-tiktoken unavailable; using deterministic fallback token estimate (${error instanceof Error ? error.message : String(error)})`);
    }
  })();
  return initializing;
}

/** Count tokens for arbitrary text without ever throwing. */
export function tokenCount(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length === 0) return 0;
  try {
    return Math.max(0, counter(value));
  } catch {
    return fallbackCount(value);
  }
}

/** Approximate the model-facing cost of one tool definition. */
export function schemaTokenCount(definition) {
  return tokenCount(JSON.stringify({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters
  }));
}

/** Whether the exact tokenizer is active. */
export function hasExactTokenizer() {
  return exact;
}

/** Test seam: install a deterministic counter. */
export function setTokenCounterForTests(next) {
  counter = typeof next === 'function' ? next : fallbackCount;
  exact = false;
}
