import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentTool } from '../src/document.js';
import { Config } from '../src/config.js';
import { RefStore } from '../src/refs.js';
import { initTokenizer } from '../src/tokens.js';
import { crc32 } from 'node:zlib';

await initTokenizer();

test('pdf text-layer extraction is bounded and reports its source', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n2 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1');
  const ctx = {
    fs: {
      resolve: async (path) => ({ displayPath: path, targetKey: path }),
      stat: async () => ({ type: 'file', size: pdf.length }),
      readBytes: async () => pdf
    },
    workingDirectory: { ensure: async () => '/tmp' }
  };
  const tool = createDocumentTool({ ctx, config: Config({}), refs: new RefStore() });
  const result = await tool.execute({ path: 'x.pdf' }, { agent: {}, signal: new AbortController().signal });
  assert.equal(result.kind, 'pdf');
  assert.equal(result.truncated, false);
  assert.match(result.text, /Hello PDF/);
  assert.ok(result.ref.startsWith('r_'));
});
function zipStore(name, content) {
  const nameBytes = Buffer.from(name);
  const data = Buffer.from(content);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(checksum >>> 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(checksum >>> 0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

test('docx text is extracted through the built-in ZIP reader', async () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>';
  const docx = zipStore('word/document.xml', xml);
  const ctx = {
    fs: {
      resolve: async (path) => ({ displayPath: path, targetKey: path }),
      stat: async () => ({ type: 'file', size: docx.length }),
      readBytes: async () => docx
    },
    workingDirectory: { ensure: async () => '/tmp' }
  };
  const tool = createDocumentTool({ ctx, config: Config({}), refs: new RefStore() });
  const result = await tool.execute({ path: 'x.docx' }, { agent: {}, signal: new AbortController().signal });
  assert.equal(result.kind, 'docx');
  assert.match(result.text, /Hello DOCX/);
});
