import fs from 'fs';
import PDFDocument from 'pdfkit';
import { certNumber } from './vocTemplates.js';

// ── VOC certificate PDF ──────────────────────────────────────────────
// Page 1 is the certificate itself (A4 landscape): who, what they were found
// competent in and on which equipment, the dates and the certificate number.
// The pages after it are the assessment record (A4 portrait, in the
// inspection report style): every task, the theory and practical results
// and the assessor's notes, for each category assessed.

const NAVY = '#0b2236';
const INK = '#12263a';
const MUTE = '#5b6b7b';
const RULE = '#d5dde6';
const TINT = '#eef2f6';
const ZEBRA = '#f4f7fa';
const GOLD = '#b08d3c';
const GOOD = '#2e7d32';
const GOOD_BG = '#e8f5e9';
const BAD = '#c62828';
const BAD_BG = '#fdecea';
const FOOTER = 'AUAV  ·  contact@auav.com.au  ·  1300 738 521  ·  auav.com.au';

const LAND = { w: 841.89, h: 595.28 };
const PAGE = { left: 48, right: 547, top: 104, bottom: 776 };
const WIDTH = PAGE.right - PAGE.left;

const longDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
};
const shortDay = (iso) => iso.split('-').reverse().join('/');

const RESULT = { competent: 'Competent', nyc: 'Not yet competent', na: 'N/A', pass: 'Pass', fail: 'Fail' };

export function buildVocPdf({ assessment, categories, results, logoPath }) {
  const number = certNumber(assessment.number);
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    bufferPages: true,
    margin: 0,
    info: {
      Title: `Validation of Competency – ${assessment.member_name}`,
      Subject: `Certificate ${number}`,
      Author: `AUAV – ${assessment.assessor_name}`,
    },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const logo = logoPath && fs.existsSync(logoPath) ? logoPath : null;
  const catOf = (key) => categories.find((c) => c.key === key) || { key, title: key, tasks: [], equipmentLabel: 'Equipment' };
  const competent = results.filter((r) => r.outcome === 'competent');
  const notYet = results.filter((r) => r.outcome !== 'competent');

  const drawLogo = (x, y, w, h) => {
    if (logo) {
      try {
        doc.image(logo, x, y, { fit: [w, h], align: 'center', valign: 'center' });
        return;
      } catch { /* fall through to the wordmark */ }
    }
    doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text('AUAV', x, y + h / 2 - 9, { width: w, align: 'center' });
  };

  // ── Page 1: the certificate ──
  doc.rect(0, 0, LAND.w, LAND.h).fill('#ffffff');
  doc.rect(18, 18, LAND.w - 36, LAND.h - 36).lineWidth(6).stroke(NAVY);
  doc.rect(30, 30, LAND.w - 60, LAND.h - 60).lineWidth(0.8).stroke(GOLD);
  drawLogo(LAND.w / 2 - 70, 46, 140, 52);

  const cx = 70;
  const cw = LAND.w - 140;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GOLD)
    .text('VALIDATION OF COMPETENCY', cx, 112, { width: cw, align: 'center', characterSpacing: 3 });
  doc.font('Helvetica-Bold').fontSize(28).fillColor(NAVY)
    .text(competent.length ? 'Certificate of Competency' : 'Record of Assessment', cx, 128, { width: cw, align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor(MUTE)
    .text('This is to certify that', cx, 172, { width: cw, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(24).fillColor(INK)
    .text(assessment.member_name || '—', cx, 190, { width: cw, align: 'center' });
  const nameRuleY = doc.y + 4;
  doc.moveTo(LAND.w / 2 - 170, nameRuleY).lineTo(LAND.w / 2 + 170, nameRuleY).lineWidth(0.6).stroke(RULE);

  doc.font('Helvetica').fontSize(11).fillColor(MUTE).text(
    competent.length
      ? 'has been assessed and found competent in the following:'
      : 'was assessed and is not yet competent in the categories assessed. No competency is certified.',
    cx, nameRuleY + 12, { width: cw, align: 'center' },
  );

  // The categories found competent, each with its equipment, in up to two
  // columns so four categories still fit on the page.
  let y = doc.y + 14;
  if (competent.length) {
    const cols = competent.length > 2 ? 2 : 1;
    const gap = 20;
    const boxW = cols === 2 ? (cw - 80 - gap) / 2 : Math.min(460, cw - 80);
    const startX = cols === 2 ? cx + 40 : LAND.w / 2 - boxW / 2;
    const rows = [];
    for (let i = 0; i < competent.length; i += cols) rows.push(competent.slice(i, i + cols));
    for (const row of rows) {
      const heights = row.map((r) => {
        doc.font('Helvetica').fontSize(8.5);
        return 34 + doc.heightOfString(r.equipment.join('  ·  '), { width: boxW - 28 });
      });
      const h = Math.max(...heights);
      row.forEach((r, j) => {
        // A lone box on the last row sits centred.
        const x = row.length < cols ? LAND.w / 2 - boxW / 2 : startX + j * (boxW + gap);
        const cat = catOf(r.key);
        doc.rect(x, y, boxW, h).fill(TINT);
        doc.rect(x, y, 3, h).fill(GOLD);
        doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(cat.title, x + 14, y + 9, { width: boxW - 28 });
        doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(r.equipment.join('  ·  '), x + 14, y + 26, { width: boxW - 28 });
      });
      y += h + 10;
    }
  }

  // Dates, number and assessor along the bottom.
  const fy = LAND.h - 130;
  const fields = [
    ['Date of assessment', longDay(assessment.assessed_on)],
    ['Valid until', competent.length ? longDay(assessment.expires_on) : '—'],
    ['Certificate no.', number],
    ['Assessor', assessment.assessor_name || '—'],
  ];
  const fw = (cw - 40) / fields.length;
  fields.forEach(([label, value], i) => {
    const x = cx + 20 + i * fw;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(value, x, fy, { width: fw - 16, align: 'center' });
    doc.moveTo(x + 12, fy + 22).lineTo(x + fw - 28, fy + 22).lineWidth(0.6).stroke(RULE);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTE)
      .text(label.toUpperCase(), x, fy + 28, { width: fw - 16, align: 'center', characterSpacing: 0.6 });
  });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTE).text(
    `Valid for one year from the date of assessment. The assessment record follows on the next page${notYet.length ? ', including the categories not yet competent' : ''}.`,
    cx, LAND.h - 72, { width: cw, align: 'center' },
  );
  doc.text(FOOTER, cx, LAND.h - 58, { width: cw, align: 'center' });

  // ── Assessment record ──
  const newRecordPage = () => {
    doc.addPage({ size: 'A4', layout: 'portrait', margins: { top: PAGE.top, bottom: 842 - PAGE.bottom, left: PAGE.left, right: 595 - PAGE.right } });
    doc.y = PAGE.top;
  };
  const room = (h) => {
    if (doc.y + h > PAGE.bottom) {
      newRecordPage();
      return false;
    }
    return true;
  };

  newRecordPage();
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('Assessment record', PAGE.left, PAGE.top - 6);
  doc.font('Helvetica').fontSize(8).fillColor(MUTE).text(`Certificate ${number}  ·  ${longDay(assessment.assessed_on)}`);
  doc.moveDown(1.4);

  const cells = [
    ['Candidate', assessment.member_name || '—'],
    ['Certificate no.', number],
    ['Date of assessment', longDay(assessment.assessed_on)],
    ['Valid until', competent.length ? longDay(assessment.expires_on) : 'Not certified'],
    ['Assessor', assessment.assessor_name || '—'],
    ['Categories assessed', `${results.length} (${competent.length} competent)`],
  ];
  const colW = WIDTH / 2;
  y = doc.y;
  for (let i = 0; i < cells.length; i += 2) {
    const h = 44;
    cells.slice(i, i + 2).forEach(([label, value], j) => {
      const x = PAGE.left + j * colW;
      doc.rect(x, y, colW, h).fillAndStroke(TINT, RULE);
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTE).text(label.toUpperCase(), x + 12, y + 10, { width: colW - 24, characterSpacing: 0.4 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(value, x + 12, y + 21, { width: colW - 24 });
    });
    y += h;
  }
  doc.y = y + 20;

  const cols = [
    { x: PAGE.left, w: 30 },
    { x: PAGE.left + 30, w: 350 },
    { x: PAGE.left + 380, w: WIDTH - 380 },
  ];
  const tableHead = (title) => {
    const hy = doc.y;
    doc.rect(PAGE.left, hy, WIDTH, 26).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
    ['#', title, 'Result'].forEach((t, i) => doc.text(t, cols[i].x + 8, hy + 9, { width: cols[i].w - 14 }));
    doc.y = hy + 26;
  };
  // `good` is true (green), false (red) or null (grey, for N/A).
  const tableRow = (i, label, value, good) => {
    doc.font('Helvetica').fontSize(8.5);
    const h = doc.heightOfString(label, { width: cols[1].w - 14 }) + 14;
    const ry = doc.y;
    doc.rect(PAGE.left, ry, WIDTH, h).fill(i % 2 ? ZEBRA : '#ffffff');
    doc.moveTo(PAGE.left, ry + h).lineTo(PAGE.right, ry + h).lineWidth(0.5).stroke(RULE);
    doc.font('Helvetica').fontSize(8.5).fillColor(INK);
    doc.text(i === null ? '' : String(i + 1), cols[0].x + 8, ry + 7, { width: cols[0].w - 10 });
    doc.text(label, cols[1].x + 8, ry + 7, { width: cols[1].w - 14 });
    doc.font('Helvetica-Bold').fillColor(good === null ? MUTE : good ? GOOD : BAD).text(value, cols[2].x + 8, ry + 7, { width: cols[2].w - 14 });
    doc.y = ry + h;
  };

  for (const r of results) {
    const cat = catOf(r.key);
    const ok = r.outcome === 'competent';
    room(140);
    // Category banner
    const by = doc.y;
    doc.rect(PAGE.left, by, WIDTH, 34).fill(ok ? GOOD_BG : BAD_BG);
    doc.rect(PAGE.left, by, 4, 34).fill(ok ? GOOD : BAD);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(cat.title, PAGE.left + 16, by + 11, { width: 300 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ok ? GOOD : BAD)
      .text(ok ? 'COMPETENT' : 'NOT YET COMPETENT', PAGE.left + 300, by + 12, { width: WIDTH - 316, align: 'right' });
    doc.y = by + 44;

    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTE).text((cat.equipmentLabel || 'Equipment').toUpperCase(), PAGE.left, doc.y, { characterSpacing: 0.4 });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(r.equipment.join(', '), { width: WIDTH });
    doc.moveDown(0.8);

    tableHead('Task assessed');
    cat.tasks.forEach((task, i) => {
      if (!room(task.section ? 48 : 24)) tableHead('Task assessed');
      if (task.section && task.section !== cat.tasks[i - 1]?.section) {
        const sy = doc.y;
        doc.rect(PAGE.left, sy, WIDTH, 20).fill(TINT);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text(task.section.toUpperCase(), PAGE.left + 38, sy + 6, { characterSpacing: 0.5 });
        doc.y = sy + 20;
      }
      const v = r.tasks?.[task.key];
      tableRow(i, task.label, RESULT[v] || '—', v === 'na' ? null : v === 'competent');
    });
    if (!room(48)) tableHead('Task assessed');
    const score = r.theory_score === null || r.theory_score === undefined ? '' : ` (${r.theory_score}%)`;
    tableRow(null, 'Theory assessment', `${RESULT[r.theory] || '—'}${score}`, r.theory === 'pass');
    tableRow(null, 'Practical assessment', RESULT[r.practical] || '—', r.practical === 'pass');

    if (r.notes) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Oblique').fontSize(8.5);
      room(doc.heightOfString(r.notes, { width: WIDTH }) + 20);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTE).text('ASSESSOR NOTES', PAGE.left, doc.y, { characterSpacing: 0.4 });
      doc.moveDown(0.2);
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(INK).text(r.notes, { width: WIDTH });
    }
    doc.moveDown(1.6);
  }

  if (assessment.comments) {
    room(60);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Comments', PAGE.left, doc.y);
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(assessment.comments, { width: WIDTH });
    doc.moveDown(1.2);
  }

  room(70);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Assessed by', PAGE.left, doc.y);
  doc.moveDown(0.5);
  const sy = doc.y;
  doc.rect(PAGE.left, sy, WIDTH, 40).fillAndStroke(TINT, RULE);
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTE).text('ASSESSOR', PAGE.left + 12, sy + 9, { characterSpacing: 0.4 });
  doc.text('DATE OF ASSESSMENT', PAGE.left + 300, sy + 9, { characterSpacing: 0.4 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(assessment.assessor_name || '—', PAGE.left + 12, sy + 21, { width: 270 });
  doc.text(shortDay(assessment.assessed_on), PAGE.left + 300, sy + 21);

  // ── Letterhead and footer on the record pages ──
  const range = doc.bufferedPageRange();
  const recordPages = range.count - 1;
  for (let i = range.start + 1; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { bottom } = doc.page.margins;
    doc.page.margins.bottom = 0;
    doc.rect(0, 0, 595.28, 72).fill(NAVY);
    doc.roundedRect(PAGE.left - 8, 13, 108, 46, 6).fill('#ffffff');
    drawLogo(PAGE.left - 2, 17, 96, 38);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#ffffff')
      .text('VALIDATION OF COMPETENCY', 250, 25, { width: PAGE.right - 250, align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#c9d4df')
      .text(`${assessment.member_name}  ·  ${number}  ·  ${shortDay(assessment.assessed_on)}`, 250, 41, { width: PAGE.right - 250, align: 'right' });
    doc.moveTo(PAGE.left, 800).lineTo(PAGE.right, 800).lineWidth(0.5).stroke(RULE);
    doc.font('Helvetica').fontSize(7).fillColor(MUTE).text(FOOTER, PAGE.left, 808, { lineBreak: false });
    doc.text(`Record page ${i - range.start} of ${recordPages}`, PAGE.right - 120, 808, { width: 120, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
