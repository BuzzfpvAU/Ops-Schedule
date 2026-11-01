import fs from 'fs';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

// ── Inspection report PDF ────────────────────────────────────────────
// Lays out one submitted inspection in the AUAV report style the
// Microsoft Forms reports used: letterhead band, item details, the item's
// register details with QR codes for its manual and SDS, a result banner,
// the checklist table, a sign-off block and a photo register.

const NAVY = '#0b2236';
const INK = '#12263a';
const MUTE = '#5b6b7b';
const RULE = '#d5dde6';
const TINT = '#eef2f6';
const ZEBRA = '#f4f7fa';
const GOOD = '#2e7d32';
const GOOD_BG = '#e8f5e9';
const BAD = '#c62828';
const BAD_BG = '#fdecea';
const FOOTER = 'AUAV  ·  contact@auav.com.au  ·  1300 738 521  ·  auav.com.au';

const PAGE = { left: 48, right: 547, top: 104, bottom: 776 };
const WIDTH = PAGE.right - PAGE.left;

const TZ = 'Australia/Sydney';
const longDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

// Choice wording changed since some reports were stored; print the current one.
const RENAMED = { 'Before dispatch / hire': 'Before dispatch' };

function formatDetail(field, value) {
  if (!value) return '—';
  if (RENAMED[value]) return RENAMED[value];
  if (field.type === 'date') {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  return value;
}

export async function buildInspectionPdf({ inspection, template, details, answers, item, photos, logoPath, register }) {
  const qrImages = {};
  for (const url of [register?.info_url, register?.sds_url].filter(Boolean)) {
    qrImages[url] = await QRCode.toBuffer(url, { type: 'png', margin: 1, scale: 8, errorCorrectionLevel: 'M' });
  }
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: PAGE.top, bottom: 842 - PAGE.bottom, left: PAGE.left, right: 595 - PAGE.right },
    info: {
      Title: `${template.reportTitle} – ${[item.name, item.serial_number].filter(Boolean).join(' ')}`,
      Subject: `${template.title}, report ${inspection.number}`,
      Author: `AUAV – ${inspection.inspected_by_name}`,
    },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const logo = logoPath && fs.existsSync(logoPath) ? logoPath : null;
  const subtitle = `${template.title}  ·  Report #${inspection.number}  ·  ${shortDate(inspection.inspected_at)}`;
  const areas = template.areas;
  const defectAreas = areas.filter((a) => answers[a.key]?.defects === 'yes');
  const photosByArea = {};
  for (const p of photos) (photosByArea[p.area_key] ||= []).push(p);

  // Start a new page when `h` more points would run past the bottom.
  const room = (h) => {
    if (doc.y + h > PAGE.bottom) {
      doc.addPage();
      return false;
    }
    return true;
  };

  // ── Title ──
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(template.title, PAGE.left, PAGE.top - 6);
  doc.font('Helvetica').fontSize(8).fillColor(MUTE)
    .text(`Report #${inspection.number}  ·  ${longDate(inspection.inspected_at)}, ${timeOf(inspection.inspected_at)}`);
  doc.moveDown(1.4);

  // ── Details grid ──
  const cells = [
    [template.itemLabel || 'Item', item.name || '—'],
    ['Serial number', item.serial_number || '—'],
    ...template.details.map((f) => [f.label, formatDetail(f, details[f.key])]),
    ['Inspected by', inspection.inspected_by_name || '—'],
    ['Date compiled', `${longDate(inspection.inspected_at)}, ${timeOf(inspection.inspected_at)}`],
  ];
  // Label/value boxes two to a row; a `full` cell takes a row of its own.
  const grid = (list) => {
    const colW = WIDTH / 2;
    const rows = [];
    for (let i = 0; i < list.length;) {
      if (list[i].full || !list[i + 1] || list[i + 1].full) rows.push([list[i++]]);
      else { rows.push([list[i], list[i + 1]]); i += 2; }
    }
    for (const row of rows) {
      const w = row.length === 1 && row[0].full ? WIDTH : colW;
      doc.font('Helvetica-Bold').fontSize(10);
      const h = Math.max(...row.map((c) => doc.heightOfString(c.value, { width: w - 24 }))) + 30;
      room(h);
      const y = doc.y;
      row.forEach((c, j) => {
        const x = PAGE.left + j * colW;
        doc.rect(x, y, w, h).fillAndStroke(TINT, RULE);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(MUTE).text(c.label.toUpperCase(), x + 12, y + 10, { width: w - 24, characterSpacing: 0.4 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(c.value, x + 12, y + 21, { width: w - 24 });
      });
      if (w === colW && row.length === 1) doc.rect(PAGE.left + colW, y, colW, h).fillAndStroke(TINT, RULE);
      doc.y = y + h;
    }
    doc.y += 18;
  };
  grid(cells.map(([label, value]) => ({ label, value })));

  // ── Equipment register ──
  // Reports from before the register was copied in have none of this.
  const reg = register || {};
  const regCells = [
    ['Category', reg.category],
    ['Description', reg.description],
    ['Dimensions', reg.dimensions],
    ['Weight', reg.weight],
  ].filter(([, v]) => v).map(([label, value]) => ({ label, value }));
  const links = [
    ['Info / manual', reg.info_url],
    ['Safety data sheet (SDS)', reg.sds_url],
  ].filter(([, url]) => url);
  if (regCells.length || reg.contents || links.length || 'dangerous_goods' in reg) {
    room(60);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Equipment details', PAGE.left, doc.y);
    doc.moveDown(0.6);
    regCells.push({
      label: 'Dangerous goods',
      value: reg.dangerous_goods ? `Yes${reg.un_codes ? ` – ${reg.un_codes}` : ''}` : 'No',
    });
    if (reg.contents) regCells.push({ label: 'Box contents', value: reg.contents, full: true });
    grid(regCells);

    // One card per link: the QR code, what it opens, and the address.
    if (links.length) {
      const cardW = (WIDTH - 12) / 2;
      const cardH = 82;
      const qr = 64;
      room(cardH + 12);
      const y = doc.y;
      links.forEach(([label, url], i) => {
        const x = PAGE.left + i * (cardW + 12);
        doc.rect(x, y, cardW, cardH).lineWidth(0.5).fillAndStroke('#ffffff', RULE);
        doc.image(qrImages[url], x + 10, y + 10, { width: qr, height: qr });
        const tx = x + qr + 22;
        const tw = cardW - qr - 32;
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(label, tx, y + 14, { width: tw });
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTE).text('Scan to open', tx, doc.y + 2, { width: tw });
        doc.font('Helvetica').fontSize(7).fillColor(NAVY)
          .text(url, tx, doc.y + 6, { width: tw, height: cardH - (doc.y + 6 - y) - 8, ellipsis: true, link: url, underline: true });
      });
      doc.y = y + cardH + 14;
    }
  }

  // ── Result banner ──
  const ok = defectAreas.length === 0;
  const naAreas = areas.filter((a) => answers[a.key]?.defects === 'na');
  const naNote = naAreas.length ? ` ${naAreas.length} marked N/A: ${naAreas.map((a) => a.label.split(' – ')[0]).join('; ')}.` : '';
  const answered = areas.length - naAreas.length;
  const heading = ok ? 'RESULT: NO DEFECTS RECORDED' : `RESULT: ${defectAreas.length} DEFECT${defectAreas.length === 1 ? '' : 'S'} RECORDED`;
  let summary = ok
    ? (template.positive
      ? `${naAreas.length ? `All ${answered} applicable` : `All ${areas.length}`} inspection areas were answered “Yes”: free from damage and in working order.`
      : `All ${areas.length} inspection areas were answered “No” to defects observed.`)
    : `${template.positive ? 'Answered “No” in' : 'Defects observed in'}: ${defectAreas.map((a) => a.label).join('; ')}.`;
  summary += naNote;
  if (inspection.marked_unserviceable) summary += ' The item was marked unserviceable in the equipment register.';
  doc.font('Helvetica').fontSize(9);
  const bannerH = Math.max(46, doc.heightOfString(summary, { width: WIDTH - 230 }) + 26);
  room(bannerH);
  let y = doc.y;
  doc.rect(PAGE.left, y, WIDTH, bannerH).fill(ok ? GOOD_BG : BAD_BG);
  doc.rect(PAGE.left, y, 4, bannerH).fill(ok ? GOOD : BAD);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(ok ? GOOD : BAD).text(heading, PAGE.left + 18, y + 13, { width: 190 });
  doc.font('Helvetica').fontSize(9).fillColor(ok ? GOOD : BAD).text(summary, PAGE.left + 220, y + 13, { width: WIDTH - 236 });
  doc.y = y + bannerH + 24;

  // ── Checklist ──
  room(80);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Inspection checklist', PAGE.left, doc.y);
  doc.moveDown(0.6);
  const cols = [
    { x: PAGE.left, w: 30 },
    { x: PAGE.left + 30, w: 270 },
    { x: PAGE.left + 300, w: 105 },
    { x: PAGE.left + 405, w: WIDTH - 405 },
  ];
  const tableHead = () => {
    const hy = doc.y;
    doc.rect(PAGE.left, hy, WIDTH, 30).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
    ['#', 'Inspection area', 'Photos provided', template.positive ? 'Satisfactory' : 'Defects observed'].forEach((t, i) => {
      doc.text(t, cols[i].x + 8, hy + 8, { width: cols[i].w - 14 });
    });
    doc.y = hy + 30;
  };
  tableHead();
  areas.forEach((a, i) => {
    const ans = answers[a.key] || {};
    const yes = ans.defects === 'yes';
    const photoText = String((photosByArea[a.key] || []).length);
    doc.font('Helvetica').fontSize(8.5);
    let h = doc.heightOfString(a.label, { width: cols[1].w - 14 }) + 16;
    let noteH = 0;
    if (yes && ans.notes) {
      doc.font('Helvetica-Oblique').fontSize(8);
      noteH = doc.heightOfString(`Defect: ${ans.notes}`, { width: WIDTH - 46 }) + 8;
      h += noteH;
    }
    if (!room(h)) tableHead();
    const ry = doc.y;
    doc.rect(PAGE.left, ry, WIDTH, h).fill(i % 2 ? ZEBRA : '#ffffff');
    doc.moveTo(PAGE.left, ry + h).lineTo(PAGE.right, ry + h).lineWidth(0.5).stroke(RULE);
    doc.font('Helvetica').fontSize(8.5).fillColor(INK);
    doc.text(String(i + 1), cols[0].x + 8, ry + 8, { width: cols[0].w - 10 });
    doc.text(a.label, cols[1].x + 8, ry + 8, { width: cols[1].w - 14 });
    doc.text(photoText, cols[2].x + 8, ry + 8, { width: cols[2].w - 14 });
    if (ans.defects === 'na') doc.font('Helvetica-Bold').fillColor(MUTE).text('N/A', cols[3].x + 8, ry + 8);
    else doc.font('Helvetica-Bold').fillColor(yes ? BAD : GOOD).text(yes === !template.positive ? 'Yes' : 'No', cols[3].x + 8, ry + 8);
    if (noteH) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(BAD)
        .text(`Defect: ${ans.notes}`, cols[1].x + 8, ry + h - noteH, { width: WIDTH - 46 });
    }
    doc.y = ry + h;
  });

  // ── Comments ──
  if (inspection.comments) {
    doc.moveDown(1.5);
    room(60);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Comments', PAGE.left, doc.y);
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(inspection.comments, { width: WIDTH });
  }

  // ── Sign-off ──
  doc.moveDown(2);
  room(150);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Sign-off', PAGE.left, doc.y);
  doc.moveDown(0.6);
  const signCols = [{ x: PAGE.left, w: 230 }, { x: PAGE.left + 230, w: 160 }, { x: PAGE.left + 390, w: WIDTH - 390 }];
  const signRow = (labels, values) => {
    const sy = doc.y;
    doc.rect(PAGE.left, sy, WIDTH, 20).fill(TINT);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTE);
    labels.forEach((l, i) => doc.text(l, signCols[i].x + 8, sy + 6, { width: signCols[i].w - 12 }));
    doc.rect(PAGE.left, sy, WIDTH, 56).lineWidth(0.5).stroke(RULE);
    signCols.slice(1).forEach((c) => doc.moveTo(c.x, sy).lineTo(c.x, sy + 56).stroke(RULE));
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    values.forEach((v, i) => v && doc.text(v, signCols[i].x + 8, sy + 32, { width: signCols[i].w - 12 }));
    doc.y = sy + 56;
  };
  signRow(['Inspected by', 'Signature', 'Date'], [inspection.inspected_by_name, '', shortDate(inspection.inspected_at)]);
  doc.moveDown(0.8);
  signRow(['Reviewed / released to service by', 'Signature', 'Date'], ['', '', '']);

  // ── Photo register ──
  const withPhotos = areas.filter((a) => (photosByArea[a.key] || []).length);
  if (withPhotos.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Photo register', PAGE.left, PAGE.top - 6);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8).fillColor(MUTE).text('Photos uploaded with this report, by inspection area.', { width: WIDTH });
    doc.moveDown(1);
    const gap = 12;
    const cellW = (WIDTH - gap * 2) / 3;
    const cellH = 120;
    for (const a of withPhotos) {
      const idx = areas.indexOf(a) + 1;
      const yes = answers[a.key]?.defects === 'yes';
      const na = answers[a.key]?.defects === 'na';
      const list = photosByArea[a.key];
      room(18 + cellH + 24);
      const hy = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
        .text(`${idx}. ${a.label}  ·  `, PAGE.left, hy, { continued: true })
        .fillColor(na ? MUTE : yes ? BAD : GOOD).text(na ? 'N/A' : yes ? 'Defects observed' : 'No defects');
      doc.y = hy + 18;
      for (let i = 0; i < list.length; i += 3) {
        if (i > 0) room(cellH + 24);
        const py = doc.y;
        list.slice(i, i + 3).forEach((p, j) => {
          const x = PAGE.left + j * (cellW + gap);
          doc.rect(x, py, cellW, cellH).fillAndStroke(TINT, RULE);
          try {
            doc.image(p.path, x + 3, py + 3, { fit: [cellW - 6, cellH - 6], align: 'center', valign: 'center' });
          } catch {
            doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTE).text('PHOTO UNAVAILABLE', x, py + cellH / 2 - 4, { width: cellW, align: 'center' });
          }
          doc.font('Helvetica').fontSize(7).fillColor(MUTE).text(`Photo ${idx}.${i + j + 1}`, x, py + cellH + 4, { width: cellW, align: 'center' });
        });
        doc.y = py + cellH + 20;
      }
      doc.moveDown(0.6);
    }
  }

  // ── Letterhead and footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const { bottom } = doc.page.margins;
    doc.page.margins.bottom = 0;
    doc.rect(0, 0, 595.28, 72).fill(NAVY);
    doc.roundedRect(PAGE.left - 8, 13, 108, 46, 6).fill('#ffffff');
    if (logo) {
      try {
        doc.image(logo, PAGE.left - 2, 17, { fit: [96, 38], align: 'center', valign: 'center' });
      } catch {
        doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('AUAV', PAGE.left, 28);
      }
    } else {
      doc.font('Helvetica-Bold').fontSize(16).fillColor(NAVY).text('AUAV', PAGE.left, 28);
    }
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#ffffff')
      .text(template.reportTitle.toUpperCase(), 250, 25, { width: PAGE.right - 250, align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#c9d4df')
      .text(subtitle, 250, 41, { width: PAGE.right - 250, align: 'right' });
    doc.moveTo(PAGE.left, 800).lineTo(PAGE.right, 800).lineWidth(0.5).stroke(RULE);
    doc.font('Helvetica').fontSize(7).fillColor(MUTE).text(FOOTER, PAGE.left, 808, { lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.right - 100, 808, { width: 100, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
