// Equipment manifest as an .xlsx workbook, written directly (no spreadsheet
// library): a zip of a few XML parts. The layout follows the manifest the
// clients send us — two title lines across the top, a header row, then one
// line per item — and the columns nobody can fill in from our records (Date,
// IBV, Comments, TE inspected, Inspected by) come out blank, bordered, ready
// to be typed into in Excel.
import { zipSync, strToU8 } from 'fflate';

export const MANIFEST_COLUMNS = [
  { title: 'Asset Number', width: 16 },
  { title: 'Serial Number', width: 20 },
  { title: 'Description', width: 34 },
  { title: 'Quantity', width: 10 },
  { title: 'Date', width: 14 },
  { title: 'IBV', width: 10 },
  { title: 'Comments', width: 28 },
  { title: 'TE inspected', width: 15 },
  { title: 'Inspected by', width: 34 },
];

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Style indexes into cellXfs below.
const S = { title1: 1, title2: 2, header: 3, body: 4 };

/** Column letter for a zero-based index (0 → A). */
export const colLetter = (i) => String.fromCharCode(65 + i);

/** Escape text for XML and drop characters XML 1.0 cannot carry. */
export function xmlEscape(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const textCell = (ref, text, style) => (text === '' || text == null
  ? `<c r="${ref}" s="${style}"/>`
  : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`);

const numberCell = (ref, n, style) => `<c r="${ref}" s="${style}"><v>${Number(n)}</v></c>`;

function sheetXml({ title1, title2, rows }) {
  const last = colLetter(MANIFEST_COLUMNS.length - 1);
  const blanks = (rowNo, style) => MANIFEST_COLUMNS.slice(1)
    .map((_, i) => `<c r="${colLetter(i + 1)}${rowNo}" s="${style}"/>`).join('');

  const out = [];
  out.push(`<row r="1" ht="30" customHeight="1">${textCell('A1', title1, S.title1)}${blanks(1, S.title1)}</row>`);
  out.push(`<row r="2" ht="26" customHeight="1">${textCell('A2', title2, S.title2)}${blanks(2, S.title2)}</row>`);
  out.push(`<row r="3" ht="22" customHeight="1">${MANIFEST_COLUMNS
    .map((c, i) => textCell(`${colLetter(i)}3`, c.title, S.header)).join('')}</row>`);

  rows.forEach((r, idx) => {
    const n = idx + 4;
    const cells = MANIFEST_COLUMNS.map((_, i) => {
      const ref = `${colLetter(i)}${n}`;
      const v = r[i];
      return typeof v === 'number' ? numberCell(ref, v, S.body) : textCell(ref, v ?? '', S.body);
    }).join('');
    out.push(`<row r="${n}">${cells}</row>`);
  });

  const cols = MANIFEST_COLUMNS
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('');
  const lastRow = rows.length + 3;

  return `${XML_HEAD}<worksheet xmlns="${NS}">`
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<dimension ref="A1:${last}${lastRow}"/>`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${cols}</cols>`
    + `<sheetData>${out.join('')}</sheetData>`
    + `<mergeCells count="2"><mergeCell ref="A1:${last}1"/><mergeCell ref="A2:${last}2"/></mergeCells>`
    + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    + '</worksheet>';
}

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS}">`
  + '<fonts count="4">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="16"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="14"/><name val="Calibri"/></font>'
  + '</fonts>'
  + '<fills count="4">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="2">'
  + '<border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>'
  + '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>'
  + '</borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="5">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/**
 * Build the workbook. `rows` is an array of arrays in MANIFEST_COLUMNS order;
 * numbers are written as numbers, everything else as text.
 * Returns the .xlsx file as bytes.
 */
export function buildManifestXlsx({ title1 = '', title2 = '', rows = [] }) {
  const files = {
    '[Content_Types].xml': strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>',
    ),
    '_rels/.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${REL_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>`
      + '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${OFFICE_REL}">`
      + '<sheets><sheet name="Manifest" sheetId="1" r:id="rId1"/></sheets>'
      + '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="${REL_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_REL}/styles" Target="styles.xml"/>`
      + '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES_XML),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml({ title1, title2, rows })),
  };
  return zipSync(files);
}

/** A filename that is safe on every OS. */
export const manifestFilename = (label) =>
  `${String(label || 'Manifest').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Manifest'}.xlsx`;
