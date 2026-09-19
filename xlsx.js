/* ============================================================
   Minimal XLSX (Office Open XML spreadsheet) reader/writer.
   No external libraries - an xlsx file is just a zip of small XML
   parts, so this reuses the app's own zip writer/reader (makeZip,
   readZip) and builds the handful of parts Excel/Google Sheets/
   LibreOffice all need to open the file.

   Depends on globals defined in app.js: escXml, uid, makeZip, readZip,
   ATTR_TAGS, TYPE_LABEL, GEOMETRY_TAG.
   ============================================================ */

const XLSX_HEADERS = {
  codes: ["Code", "Name", "Geometry", "Category", "Description", "In Surface"],
  attributes: ["Code", "Order", "Attribute Name", "Prompt", "Type", "Entry", "Min", "Max", "Decimals", "Default"],
  options: ["Code", "Attribute Name", "Order", "Option"],
};

const XLSX_TYPE_TO_TAG = { text: "StringAttribute", number: "DoubleAttribute", integer: "IntegerAttribute", menu: "ListAttribute" };

/* ---------- writer ---------- */

function xlsxColLetter(idx0) {
  let n = idx0 + 1, s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* Every cell is written as an inline string (t="inlineStr"); Excel and
   Google Sheets both read and re-save these fine, and it keeps the writer
   to one code path with no shared-strings table to maintain. */
function xlsxCell(colIdx, rowNum, value, header) {
  const ref = xlsxColLetter(colIdx) + rowNum;
  const text = value === undefined || value === null ? "" : String(value);
  const s = header ? ' s="1"' : "";
  if (!text) return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(text)}</t></is></c>`;
}

/* The header row is frozen and the columns are given sensible widths - this
   workbook exists to be edited by hand, and neither is worth making the user
   set up every time. Element order matters to Excel: sheetViews, then cols,
   then sheetData. */
function xlsxSheetXml(rows, widths) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0">',
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '</sheetView></sheetViews>'];
  if (widths && widths.length) {
    out.push("<cols>");
    widths.forEach((w, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
    out.push("</cols>");
  }
  out.push("<sheetData>");
  rows.forEach((row, ri) => {
    const rowNum = ri + 1;
    const cells = row.map((val, ci) => xlsxCell(ci, rowNum, val, ri === 0)).join("");
    out.push(`<row r="${rowNum}">${cells}</row>`);
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

const XLSX_WIDTHS = {
  codes: [22, 22, 11, 18, 60, 11],
  attributes: [22, 7, 24, 34, 10, 10, 9, 9, 10, 12],
  options: [22, 24, 7, 26],
};

const XLSX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const XLSX_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const XLSX_WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets>' +
  '<sheet name="Codes" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Attributes" sheetId="2" r:id="rId2"/>' +
  '<sheet name="Options" sheetId="3" r:id="rId3"/>' +
  '</sheets></workbook>';

const XLSX_WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

/* Two cell styles: 0 = default, 1 = bold header row. */
const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" xfId="0"/><xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/* Public: build a three-sheet workbook (Codes / Attributes / Options) from
   the app's code objects. Returns a Blob. */
function buildLibraryXlsx(codes) {
  const codesRows = [XLSX_HEADERS.codes];
  const attrRows = [XLSX_HEADERS.attributes];
  const optRows = [XLSX_HEADERS.options];

  for (const c of codes) {
    codesRows.push([c.code, c.name, c.geometry, c.category, c.description, c.includeInSurface ? "TRUE" : "FALSE"]);
    (c.attributes || []).forEach((a, i) => {
      attrRows.push([
        c.code, i + 1, a.name, a.description, TYPE_LABEL[a.tag] || "Text", a.entryMethod,
        a.minimumValue ?? "", a.maximumValue ?? "", a.numberOfDecimals ?? "", a.defaultValue ?? "",
      ]);
      if (a.tag === "ListAttribute") {
        (a.listItems || []).forEach((opt, oi) => optRows.push([c.code, a.name, oi + 1, opt]));
      }
    });
  }

  return makeZip([
    { name: "[Content_Types].xml", data: XLSX_CONTENT_TYPES },
    { name: "_rels/.rels", data: XLSX_ROOT_RELS },
    { name: "xl/workbook.xml", data: XLSX_WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", data: XLSX_WORKBOOK_RELS },
    { name: "xl/styles.xml", data: XLSX_STYLES },
    { name: "xl/worksheets/sheet1.xml", data: xlsxSheetXml(codesRows, XLSX_WIDTHS.codes) },
    { name: "xl/worksheets/sheet2.xml", data: xlsxSheetXml(attrRows, XLSX_WIDTHS.attributes) },
    { name: "xl/worksheets/sheet3.xml", data: xlsxSheetXml(optRows, XLSX_WIDTHS.options) },
  ], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/* ---------- reader ---------- */

function xlsxColIndexFromRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref || "");
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxParseSharedStrings(xmlText) {
  if (!xmlText) return [];
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  if (dom.querySelector("parsererror")) return [];
  return Array.from(dom.getElementsByTagName("si")).map((si) =>
    Array.from(si.getElementsByTagName("t")).map((t) => t.textContent).join("")
  );
}

/* Returns [{ r, cells }] sorted by spreadsheet row number, where cells is
   keyed by 0-based column index (sparse - Excel omits empty cells entirely,
   so positions come from each cell's r="B4" reference, never from counting).
   The row number is kept so warnings can point at the real spreadsheet line
   even when Excel has dropped blank rows in the middle. */
function xlsxParseSheetRows(xmlText, sharedStrings) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  if (dom.querySelector("parsererror")) return [];
  const rows = [];
  let seq = 0;
  for (const rowEl of Array.from(dom.getElementsByTagName("row"))) {
    seq++;
    const rNum = parseInt(rowEl.getAttribute("r"), 10);
    const cells = [];
    for (const c of Array.from(rowEl.getElementsByTagName("c"))) {
      const idx = xlsxColIndexFromRef(c.getAttribute("r"));
      if (idx < 0) continue;
      const t = c.getAttribute("t") || "";
      let text = "";
      if (t === "inlineStr") {
        const isEl = c.getElementsByTagName("is")[0];
        text = isEl ? Array.from(isEl.getElementsByTagName("t")).map((x) => x.textContent).join("") : "";
      } else if (t === "s") {
        const vEl = c.getElementsByTagName("v")[0];
        const i = vEl ? parseInt(vEl.textContent, 10) : NaN;
        text = Number.isFinite(i) && sharedStrings[i] !== undefined ? sharedStrings[i] : "";
      } else {
        const vEl = c.getElementsByTagName("v")[0];
        text = vEl ? vEl.textContent : "";
      }
      cells[idx] = text;
    }
    rows.push({ r: Number.isFinite(rNum) && rNum > 0 ? rNum : seq, cells });
  }
  rows.sort((a, b) => a.r - b.r);
  return rows;
}

/* Public: unzip and parse an .xlsx into { sheetRows(name) }. Throws if the
   file doesn't look like a workbook at all. */
async function readXlsxWorkbook(buffer) {
  const files = await readZip(buffer);
  const byName = {};
  for (const f of files) byName[f.name] = f.text;

  const workbookXml = byName["xl/workbook.xml"];
  const relsXml = byName["xl/_rels/workbook.xml.rels"];
  if (!workbookXml) throw new Error("This does not look like an Excel workbook (no xl/workbook.xml found in the file).");

  const wbDom = new DOMParser().parseFromString(workbookXml, "application/xml");
  const relTarget = {};
  if (relsXml) {
    const relDom = new DOMParser().parseFromString(relsXml, "application/xml");
    for (const r of Array.from(relDom.getElementsByTagName("Relationship"))) {
      relTarget[r.getAttribute("Id")] = r.getAttribute("Target");
    }
  }

  const sheetPath = {};
  for (const s of Array.from(wbDom.getElementsByTagName("sheet"))) {
    const name = (s.getAttribute("name") || "").trim();
    const rId = s.getAttribute("r:id") ||
      s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    let target = relTarget[rId];
    if (target) {
      if (!/^xl\//.test(target) && !target.startsWith("/")) target = "xl/" + target;
      target = target.replace(/^\//, "");
    }
    sheetPath[name.toLowerCase()] = target;
  }

  const sharedStrings = xlsxParseSharedStrings(byName["xl/sharedStrings.xml"]);

  return {
    sheetRows(name) {
      const path = sheetPath[name.toLowerCase()];
      if (!path || !byName[path]) return null;
      return xlsxParseSheetRows(byName[path], sharedStrings);
    },
  };
}

function xlsxHeaderIndex(rows) {
  const map = {};
  ((rows[0] && rows[0].cells) || []).forEach((label, i) => {
    if (label) map[String(label).trim().toLowerCase()] = i;
  });
  return map;
}
function xlsxCellAt(cells, idx) {
  if (idx === undefined || idx < 0 || !cells) return "";
  const v = cells[idx];
  return v === undefined || v === null ? "" : String(v).trim();
}
/* Matching key only. Names and option text are stored exactly as the sheet
   has them, so a library that came from an FXL with "HOT PASS" or a mixed
   case option survives a trip through Excel unchanged. */
function xlsxNormKey(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "_");
}
function xlsxRowIsBlank(cells) {
  return !cells || !cells.some((v) => v !== undefined && String(v).trim() !== "");
}

/* Public: turn parsed sheet rows into an array of code objects shaped
   exactly like FxlDocument._readCode()/_readAttr() output, so the result
   can be handed straight to fxlFromCodes(). Rows that reference a code or
   attribute that doesn't (yet) exist are skipped and reported, not fatal -
   an import should recover what it can from a hand-edited spreadsheet. */
function importXlsxCodes(wb, priorCodes) {
  const codesRows = wb.sheetRows("Codes");
  if (!codesRows || codesRows.length < 1) {
    throw new Error('No "Codes" sheet found (or it is empty). Export a workbook from this app first to see the exact layout expected.');
  }
  const cIdx = xlsxHeaderIndex(codesRows);
  for (const need of ["Code", "Geometry"]) {
    if (!(need.toLowerCase() in cIdx)) throw new Error(`The Codes sheet is missing a "${need}" column.`);
  }

  const prior = xlsxPriorIndex(priorCodes);
  const codes = [];
  const byCode = new Map();
  const warnings = [];

  for (let i = 1; i < codesRows.length; i++) {
    const { r, cells } = codesRows[i];
    if (xlsxRowIsBlank(cells)) continue;
    const code = xlsxCellAt(cells, cIdx["code"]);
    if (!code) { warnings.push(`Codes row ${r}: no Code value - skipped.`); continue; }
    const key = xlsxNormKey(code);
    if (byCode.has(key)) { warnings.push(`Codes row ${r}: "${code}" was already defined earlier in the sheet - this row was ignored.`); continue; }
    const geomRaw = xlsxCellAt(cells, cIdx["geometry"]);
    const geometry = ["Point", "Line", "Polygon"].includes(geomRaw) ? geomRaw : "Point";
    const was = prior.code(key);
    const entry = {
      id: uid("code"), geometry, tag: GEOMETRY_TAG[geometry],
      code, name: xlsxCellAt(cells, cIdx["name"]) || code,
      description: xlsxCellAt(cells, cIdx["description"]),
      category: xlsxCellAt(cells, cIdx["category"]),
      includeInSurface: !/^(false|no|0)$/i.test(xlsxCellAt(cells, cIdx["in surface"]) || "true"),
      /* The workbook carries no styling, so anything the sheet cannot
         express is taken back from the library this import is replacing
         when the same code is still there - an export/edit/re-import round
         trip should not quietly reset colors, layers or anything in the
         FXL this build does not model. */
      color: was ? was.color : "FE000000",
      layer: was ? was.layer : "0",
      pointLabelStyle: was ? was.pointLabelStyle : "",
      extra: was ? was.extra.slice() : [],
      attributes: [],
    };
    codes.push(entry);
    byCode.set(key, entry);
  }
  if (!codes.length) throw new Error("The Codes sheet has no usable rows - every row is missing a Code value.");

  const attrRows = wb.sheetRows("Attributes");
  if (attrRows && attrRows.length > 1) {
    const aIdx = xlsxHeaderIndex(attrRows);
    for (const need of ["Code", "Attribute Name", "Type"]) {
      if (!(need.toLowerCase() in aIdx)) throw new Error(`The Attributes sheet is missing a "${need}" column.`);
    }
    const byCodeAttrs = new Map();
    for (let i = 1; i < attrRows.length; i++) {
      const { r, cells } = attrRows[i];
      if (xlsxRowIsBlank(cells)) continue;
      const codeRaw = xlsxCellAt(cells, aIdx["code"]);
      const key = xlsxNormKey(codeRaw);
      const target = byCode.get(key);
      if (!target) { warnings.push(`Attributes row ${r}: code "${codeRaw}" is not in the Codes sheet - skipped.`); continue; }
      const name = xlsxCellAt(cells, aIdx["attribute name"]);
      if (!name) { warnings.push(`Attributes row ${r}: no Attribute Name - skipped.`); continue; }
      const typeRaw = xlsxCellAt(cells, aIdx["type"]);
      const tag = XLSX_TYPE_TO_TAG[typeRaw.toLowerCase()] || (ATTR_TAGS.includes(typeRaw) ? typeRaw : "StringAttribute");
      const wasAttr = prior.attr(key, xlsxNormKey(name), tag);
      const attr = {
        id: uid("attr"), tag, name,
        description: xlsxCellAt(cells, aIdx["prompt"]),
        entryMethod: /^required$/i.test(xlsxCellAt(cells, aIdx["entry"])) ? "Required" : "Optional",
        isLabelVisible: wasAttr ? wasAttr.isLabelVisible : true,
        extra: wasAttr ? wasAttr.extra.slice() : [],
      };
      if (tag === "DoubleAttribute" || tag === "IntegerAttribute") {
        attr.minimumValue = xlsxCellAt(cells, aIdx["min"]);
        attr.maximumValue = xlsxCellAt(cells, aIdx["max"]);
        attr.numberOfDecimals = xlsxCellAt(cells, aIdx["decimals"]);
        attr.defaultValue = xlsxCellAt(cells, aIdx["default"]);
      }
      if (tag === "ListAttribute") attr.listItems = [];
      const orderRaw = parseFloat(xlsxCellAt(cells, aIdx["order"]));
      let list = byCodeAttrs.get(key);
      if (!list) byCodeAttrs.set(key, (list = []));
      list.push({ order: Number.isFinite(orderRaw) ? orderRaw : list.length, seq: list.length, attr });
    }
    for (const [key, list] of byCodeAttrs) {
      list.sort((a, b) => a.order - b.order || a.seq - b.seq);
      byCode.get(key).attributes = list.map((x) => x.attr);
    }
  }

  const optRows = wb.sheetRows("Options");
  if (optRows && optRows.length > 1) {
    const oIdx = xlsxHeaderIndex(optRows);
    for (const need of ["Code", "Attribute Name", "Option"]) {
      if (!(need.toLowerCase() in oIdx)) throw new Error(`The Options sheet is missing a "${need}" column.`);
    }
    const byKey = new Map();
    for (let i = 1; i < optRows.length; i++) {
      const { r, cells } = optRows[i];
      if (xlsxRowIsBlank(cells)) continue;
      const codeRaw = xlsxCellAt(cells, oIdx["code"]);
      const codeKey = xlsxNormKey(codeRaw);
      const attrRaw = xlsxCellAt(cells, oIdx["attribute name"]);
      const attrKey = xlsxNormKey(attrRaw);
      const value = xlsxCellAt(cells, oIdx["option"]);
      if (!value) continue;
      const target = byCode.get(codeKey);
      if (!target) { warnings.push(`Options row ${r}: code "${codeRaw}" is not in the Codes sheet - skipped.`); continue; }
      const matches = target.attributes.filter((a) => a.tag === "ListAttribute" && xlsxNormKey(a.name) === attrKey);
      if (!matches.length) { warnings.push(`Options row ${r}: "${attrRaw}" is not a Menu attribute on ${target.code} - skipped.`); continue; }
      const orderRaw = parseFloat(xlsxCellAt(cells, oIdx["order"]));
      const key = codeKey + "|" + attrKey;
      let group = byKey.get(key);
      if (!group) byKey.set(key, (group = { attrs: matches, items: [] }));
      group.items.push({ order: Number.isFinite(orderRaw) ? orderRaw : group.items.length, seq: group.items.length, value });
    }
    for (const [, group] of byKey) {
      group.items.sort((a, b) => a.order - b.order || a.seq - b.seq);
      const items = group.items.map((x) => x.value);
      /* Two Menu attributes on one code sharing a name cannot be told apart
         by the Options sheet, so both get the same list and the user is
         told rather than one of them silently coming back empty. */
      for (const a of group.attrs) a.listItems = items.slice();
      if (group.attrs.length > 1) {
        warnings.push(`${group.attrs.length} Menu attributes named "${group.attrs[0].name}" share one code - each was given the same option list.`);
      }
    }
  }

  return { codes, warnings };
}

/* Lookup into the library being replaced, so an import can recover the
   fields the workbook has no column for. */
function xlsxPriorIndex(priorCodes) {
  const codeMap = new Map();
  const attrMap = new Map();
  for (const c of priorCodes || []) {
    const key = xlsxNormKey(c.code);
    if (!codeMap.has(key)) codeMap.set(key, c);
    for (const a of c.attributes || []) {
      const ak = key + "|" + xlsxNormKey(a.name) + "|" + a.tag;
      if (!attrMap.has(ak)) attrMap.set(ak, a);
    }
  }
  return {
    code: (key) => codeMap.get(key) || null,
    attr: (codeKey, nameKey, tag) => attrMap.get(codeKey + "|" + nameKey + "|" + tag) || null,
  };
}
