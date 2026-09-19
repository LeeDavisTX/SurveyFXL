/* ============================================================
   Feature Definition Manager CSV.

   FDM both writes and reads this, so what we write has to match what it
   writes, byte for byte in shape: a UTF-8 BOM, CRLF line endings, and six
   sections one after another with no blank lines between them. Every
   section is a header row plus its data rows; a section with no codes is
   its header alone, and FDM still expects it to be there.

   Each row is a fixed set of columns for that geometry, then a tail of
   flattened attribute name,type pairs under the last header cell,
   "Attributes (name and type)".

   What the format cannot carry: menu options, Required vs Optional,
   minimum, maximum, decimals, defaults, descriptions. Those are exactly
   what the QAQC tab checks, so an import recovers them from the library it
   is replacing wherever the same code and attribute still exist - see
   csvPriorIndex. The XLS export carries them properly.

   Depends on globals from app.js: uid, GEOMETRY_TAG, featureAttrValue.
   ============================================================ */

/* Column layouts, in FDM's order. The trailing attribute pairs are not
   listed here - they follow the fixed columns. Each entry is
   [csv column name, the FXL feature attribute it maps to]. */
const CSV_SECTIONS = [
  {
    geometry: "Point", tag: "PointFeatureDefinition",
    columns: [
      ["Name", "Name"], ["Code", "Code"], ["Category", "Category"],
      ["Feature Layer", "Layer"], ["Label Style", "PointLabelStyle"],
      ["Color", "Color"], ["Include in Surface", "IncludeInSurface"],
    ],
  },
  {
    geometry: "Line", tag: "LineFeatureDefinition",
    columns: [
      ["Name", "Name"], ["Code", "Code"], ["Category", "Category"],
      ["Feature Layer", "Layer"], ["Line Style", "LineStyleName"],
      ["Line Style Scale", "LineStyleScale"], ["Line Label Style", "LineLabelStyle"],
      ["Field Line Style", "FieldLineStyle"], ["Line Color", "Color"],
      ["Point Layer", "PointLayer"], ["Point Label Style", "PointLabelStyle"],
      ["Include in Surface", "IncludeInSurface"],
    ],
  },
  {
    geometry: "Polygon", tag: "PolygonFeatureDefinition",
    columns: [
      ["Name", "Name"], ["Code", "Code"], ["Category", "Category"],
      ["Feature Layer", "Layer"], ["Label Style", "PolygonLabelStyle"],
      ["Fill Color", "FillColor"], ["Fill Transparency", "FillTransparency"],
      ["Border Line Style", "BorderLineStyleName"], ["Border Line Style Scale", "BorderLineStyleScale"],
      ["Border Color", "BorderColor"], ["Field Border Line Style", "FieldBorderLineStyle"],
      ["Point Layer", "PointLayer"], ["Point Label Style", "PointLabelStyle"],
      ["Include in Surface", "IncludeInSurface"],
    ],
  },
  {
    /* This build has no block features, so the section is always written
       empty - but it is written, because FDM's own export always has it. */
    geometry: null, tag: "BlockFeatureDefinition",
    columns: [
      ["Name", "Name"], ["Code", "Code"], ["Category", "Category"],
      ["Feature Layer", "Layer"], ["Block Name", "BlockViewName"],
      ["Line Style", "LineStyleName"], ["Color", "Color"],
      ["Insertion", "ConstructionType"], ["Rotation", "BlockViewRotation"],
      ["Scale X", "BlockViewScaleX"], ["Scale Y", "BlockViewScaleY"],
      ["Scale Z", "BlockViewScaleZ"], ["Point Layer", "PointLayer"],
      ["Point Label Style", "PointLabelStyle"], ["Include in Surface", "IncludeInSurface"],
    ],
  },
];

/* Control codes and control code blocks: three plain columns, no attribute
   tail. Not modelled here, so they are written as bare headers. */
const CSV_CONTROL_HEADERS = [["Name", "Code", "Action"], ["Name", "Code", "Action"]];

const CSV_ATTR_HEADER = "Attributes (name and type)";

/* FDM writes only these three. An integer goes out as Numeric because that
   is a token FDM is known to accept; the integer-ness comes back from the
   library being replaced on import. */
const CSV_TYPE_FROM_TAG = {
  StringAttribute: "Text",
  ListAttribute: "List",
  DoubleAttribute: "Numeric",
  IntegerAttribute: "Numeric",
  PhotoAttribute: "Photo",
};
const CSV_TAG_FROM_TYPE = {
  text: "StringAttribute",
  string: "StringAttribute",
  list: "ListAttribute",
  menu: "ListAttribute",
  numeric: "DoubleAttribute",
  number: "DoubleAttribute",
  double: "DoubleAttribute",
  integer: "IntegerAttribute",
  int: "IntegerAttribute",
  photo: "PhotoAttribute",
};

/* FE000000 is the FXL's "take the layer's colour" sentinel, which FDM
   shows and writes as the words By Layer. */
const CSV_BY_LAYER = "By Layer";
const CSV_BY_LAYER_HEX = "FE000000";

/* ---------- writer ---------- */

function csvEscape(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(cells) {
  return cells.map(csvEscape).join(",") + "\r\n";
}

function csvColorOut(hex) {
  return !hex || hex.toUpperCase() === CSV_BY_LAYER_HEX ? CSV_BY_LAYER : hex;
}
function csvColorIn(text) {
  const t = (text || "").trim();
  return !t || t.toLowerCase() === CSV_BY_LAYER.toLowerCase() ? CSV_BY_LAYER_HEX : t;
}

function csvCellFor(code, fxlName) {
  if (fxlName === "IncludeInSurface") return code.includeInSurface ? "True" : "False";
  const raw = featureAttrValue(code, fxlName);
  if (fxlName === "Color" || fxlName === "FillColor" || fxlName === "BorderColor") return csvColorOut(raw);
  return raw;
}

/* Public: the whole library as one FDM-compatible CSV string. */
function buildLibraryCsv(codes) {
  let out = "﻿";
  for (const section of CSV_SECTIONS) {
    out += csvRow(section.columns.map(([label]) => label).concat(CSV_ATTR_HEADER));
    if (!section.geometry) continue;
    for (const c of codes || []) {
      if (c.geometry !== section.geometry) continue;
      const cells = section.columns.map(([, fxlName]) => csvCellFor(c, fxlName));
      for (const a of c.attributes || []) {
        cells.push(a.name, CSV_TYPE_FROM_TAG[a.tag] || "Text");
      }
      out += csvRow(cells);
    }
  }
  for (const h of CSV_CONTROL_HEADERS) out += csvRow(h);
  return out;
}

/* ---------- reader ---------- */

/* A whole-file CSV parse: handles quoted fields containing commas, quotes
   and newlines, and both CRLF and LF. */
function csvParse(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = "", quoted = false, i = 0;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r") { if (src[i + 1] === "\n") i++; endRow(); i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/* Which section a header row introduces, by the columns it names. */
function csvSectionFor(row) {
  const cells = row.map((c) => (c || "").trim());
  /* Found by the names present, not by their position: the columns are
     matched by name below, so a sheet someone reordered in Excel should
     still be recognised rather than failing as "not a Manager CSV". */
  if (!cells.includes("Name") || !cells.includes("Code")) return null;
  if (!cells.includes(CSV_ATTR_HEADER) && !cells.includes("Action")) return null;
  if (cells.includes("Block Name")) return { skip: true };
  if (cells.includes("Action")) return { skip: true };
  if (cells.includes("Fill Color")) return withIndex("Polygon", cells);
  if (cells.includes("Line Style")) return withIndex("Line", cells);
  if (cells.includes("Color") || cells.includes("Label Style")) return withIndex("Point", cells);
  return null;

  function withIndex(geometry, labels) {
    const section = CSV_SECTIONS.find((s) => s.geometry === geometry);
    /* Map by column name rather than position, so a file whose columns have
       been reordered or trimmed still reads correctly. */
    const index = {};
    section.columns.forEach(([label, fxlName]) => {
      const at = labels.indexOf(label);
      if (at !== -1) index[fxlName] = at;
    });
    const attrAt = labels.indexOf(CSV_ATTR_HEADER);
    return { section, index, attrAt: attrAt === -1 ? labels.length : attrAt };
  }
}

function csvNormKey(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "_");
}

/* Lookup into the library being replaced, so an import can restore the
   things the CSV has no column for. */
function csvPriorIndex(priorCodes) {
  const byCode = new Map(), byAttr = new Map();
  for (const c of priorCodes || []) {
    const k = csvNormKey(c.code);
    if (!byCode.has(k)) byCode.set(k, c);
    for (const a of c.attributes || []) {
      const ak = k + "|" + csvNormKey(a.name);
      if (!byAttr.has(ak)) byAttr.set(ak, a);
    }
  }
  return {
    code: (k) => byCode.get(k) || null,
    attr: (ck, ak) => byAttr.get(ck + "|" + ak) || null,
  };
}

/* Public: parse an FDM CSV into code objects shaped like the FXL parser's,
   ready for fxlFromCodes(). Returns { codes, warnings, restored }. */
function importCsvCodes(text, priorCodes) {
  const rows = csvParse(text);
  if (!rows.length) throw new Error("That file is empty.");

  const prior = csvPriorIndex(priorCodes);
  const codes = [];
  const seen = new Set();
  const warnings = [];
  let restored = 0;
  let current = null;
  let sawHeader = false;

  rows.forEach((row, n) => {
    if (!row.length || row.every((c) => !String(c).trim())) return;
    const asSection = csvSectionFor(row);
    if (asSection) { current = asSection.skip ? null : asSection; sawHeader = true; return; }
    if (!current) return;  // a row under Block or Control Code, or before any header

    const { section, index, attrAt } = current;
    const cell = (fxlName) => {
      const at = index[fxlName];
      return at === undefined ? "" : String(row[at] === undefined ? "" : row[at]).trim();
    };
    const code = cell("Code") || cell("Name");
    if (!code) { warnings.push(`Row ${n + 1}: no Code - skipped.`); return; }
    const key = csvNormKey(code);
    if (seen.has(key)) { warnings.push(`Row ${n + 1}: "${code}" was already defined earlier - this row was ignored.`); return; }
    seen.add(key);

    const was = prior.code(key);
    const extra = [];
    for (const [, fxlName] of section.columns) {
      if (["Name", "Code", "Category", "Layer", "Color", "IncludeInSurface", "PointLabelStyle"].includes(fxlName)) continue;
      const v = cell(fxlName);
      /* FillColor and BorderColor come through here rather than as the
         code's own colour, so they need the same By Layer translation -
         otherwise the words "By Layer" end up in the FXL where an ARGB
         value belongs. */
      if (v !== "") extra.push([fxlName, /Color$/.test(fxlName) ? csvColorIn(v) : v]);
    }

    const entry = {
      id: uid("code"),
      geometry: section.geometry,
      tag: GEOMETRY_TAG[section.geometry],
      code,
      name: cell("Name") || code,
      description: was ? was.description : "",
      category: cell("Category"),
      includeInSurface: !/^(false|no|0)$/i.test(cell("IncludeInSurface") || "true"),
      color: csvColorIn(cell("Color") || (was ? was.color : "")),
      layer: cell("Layer") || (was ? was.layer : "0"),
      pointLabelStyle: cell("PointLabelStyle"),
      extra,
      attributes: [],
    };
    if (section.geometry === "Polygon") entry.color = csvColorIn(cell("FillColor"));

    const tail = row.slice(attrAt);
    for (let j = 0; j + 1 < tail.length || (j < tail.length && String(tail[j]).trim()); j += 2) {
      const aName = String(tail[j] === undefined ? "" : tail[j]).trim();
      if (!aName) continue;
      const typeText = String(tail[j + 1] === undefined ? "" : tail[j + 1]).trim();
      let tag = CSV_TAG_FROM_TYPE[typeText.toLowerCase()];
      if (!tag) {
        tag = "StringAttribute";
        if (typeText) warnings.push(`Row ${n + 1}: attribute "${aName}" has an unrecognised type "${typeText}" - read as Text.`);
      }
      const wasAttr = prior.attr(key, csvNormKey(aName));
      /* The CSV says what an attribute is called and what type it is, and
         nothing else. Everything else comes back from the library this
         import is replacing when the attribute is still the same type. */
      const keep = wasAttr && wasAttr.tag === tag ? wasAttr : null;
      if (keep) restored++;
      const a = {
        id: uid("attr"), tag, name: aName,
        description: keep ? keep.description : "",
        entryMethod: keep ? keep.entryMethod : "Optional",
        isLabelVisible: keep ? keep.isLabelVisible : true,
        hadLabelVisible: keep ? keep.hadLabelVisible : false,
        extra: keep ? keep.extra.slice() : [],
        /* A default belongs to a text attribute as much as a numeric one. */
        defaultValue: keep ? keep.defaultValue || "" : "",
      };
      if (tag === "DoubleAttribute" || tag === "IntegerAttribute") {
        a.minimumValue = keep ? keep.minimumValue : "";
        a.maximumValue = keep ? keep.maximumValue : "";
        a.numberOfDecimals = keep ? keep.numberOfDecimals : "";
      }
      if (tag === "ListAttribute") a.listItems = keep ? (keep.listItems || []).slice() : [];
      entry.attributes.push(a);
    }

    codes.push(entry);
  });

  if (!sawHeader) {
    throw new Error("This does not look like a Feature Definition Manager CSV - no header row naming Name and Code was found.");
  }
  if (!codes.length) throw new Error("No feature codes were found in that CSV.");
  return { codes, warnings, restored };
}
