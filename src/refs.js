import { createHash } from 'node:crypto';
import { tokenCount } from './tokens.js';

/**
 * Content-addressed, bounded, in-memory result cache. A ref is a derived
 * cache, never session truth: losing it only costs one re-read.
 */
export class RefStore {
  constructor({ maxEntries = 128, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.maxEntries = Math.max(0, Math.floor(maxEntries));
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.entries = new Map();
    this.bytes = 0;
  }

  static idFor(text) {
    return `r_${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  }

  put(text, meta = {}) {
    const body = typeof text === 'string' ? text : String(text ?? '');
    if (this.maxEntries === 0) return { ref: undefined, tokens: tokenCount(body), duplicate: false };
    const id = RefStore.idFor(body);
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      existing.lastAccess = Date.now();
      // Refresh insertion order for LRU eviction.
      this.entries.delete(id);
      this.entries.set(id, existing);
      return { ref: id, tokens: existing.tokens, duplicate: true };
    }
    const entry = {
      ref: id,
      body,
      meta: { ...meta },
      tokens: tokenCount(body),
      createdAt: Date.now(),
      lastAccess: Date.now()
    };
    this.entries.set(id, entry);
    this.bytes += Buffer.byteLength(body, 'utf8');
    this.#evict();
    return { ref: id, tokens: entry.tokens, duplicate: false };
  }

  has(ref) {
    return typeof ref === 'string' && this.entries.has(ref);
  }

  get(ref) {
    const entry = this.entries.get(ref);
    if (entry === undefined) return undefined;
    entry.lastAccess = Date.now();
    this.entries.delete(ref);
    this.entries.set(ref, entry);
    return entry;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  #evict() {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      if (entry !== undefined) this.bytes -= Buffer.byteLength(entry.body, 'utf8');
      this.entries.delete(oldest.value);
      if (this.maxEntries === 0) break;
    }
  }
}
