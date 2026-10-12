import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { buildManifestXlsx, xmlEscape, manifestFilename, MANIFEST_COLUMNS } from '../src/lib/manifestXlsx.js';

const parts = (bytes) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));

test('the workbook is a zip with every part Excel needs', () => {
  const p = parts(buildManifestXlsx({ title1: 'T1', title2: 'T2', rows: [] }));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(p[name], name);
  }
});

test('titles are merged across the table, then the header, then one row per item', () => {
  const p = parts(buildManifestXlsx({
    title1: 'Vertech Manifest', title2: 'FPSO Opal',
    rows: [['M300 2B', 'SN-1', 'Matrice 300 RTK', 1, '', '', '', '', '']],
  }));
  const sheet = p['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<mergeCell ref="A1:I1"\/>/);
  assert.match(sheet, /<mergeCell ref="A2:I2"\/>/);
  assert.match(sheet, />Vertech Manifest</);
  for (const c of MANIFEST_COLUMNS) assert.ok(sheet.includes(`>${c.title}<`), c.title);
  assert.match(sheet, /<c r="A4"[^>]*t="inlineStr"><is><t[^>]*>M300 2B</);
  assert.match(sheet, /<c r="D4" s="4"><v>1<\/v><\/c>/, 'quantity is a number');
  assert.match(sheet, /<c r="E4" s="4"\/>/, 'blank columns are empty bordered cells');
  assert.match(sheet, /<dimension ref="A1:I4"\/>/);
});

test('text is escaped so a note or name cannot break the file', () => {
  assert.equal(xmlEscape('A & B <c> "d"'), 'A &amp; B &lt;c&gt; &quot;d&quot;');
  assert.equal(xmlEscape('bad\u0000char\u0008'), 'badchar');
  const p = parts(buildManifestXlsx({ title1: 'Tom & Jerry <x>', title2: '', rows: [['A&B', '', '', 1, '', '', '', '', '']] }));
  assert.match(p['xl/worksheets/sheet1.xml'], /Tom &amp; Jerry &lt;x&gt;/);
  assert.match(p['xl/worksheets/sheet1.xml'], />A&amp;B</);
});

test('every part is well-formed XML (tags nest and close)', () => {
  const p = parts(buildManifestXlsx({ title1: 'a & b', title2: 'b', rows: [['x', 'y', 'z', 1, '', '', '', '', '']] }));
  for (const [name, xml] of Object.entries(p)) {
    const stack = [];
    for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
      const [, closing, tag, , selfClosing] = m;
      if (selfClosing) continue;
      if (closing) assert.equal(stack.pop(), tag, `${name}: unexpected </${tag}>`);
      else stack.push(tag);
    }
    assert.deepEqual(stack, [], `${name}: unclosed tags`);
  }
});

test('filenames are safe', () => {
  assert.equal(manifestFilename('AU-12 / Tank: ROV?'), 'AU-12 - Tank- ROV-.xlsx');
  assert.equal(manifestFilename(''), 'Manifest.xlsx');
});
