/* ============================================================
   Minimal PDF writer + feature library report layout.
   No external libraries: uses the PDF base-14 fonts, which need no
   embedding, so the page keeps working offline and behind a firewall.
   ============================================================ */

/* ---------- font metrics (Adobe AFM widths, units/1000, codes 32-126) ---------- */
const W_HELV = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584
];
const W_HELV_B = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584
];

const PDF_FONTS = {
  helv: { res: "F1", base: "Helvetica", widths: W_HELV },
  bold: { res: "F2", base: "Helvetica-Bold", widths: W_HELV_B },
  ital: { res: "F3", base: "Helvetica-Oblique", widths: W_HELV },
  mono: { res: "F4", base: "Courier", widths: null }, // fixed 600
};

/* Content is written as WinAnsi; anything outside the metric table is
   replaced so widths stay truthful and the stream stays byte-safe. */
function pdfSafe(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[^\x20-\x7E]/g, (ch) => {
    if (ch === "’" || ch === "‘") return "'";
    if (ch === "“" || ch === "”") return '"';
    if (ch === "–" || ch === "—") return "-";
    return "?";
  });
}
function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function textWidth(str, fontKey, size) {
  const f = PDF_FONTS[fontKey];
  if (!f.widths) return str.length * 0.6 * size;
  let total = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    total += c >= 32 && c <= 126 ? f.widths[c - 32] : 556;
  }
  return (total / 1000) * size;
}

function wrapText(str, fontKey, size, maxWidth) {
  const clean = pdfSafe(str).replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines = [];
  let line = "";
  for (let w of words) {
    // hard-split a word longer than the column
    while (textWidth(w, fontKey, size) > maxWidth) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), fontKey, size) > maxWidth) cut--;
      if (line) { lines.push(line); line = ""; }
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const probe = line ? line + " " + w : w;
    if (textWidth(probe, fontKey, size) <= maxWidth) line = probe;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/* ---------- document builder ---------- */
class PdfDoc {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.pages = [];
    this.cur = null;
  }
  addPage() {
    this.cur = { ops: [] };
    this.pages.push(this.cur);
    return this.cur;
  }
  /* y is measured from the top of the page */
  text(x, yTop, str, fontKey, size, color) {
    const s = pdfEscape(pdfSafe(str));
    if (!s) return;
    const [r, g, b] = color || [0, 0, 0];
    this.cur.ops.push(
      `${fmt(r)} ${fmt(g)} ${fmt(b)} rg`,
      `BT /${PDF_FONTS[fontKey].res} ${fmt(size)} Tf 1 0 0 1 ${fmt(x)} ${fmt(this.height - yTop)} Tm (${s}) Tj ET`
    );
  }
  line(x1, yTop1, x2, yTop2, color, lw) {
    const [r, g, b] = color || [0, 0, 0];
    this.cur.ops.push(
      `${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(lw === undefined ? 0.5 : lw)} w`,
      `${fmt(x1)} ${fmt(this.height - yTop1)} m ${fmt(x2)} ${fmt(this.height - yTop2)} l S`
    );
  }
  rect(x, yTop, w, hgt, color) {
    const [r, g, b] = color || [0, 0, 0];
    this.cur.ops.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg`, `${fmt(x)} ${fmt(this.height - yTop - hgt)} ${fmt(w)} ${fmt(hgt)} re f`);
  }

  build() {
    const objects = [];
    const push = (body) => { objects.push(body); return objects.length; };

    const fontIds = {};
    for (const key of Object.keys(PDF_FONTS)) {
      const f = PDF_FONTS[key];
      fontIds[key] = push(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`);
    }
    const fontRes = Object.keys(PDF_FONTS)
      .map((k) => `/${PDF_FONTS[k].res} ${fontIds[k]} 0 R`)
      .join(" ");

    // fonts, then two objects per page, then the Pages node itself
    const pagesId = objects.length + this.pages.length * 2 + 1;
    const pageIds = [];
    for (const pg of this.pages) {
      const stream = pg.ops.join("\n");
      const contentId = push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageId = push(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(this.width)} ${fmt(this.height)}] ` +
        `/Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`
      );
      pageIds.push(pageId);
    }
    const realPagesId = push(`<< /Type /Pages /Kids [${pageIds.map((i) => i + " 0 R").join(" ")}] /Count ${pageIds.length} >>`);
    const catalogId = push(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

    // page objects referenced pagesId before it existed; patch if it differs
    if (realPagesId !== pagesId) {
      for (const pid of pageIds) {
        objects[pid - 1] = objects[pid - 1].replace(/\/Parent \d+ 0 R/, `/Parent ${realPagesId} 0 R`);
      }
    }

    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefPos = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: "application/pdf" });
  }
}
function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

/* ============================================================
   Feature library report
   D3's column structure, drawn in the app's visual language.
   ============================================================ */

const PDF_NAVY = [0, 45 / 255, 98 / 255];
const PDF_BLUE = [0, 118 / 255, 192 / 255];
const PDF_GRAY = [167 / 255, 169 / 255, 172 / 255];
const PDF_INK = [0.09, 0.09, 0.11];
const PDF_INK2 = [0.29, 0.32, 0.35];

const PAGE_W = 792, PAGE_H = 612, MARGIN = 40;
const COL = {
  code: { x: 40, w: 148 },
  desc: { x: 196, w: 200 },
  num: { x: 404, w: 18 },
  attr: { x: 428, w: 144 },
  dict: { x: 580, w: 86 },
  req: { x: 674, w: 78 },
};
const TOP_RULE = 62;      // y of the rule under the running head
const BODY_TOP = 88;      // first baseline of body content
const BODY_BOTTOM = PAGE_H - 46;
const CODE_GAP = 15;      // space between code blocks, holds the separator rule

const DICT_LABEL = {
  StringAttribute: "Text",
  DoubleAttribute: "Number",
  IntegerAttribute: "Integer",
  ListAttribute: "Menu",
};

function drawRunningHead(doc, title, dateStr, pageNo, totalPages, subtitle) {
  doc.text(MARGIN, 40, title, "bold", 11, PDF_NAVY);
  if (subtitle) doc.text(MARGIN, 53, subtitle, "helv", 8, PDF_INK2);
  const right = PAGE_W - MARGIN;
  const dw = textWidth(pdfSafe(dateStr), "helv", 8);
  doc.text(right - dw, 40, dateStr, "helv", 8, PDF_INK2);
  const pageLabel = `Page ${pageNo} of ${totalPages}`;
  const pw = textWidth(pdfSafe(pageLabel), "helv", 8);
  doc.text(right - pw, 53, pageLabel, "helv", 8, PDF_INK2);
  doc.line(MARGIN, TOP_RULE, right, TOP_RULE, PDF_BLUE, 1.2);
}

function drawColumnHeads(doc, y) {
  const heads = [
    [COL.code.x, "CODE"], [COL.desc.x, "DESCRIPTION"], [COL.num.x, "#"],
    [COL.attr.x, "ATTRIBUTE"], [COL.dict.x, "DICTIONARY"], [COL.req.x, "REQUIRED"],
  ];
  for (const [x, label] of heads) doc.text(x, y, label, "bold", 7.5, PDF_INK2);
  doc.line(MARGIN, y + 4, PAGE_W - MARGIN, y + 4, PDF_GRAY, 0.5);
}

/* Lay the body out. `doc` null means a dry run - the flow is identical either
   way, so the page count and the page each code lands on are the same in both
   passes, which is what keeps the table of contents honest. */
function layoutBody(doc, codes, descriptions, meta, pageOffset, totalPages) {
  let page = 0;
  let y = 0;
  let continuing = null; // code being carried onto a new page
  const codePages = {};

  function startPage() {
    page++;
    if (doc) {
      doc.addPage();
      drawRunningHead(doc, meta.title, meta.dateStr, page + pageOffset, totalPages, meta.subtitle);
      drawColumnHeads(doc, BODY_TOP - 14);
    }
    y = BODY_TOP;
    if (continuing && doc) {
      doc.text(COL.code.x, y, continuing.code, "bold", 9.5, PDF_NAVY);
      const cw = textWidth(pdfSafe(continuing.code), "bold", 9.5);
      doc.text(COL.code.x + cw + 8, y, "continued", "ital", 7, PDF_GRAY);
    }
    if (continuing) y += 15;
  }
  /* Start a new page when the next chunk will not fit on this one. */
  function ensure(need) {
    if (y > BODY_TOP && y + need > BODY_BOTTOM) startPage();
  }

  startPage();

  for (const code of codes) {
    const descText = descriptions[code.code.trim().toUpperCase()] || "";
    /* The description sits inline beside the code - "NG - Natural Ground" -
       and only spills onto further lines when it is too long for the room. */
    const codeW = textWidth(pdfSafe(code.code), "bold", 9.5);
    const geoText = (code.geometry || "Point") + (code.category ? "  |  " + code.category : "");
    const geoW = textWidth(pdfSafe(geoText), "helv", 7);
    const geoX = PAGE_W - MARGIN - geoW;
    const descX = COL.code.x + codeW + 10;
    const descW = Math.max(120, geoX - descX - 14);
    const descLines = descText ? wrapText("- " + descText, "ital", 8, descW) : [];
    const headHeight = 13 + Math.max(0, descLines.length - 1) * 10 + 5;

    continuing = null;
    // keep a code's title with at least its first attribute row
    ensure(headHeight + 14);
    codePages[code.id] = page + pageOffset;

    if (doc) {
      doc.text(COL.code.x, y, code.code, "bold", 9.5, PDF_NAVY);
      doc.text(geoX, y, geoText, "helv", 7, PDF_GRAY);
      descLines.forEach((ln, k) => {
        if (k === 0) doc.text(descX, y, ln, "ital", 8, PDF_INK2);
        else doc.text(COL.code.x + 10, y + 13 + (k - 1) * 10, ln, "ital", 8, PDF_INK2);
      });
    }
    y += headHeight;

    const attrs = code.attributes || [];
    continuing = code;

    if (!attrs.length) {
      ensure(12);
      if (doc) doc.text(COL.attr.x, y, "No attributes defined", "ital", 8, PDF_GRAY);
      y += 12;
    }

    attrs.forEach((a, i) => {
      const nameLines = wrapText(a.name, "bold", 8, COL.attr.w);
      const promptLines = wrapText(a.description || "", "helv", 8, COL.desc.w);
      const rows = Math.max(nameLines.length, promptLines.length, 1);
      const options = a.tag === "ListAttribute" ? (a.listItems || []) : [];
      const rowHeight = rows * 10 + 3 + (options.length ? options.length * 9 + 2 : 0);

      // keep an attribute together with its option list where it fits
      ensure(Math.min(rowHeight, BODY_BOTTOM - BODY_TOP));

      if (doc) {
        doc.text(COL.num.x, y, String(i + 1), "mono", 8, PDF_GRAY);
        promptLines.forEach((ln, k) => doc.text(COL.desc.x, y + k * 10, ln, "helv", 8, PDF_INK2));
        nameLines.forEach((ln, k) => doc.text(COL.attr.x, y + k * 10, ln, "bold", 8, PDF_INK));
        doc.text(COL.dict.x, y, DICT_LABEL[a.tag] || "Text", "mono", 7.5, PDF_INK2);
        const required = a.entryMethod === "Required";
        doc.text(COL.req.x, y, required ? "Y" : "N", "bold", 8, required ? PDF_BLUE : PDF_GRAY);
      }
      y += rows * 10 + 3;

      for (const item of options) {
        ensure(9);
        if (doc) doc.text(COL.attr.x + 8, y, item, "helv", 7.5, PDF_INK2);
        y += 9;
      }
      if (options.length) y += 2;
    });

    continuing = null;
    y += 8;
    if (doc && y + CODE_GAP < BODY_BOTTOM) doc.line(MARGIN, y + 5, PAGE_W - MARGIN, y + 5, PDF_GRAY, 0.4);
    y += CODE_GAP;
  }
  return { pageCount: page, codePages };
}

function drawToc(doc, codes, codePages, meta, tocPages, totalPages) {
  const perCol = Math.floor((BODY_BOTTOM - BODY_TOP) / 12);
  const colXs = [MARGIN, MARGIN + 240, MARGIN + 480];
  let idx = 0;
  for (let p = 0; p < tocPages; p++) {
    doc.addPage();
    drawRunningHead(doc, meta.title, meta.dateStr, p + 1, totalPages, meta.subtitle);
    doc.text(MARGIN, BODY_TOP - 14, "CONTENTS", "bold", 7.5, PDF_INK2);
    doc.line(MARGIN, BODY_TOP - 10, PAGE_W - MARGIN, BODY_TOP - 10, PDF_GRAY, 0.5);
    for (let c = 0; c < colXs.length && idx < codes.length; c++) {
      let y = BODY_TOP + 4;
      for (let r = 0; r < perCol && idx < codes.length; r++, idx++) {
        const code = codes[idx];
        const pageNo = String(codePages[code.id] || "");
        doc.text(colXs[c], y, code.code, "helv", 8, PDF_INK);
        const pw = textWidth(pageNo, "mono", 8);
        doc.text(colXs[c] + 210 - pw, y, pageNo, "mono", 8, PDF_GRAY);
        y += 12;
      }
    }
  }
}

/* Public entry point. `descriptions` maps UPPERCASE code -> sentence. */
function buildLibraryPdf(codes, descriptions, meta) {
  const descMap = descriptions || {};
  // pass 1: how long is the body on its own?
  const dry = layoutBody(null, codes, descMap, meta, 0, 1);
  const perCol = Math.floor((BODY_BOTTOM - BODY_TOP) / 12);
  const tocPages = Math.max(1, Math.ceil(codes.length / (perCol * 3)));
  const totalPages = dry.pageCount + tocPages;

  // pass 2: real positions now that the offset is known
  const doc = new PdfDoc(PAGE_W, PAGE_H);
  const bodyDoc = new PdfDoc(PAGE_W, PAGE_H);
  const real = layoutBody(bodyDoc, codes, descMap, meta, tocPages, totalPages);

  drawToc(doc, codes, real.codePages, meta, tocPages, totalPages);
  doc.pages = doc.pages.concat(bodyDoc.pages);
  return doc.build();
}
