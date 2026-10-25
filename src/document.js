import { inflateRawSync, inflateSync } from 'node:zlib';
import { extname } from 'node:path';
import { compressPayload } from './compress.js';
import { toolName } from './names.js';
import { documentParameters, documentOutput } from './tool-defs.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 1_000_000;

/** Build the on-demand document reader. It is registered only after tether_activate enable document. */
export function createDocumentTool({ ctx, config, refs }) {
  return {
    deferLoading: true,
    name: toolName('document'),
    description: 'Extract bounded text from a PDF, DOCX, or UTF-8 document. Scanned pages need OCR and are reported empty.',
    parameters: documentParameters,
    output: {
      schema: documentOutput,
      render: (_args, value) => [{ type: 'text', text: `${value.kind} · ~${value.text.length} chars · saved ~${value.saved} tok${value.ref ? ` · ${value.ref}` : ''}\n${value.text}${value.note ? `\nnote: ${value.note}` : ''}` }]
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) throw new Error('path must be non-empty');
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined) throw new Error('file not found');
      if (info.type !== 'file') throw new Error('not a regular file');
      if (typeof info.size === 'number' && info.size > MAX_DOCUMENT_BYTES) {
        throw new Error(`file is ${info.size} bytes; document extraction is limited to ${MAX_DOCUMENT_BYTES} bytes`);
      }
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_DOCUMENT_BYTES);
      const format = chooseFormat(args.format, args.path);
      const extracted = extract(bytes, format);
      const offset = Math.max(0, Math.floor(args.offset ?? 0));
      const limit = Math.max(1, Math.min(MAX_EXTRACTED_CHARS, Math.floor(args.maxChars ?? 200_000)));
      const window = extracted.text.slice(offset, offset + limit);
      const note = extracted.note ?? (offset + limit < extracted.text.length ? `text continues after character ${offset + limit}` : undefined);
      const stored = refs.put(extracted.text, { kind: 'document', path: target.displayPath, format });
      const compressed = compressPayload(window, { budget: config.maxResultTokens, path: args.path });
      const text = compressed.text.length > 0 ? compressed.text : '(no text extracted)';
      return {
        text,
        kind: extracted.kind,
        ...(stored.ref === undefined || !refs.has(stored.ref) ? {} : { ref: stored.ref }),
        truncated: compressed.truncated || offset + limit < extracted.text.length,
        saved: compressed.saved,
        ...(note === undefined ? {} : { note })
      };
    }
  };
}

function chooseFormat(requested, path) {
  if (requested !== undefined && requested !== 'auto') return requested;
  const ext = extname(String(path)).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.doc') throw new Error('legacy .doc is not supported; convert it to .docx or plain text');
  if (ext === '.xls' || ext === '.ppt') throw new Error('legacy binary Office formats are not supported; convert to .docx or plain text');
  return 'text';
}

function extract(bytes, format) {
  if (format === 'docx') {
    const xml = readZipEntry(bytes, 'word/document.xml');
    if (xml === undefined) throw new Error('not a DOCX word/document.xml archive');
    return { kind: 'docx', text: xmlToText(xml), note: 'DOCX text only; images, comments, and layout are omitted' };
  }
  if (format === 'pdf') {
    const text = pdfToText(bytes);
    return {
      kind: 'pdf',
      text,
      note: text.trim().length === 0 ? 'no text layer found; this may be a scanned or image-only PDF' : 'PDF text layer only; layout and images are omitted'
    };
  }
  return { kind: 'text', text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
}

/** Minimal ZIP central-directory reader for DOCX (no native module). */
function readZipEntry(buffer, wanted) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  let offset = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let index = 0; index < count && offset + 46 <= buf.length; index += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return undefined;
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed.toString('utf8');
      if (method === 8) {
        try {
          return inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) + 1024 }).toString('utf8');
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

function xmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Best-effort PDF text-layer extraction: streams plus Tj/TJ literal strings. */
function pdfToText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const raw = buf.toString('latin1');
  const chunks = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const streamAt = raw.indexOf('stream', cursor);
    if (streamAt < 0) break;
    let dataStart = streamAt + 6;
    if (raw[dataStart] === '\r') dataStart += 1;
    if (raw[dataStart] === '\n') dataStart += 1;
    const end = raw.indexOf('endstream', dataStart);
    if (end < 0) break;
    const dictionary = raw.slice(Math.max(0, streamAt - 500), streamAt);
    let bytes = Buffer.from(raw.slice(dataStart, end), 'latin1');
    if (dictionary.includes('/FlateDecode')) {
      try {
        bytes = inflateSync(bytes);
      } catch {
        try {
          bytes = inflateRawSync(bytes);
        } catch {
          // Keep the original bytes; the text pass below simply finds nothing.
        }
      }
    }
    chunks.push(bytes.toString('latin1'));
    cursor = end + 9;
  }
  const pieces = [];
  for (const chunk of chunks) {
    const textBlocks = chunk.match(/BT[\s\S]*?ET/g) ?? [];
    for (const block of textBlocks) {
      const withBreaks = block.replace(/(?:Td|TD|T\*)(?!\w)/g, '\n');
      const matches = withBreaks.match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]{2,}>/g) ?? [];
      for (const token of matches) {
        const value = decodePdfString(token);
        if (value.length > 0) pieces.push(value);
      }
    }
  }
  return pieces.join(' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodePdfString(token) {
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/\s+/g, '');
    if (hex.length < 2) return '';
    let text = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const code = Number.parseInt(hex.slice(i, i + 2), 16);
      if (Number.isFinite(code) && code !== 0) text += String.fromCharCode(code);
    }
    return text;
  }
  const body = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next === 'n') { out += '\n'; i += 1; }
    else if (next === 'r') { out += '\r'; i += 1; }
    else if (next === 't') { out += '\t'; i += 1; }
    else if (next === 'b') { out += '\b'; i += 1; }
    else if (next === 'f') { out += '\f'; i += 1; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i += 1; }
    else if (next >= '0' && next <= '7') {
      let octal = next;
      i += 1;
      while (octal.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
        i += 1;
        octal += body[i];
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else if (next === '\n') {
      i += 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}
