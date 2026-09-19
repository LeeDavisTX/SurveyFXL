/* ============================================================
   Survey FXL Toolkit
   FXL feature library editor + PNEZD attribute QAQC.
   Vanilla JS, no build step, no external dependencies.
   ============================================================ */

/* ---------- DOM helper ---------- */
const PROPS = new Set(["value", "checked", "disabled", "selected", "readOnly", "placeholder", "title", "type", "accept"]);

function h(tag, attrs, children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v === false || v === null || v === undefined) { /* omit */ }
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children === undefined ? [] : children)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}
function escXml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function uid(p) { return p + "_" + Math.random().toString(36).slice(2, 10); }

/* Codes and attribute names are stored upper case with underscores. Write the
   normalized text straight back into the box so what is shown and what is
   stored never drift apart, and keep the caret where the typist left it. */
function normalizeInto(input, raw) {
  const next = raw.toUpperCase().replace(/\s+/g, "_");
  if (input.value !== next) {
    const pos = input.selectionStart;
    const delta = raw.length - next.length;
    input.value = next;
    if (pos !== null) {
      const p = Math.max(0, pos - delta);
      try { input.setSelectionRange(p, p); } catch { /* not a text input */ }
    }
  }
  return next;
}

/* ============================================================
   FXL MODEL
   ============================================================ */

/* PhotoAttribute prompts the surveyor for a photo rather than a typed value,
   but it is still an attribute in the list and still takes its turn in the
   ATTRIBUTE1..N columns of an exported CSV - so it has to be modelled, or
   every attribute after it on that code lines up against the wrong column. */
const ATTR_TAGS = ["StringAttribute", "DoubleAttribute", "IntegerAttribute", "ListAttribute", "PhotoAttribute"];
const TYPE_LABEL = { StringAttribute: "Text", DoubleAttribute: "Number", IntegerAttribute: "Integer", ListAttribute: "Menu", PhotoAttribute: "Photo" };
/* OfficeUseOnly is filled in after the crew is off site, so QAQC treats it
   like Optional: a blank in the field data is not a finding. */
const ENTRY_LABEL = { Optional: "Optional", Required: "Required", OfficeUseOnly: "Office use only" };
const GEOMETRY = { PointFeatureDefinition: "Point", LineFeatureDefinition: "Line", PolygonFeatureDefinition: "Polygon" };
const GEOMETRY_TAG = { Point: "PointFeatureDefinition", Line: "LineFeatureDefinition", Polygon: "PolygonFeatureDefinition" };
const GEO_ABBR = { Point: "PT", Line: "LN", Polygon: "PG" };

/* Matches <FeatureDefinitions ...>...</FeatureDefinitions> or a self-closing
   <FeatureDefinitions ... />, with or without attributes on the tag. */
const FEATUREDEFS_RE = /<FeatureDefinitions\b([^>]*?)(\/>|>([\s\S]*?)<\/FeatureDefinitions>)/;

/* XML attributes this build understands. Anything else found on an element is
   preserved verbatim through an edit-and-export cycle. */
const CODE_KNOWN_ATTRS = ["Code", "Name", "Description", "Category", "IncludeInSurface", "Color", "Layer", "PointLabelStyle"];
const ATTR_KNOWN_ATTRS = ["Name", "Description", "EntryMethod", "IsLabelVisible", "MinimumValue", "MaximumValue", "NumberOfDecimals", "DefaultValue"];

/* XML kept verbatim from the loaded file. The serializer adds a redundant
   default namespace to anything it re-serializes, which is harmless but
   noisy, and writes an empty element as "/>" where an FXL uses " />". */
function cleanForeignXml(s) {
  return String(s)
    .replace(/ xmlns="http:\/\/trimble\.com\/schema\/fxl"/g, "")
    .replace(/([^ ])\/>/g, "$1 />");
}

function readForeignAttrs(attrsEl) {
  const out = [];
  let seen = 0;
  for (const el of Array.from(attrsEl.children)) {
    if (ATTR_TAGS.includes(el.tagName)) { seen++; continue; }
    out.push({ after: seen - 1, xml: cleanForeignXml(el.outerHTML) });
  }
  return out;
}

/* ---------- layers ----------
   A feature definition names the layer it draws on, and that layer has to be
   declared in <LayerDefinitions> or the file is not valid. The block is
   parsed so layers can be listed, renamed and added; anything inside a
   LayerDefinition this build does not model is carried through untouched. */
const LAYERDEFS_RE = /([ \t]*)<LayerDefinitions\b([^>]*?)(\/>|>([\s\S]*?)<\/LayerDefinitions>)/;
const LAYER_CHILD_ORDER = ["Name", "Color", "LineStyleName", "LineWeight", "ProtectLayer", "LayerGroup", "DisplayPriority", "Print"];
const LAYER_CHILD_DEFAULT = {
  Color: "FFFFFFFF", LineStyleName: "Solid", LineWeight: "0",
  ProtectLayer: "false", LayerGroup: "<<None>>", DisplayPriority: "64", Print: "true",
};

function readLayer(el) {
  const known = {};
  const extra = [];
  for (const child of Array.from(el.children)) {
    if (LAYER_CHILD_ORDER.includes(child.tagName) && !(child.tagName in known)) known[child.tagName] = child.textContent;
    else extra.push([child.tagName, child.textContent]);
  }
  return { id: uid("layer"), name: known.Name || "", fields: known, extra };
}

function makeLayer(name) {
  const fields = { Name: name };
  for (const k of LAYER_CHILD_ORDER) if (k !== "Name") fields[k] = LAYER_CHILD_DEFAULT[k];
  return { id: uid("layer"), name, fields, extra: [] };
}

function writeLayers(layers, indent, openAttrs) {
  const pad = indent || "  ";
  let out = `${pad}<LayerDefinitions${openAttrs || ""}>\n`;
  for (const L of layers) {
    out += `${pad}  <LayerDefinition>\n`;
    for (const k of LAYER_CHILD_ORDER) {
      const v = k === "Name" ? L.name : (L.fields[k] !== undefined ? L.fields[k] : LAYER_CHILD_DEFAULT[k]);
      if (v === undefined) continue;
      out += `${pad}    <${k}>${escXml(v)}</${k}>\n`;
    }
    for (const [tag, v] of L.extra) out += `${pad}    <${tag}>${escXml(v)}</${tag}>\n`;
    out += `${pad}  </LayerDefinition>\n`;
  }
  return out + `${pad}</LayerDefinitions>\n`;
}

/* A code's layer, and for a line or polygon the separate layer its vertex
   points land on. PointLayer is not modelled as its own field - it lives in
   the passthrough attributes, so this reads and writes it there. */
function codePointLayer(code) {
  return featureAttrValue(code, "PointLayer") || "0";
}
function setCodePointLayer(code, value) {
  const extra = code.extra || (code.extra = []);
  const at = extra.findIndex(([n]) => n === "PointLayer");
  if (at === -1) extra.push(["PointLayer", value]);
  else extra[at][1] = value;
}

/* Layers a code points at that the file never declares. An FXL like that is
   rejected by the Feature Definition Manager, so it is worth surfacing. */
function undeclaredLayers() {
  if (!state.fxl) return [];
  const declared = new Set((state.fxl.layers || []).map((L) => L.name));
  const missing = new Set();
  for (const c of state.fxl.codes) {
    if (c.layer && !declared.has(c.layer)) missing.add(c.layer);
    if (c.geometry !== "Point") {
      const pl = codePointLayer(c);
      if (pl && !declared.has(pl)) missing.add(pl);
    }
  }
  return Array.from(missing).sort((a, b) => a.localeCompare(b));
}

function layerCount(name) {
  if (!state.fxl) return 0;
  return state.fxl.codes.filter((c) => c.layer === name || (c.geometry !== "Point" && codePointLayer(c) === name)).length;
}

/* Everything a library built from scratch needs before its feature
   definitions, in the order a real FXL declares it: line styles, symbols,
   label styles, layers.

   All four have to be here even when nothing appears to use them. A feature
   definition names a line style, a layer and a label style - PointLabelStyle=""
   still has to resolve against a LabelStyles section - and the Feature
   Definition Manager dereferences them while reading, so a missing section is
   not a missing nicety, it is a NullReferenceException in PointDefinition.Read
   and a file that will not open at all.

   This mirrors the preamble of a real, working production library, trimmed to
   one line style, one symbol and the standard label styles. A loaded file
   keeps its own sections and never sees these. */
const BLANK_PREAMBLE =
  `  <LineStyleDefinitions Version="3.0" xmlns="http://trimble.com/schema/linestyle">\n` +
  `    <LineStyleDefinition Name="Solid" Description="">\n` +
  `      <Units Reference="Ground" Length="Metric" />\n` +
  `      <PatternType>Default</PatternType>\n` +
  `      <Pattern TotalLength="10000.000000" EndLength="0.000000">\n` +
  `        <Line Color="Empty" LineWeight="1">\n` +
  `          <Location X="0.000000" Y="0.000000" />\n` +
  `          <Location X="10000.000000" Y="0.000000" />\n` +
  `        </Line>\n` +
  `      </Pattern>\n` +
  `    </LineStyleDefinition>\n` +
  `  </LineStyleDefinitions>\n` +
  `  <SymbolDefinitions Version="2" xmlns="http://trimble.com/schema/symbol">\n` +
  `    <SymbolDefinition Name="Cross">\n` +
  `      <Units Reference="Paper" Length="Metric" />\n` +
  `      <Scale Size="Variable" Shape="Fixed" />\n` +
  `      <Rotation Type="Allow" />\n` +
  `      <Dimension First="Length" Second="Length" />\n` +
  `      <Color Name="BlueViolet" Red="138" Green="43" Blue="226" />\n` +
  `      <Component Number="1" Name="Cross">\n` +
  `        <Line Color="BlueViolet" LineWeight="1">\n` +
  `          <Location X="-2.000000" Y="-2.000000" />\n` +
  `          <Location X="2.000000" Y="2.000000" />\n` +
  `        </Line>\n` +
  `        <Line Color="BlueViolet" LineWeight="1">\n` +
  `          <Location X="-2.000000" Y="2.000000" />\n` +
  `          <Location X="2.000000" Y="-2.000000" />\n` +
  `        </Line>\n` +
  `      </Component>\n` +
  `      <Component Number="2" Name="" />\n` +
  `    </SymbolDefinition>\n` +
  `  </SymbolDefinitions>\n` +
  `  <LabelStyles SchemaVersion="1" xmlns="http://trimble.com/schema/labelstyle">\n` +
  `    <LineLabelStyles>\n` +
  `      <LineLabelStyle Name="Standard" Description="Line Label Style" Gap="2.5" LineSpacing="1.5" Layer="0" TextStyle="Standard">\n` +
  `        <LineLabels>\n` +
  `          <LineLabel xmlns="http://trimble.com/schema/linelabel">\n` +
  `            <Type>LineDistance</Type>\n` +
  `            <Prefix />\n` +
  `            <Units>ProjectSetting</Units>\n` +
  `            <Precision>ProjectSetting</Precision>\n` +
  `            <Angle>ProjectSetting</Angle>\n` +
  `            <Offset>1</Offset>\n` +
  `            <Along>0.5</Along>\n` +
  `          </LineLabel>\n` +
  `        </LineLabels>\n` +
  `      </LineLabelStyle>\n` +
  `    </LineLabelStyles>\n` +
  `    <PointLabelStyles>\n` +
  `      <PointLabelStyle Name="Standard" Description="Point Label Style" LabelAttributeValuesOnly="false" LabelAttributesVertically="false" AlignToSegment="false" Rotation="0" Gap="2.5" LineSpacing="1.5" Layer="0" TextStyle="Standard">\n` +
  `        <PointLabels>\n` +
  `          <PointLabel xmlns="http://trimble.com/schema/pointlabel">\n` +
  `            <Type>Name</Type>\n` +
  `            <SymbolSize>0</SymbolSize>\n` +
  `            <UseNumberGroupSeparator>false</UseNumberGroupSeparator>\n` +
  `            <Prefix />\n` +
  `            <Units>ProjectSetting</Units>\n` +
  `            <Precision>ProjectSetting</Precision>\n` +
  `            <Angle>ProjectSetting</Angle>\n` +
  `            <Offset>1</Offset>\n` +
  `            <Position>Right</Position>\n` +
  `          </PointLabel>\n` +
  `        </PointLabels>\n` +
  `      </PointLabelStyle>\n` +
  `    </PointLabelStyles>\n` +
  `    <PolygonLabelStyles>\n` +
  `      <PolygonLabelStyle Name="Standard" Description="Polygon Label Style" Rotation="0" Gap="2.5" LineSpacing="1.5" Layer="0" TextStyle="Standard">\n` +
  `        <PolygonLabels>\n` +
  `          <PolygonLabel xmlns="http://trimble.com/schema/polygonlabel">\n` +
  `            <Type>Name</Type>\n` +
  `            <Prefix />\n` +
  `            <Units>ProjectSetting</Units>\n` +
  `            <Precision>ProjectSetting</Precision>\n` +
  `            <Angle>ProjectSetting</Angle>\n` +
  `            <Offset>0</Offset>\n` +
  `            <Position>Center</Position>\n` +
  `          </PolygonLabel>\n` +
  `        </PolygonLabels>\n` +
  `      </PolygonLabelStyle>\n` +
  `    </PolygonLabelStyles>\n` +
  `    <TextStyleDefinition Name="Standard" Description="Text Style" xmlns="http://tempuri.org/TextStyleDefinition.xsd">\n` +
  `      <TypeFace>Courier New</TypeFace>\n` +
  `      <Bold>false</Bold>\n` +
  `      <AutoFlip>false</AutoFlip>\n` +
  `      <WhiteOut>false</WhiteOut>\n` +
  `      <Italic>false</Italic>\n` +
  `      <Underline>false</Underline>\n` +
  `      <Justification>CenterMiddle</Justification>\n` +
  `      <Height>5</Height>\n` +
  `      <WidthFactor>1</WidthFactor>\n` +
  `      <ObliqueAngle>0</ObliqueAngle>\n` +
  `      <Unit>Paper</Unit>\n` +
  `    </TextStyleDefinition>\n` +
  `  </LabelStyles>\n`;

/* Layer "0" always exists: it is what a code falls back to, and the label
   styles above name it. A from-scratch library writes this plus whatever
   layers the user has added. */
function blankLayers() {
  const zero = makeLayer("0");
  zero.fields.ProtectLayer = "true";
  return [zero];
}

/* ---------- feature definition attributes ----------
   Each geometry declares a different set, taken from Trimble's own
   GlobalFeatures.fxl. Getting this wrong is not cosmetic: the Feature
   Definition Manager validates against the schema and refuses the whole
   file over a single attribute it does not recognise. In particular a
   polygon has no Color - it carries FillColor and BorderColor instead -
   and an integer has no NumberOfDecimals.

   A code read from a real FXL already carries these in `extra`, so they
   round-trip untouched; the defaults below only fill in codes this app
   created itself (New code, an XLSX import, the sample data). */
const FEATURE_ATTR_ORDER = {
  PointFeatureDefinition: ["Code", "Name", "Category", "IncludeInSurface", "Color", "Layer", "PointLabelStyle"],
  LineFeatureDefinition: ["Code", "Name", "Category", "IncludeInSurface", "Color", "Layer",
    "FieldLineStyle", "LineStyleName", "LineStyleScale", "LineLabelStyle", "PointLabelStyle", "PointLayer"],
  PolygonFeatureDefinition: ["Code", "Name", "Category", "Layer", "IncludeInSurface",
    "FillColor", "FillTransparency", "FieldBorderLineStyle", "BorderColor", "BorderLineStyleName",
    "BorderLineStyleScale", "PolygonLabelStyle", "PointLabelStyle", "PointLayer"],
};

/* Every attribute name any geometry declares. Used to tell "this build does
   not model this" apart from "this belongs to a different geometry". */
const FEATURE_ATTR_ANY = new Set([].concat(...Object.values(FEATURE_ATTR_ORDER)));

const FEATURE_ATTR_DEFAULT = {
  FieldLineStyle: () => "Solid",
  LineStyleName: () => "Solid",
  LineStyleScale: () => "1",
  LineLabelStyle: () => "",
  PolygonLabelStyle: () => "",
  PointLayer: () => "0",
  FillTransparency: () => "50",
  FieldBorderLineStyle: () => "Solid",
  BorderLineStyleName: () => "Solid",
  BorderLineStyleScale: () => "1",
  FillColor: (c) => c.color || "FF808080",
  BorderColor: (c) => c.color || "FF808080",
};

/* The value of one FXL feature attribute for a code: from the code itself,
   from what the original file carried, or from the default for its geometry.
   Shared with the CSV writer so the two can never disagree. */
function featureAttrValue(c, name) {
  switch (name) {
    case "Code": return c.code;
    case "Name": return c.name || c.code;
    case "Category": return c.category;
    case "IncludeInSurface": return c.includeInSurface ? "true" : "false";
    case "Color": return c.color;
    case "Layer": return c.layer;
    case "PointLabelStyle": return c.pointLabelStyle || "";
    default: {
      for (const [n, v] of c.extra || []) if (n === name) return v;
      return FEATURE_ATTR_DEFAULT[name] ? FEATURE_ATTR_DEFAULT[name](c) : "";
    }
  }
}

function writeFeatureAttrs(c, tag) {
  const order = FEATURE_ATTR_ORDER[tag] || FEATURE_ATTR_ORDER.PointFeatureDefinition;
  const value = (n) => featureAttrValue(c, n);

  let out = order.map((n) => `${n}="${escXml(value(n))}"`).join(" ");
  /* Anything else the original file carried, so an attribute this build does
     not know about still survives a round trip.

     What must NOT come through is another geometry's attribute. A line code
     carries LineStyleName and PointLayer; switch it to Point in the editor
     and those are still sitting in the passthrough list, but a
     PointFeatureDefinition does not declare them - writing them out is the
     "attribute is not declared" refusal all over again. */
  const rest = (c.extra || []).filter(([n]) => !order.includes(n) && !FEATURE_ATTR_ANY.has(n));
  out += writeExtraAttrs(rest);
  return out;
}

/* ---------- code descriptions ----------
   Trimble's schema has nowhere to put a per-code description: Description is
   declared on an attribute, not on a feature definition, and the Feature
   Definition Manager rejects the entire file if one appears there. So the
   descriptions are written as a comment at the end of the document, which is
   valid XML anywhere, is ignored by every FXL reader, and still loads back
   into this app. A data collector never sees it.

   JSON handles quotes, newlines and unicode; the only thing a comment cannot
   contain is a double hyphen, so those are re-encoded as a JSON - escape
   that parses straight back to "-". */
const DESCRIPTIONS_RE = /[ \t]*<!--\s*SurveyFXLToolkit:Descriptions\s*([\s\S]*?)-->\r?\n?/;

function writeDescriptionNote(codes) {
  const map = {};
  for (const c of codes || []) {
    const key = (c.code || "").trim();
    if (key && c.description) map[key] = c.description;
  }
  if (!Object.keys(map).length) return "";
  const json = JSON.stringify(map, null, 1).replace(/--/g, "-\\u002D");
  return `  <!-- SurveyFXLToolkit:Descriptions\n${json}\n  -->\n`;
}

function readDescriptionNote(raw) {
  const m = DESCRIPTIONS_RE.exec(raw || "");
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[1].trim());
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/* Replaces any note already in the document with a current one, so repeated
   exports never stack up stale copies. */
function applyDescriptionNote(xml, codes) {
  let out = xml.replace(DESCRIPTIONS_RE, "");
  const note = writeDescriptionNote(codes);
  if (!note) return out;
  const close = out.lastIndexOf("</FeatureCodingDefinitions>");
  if (close === -1) return out + note;
  return out.slice(0, close) + note + out.slice(close);
}

/* "Data Dictionary File" is what the importer stamps on every code when an FXL
   is built from a Trimble data dictionary. It records where the library came
   from rather than describing the code, so it is treated as no category at all
   and the codes arrive uncategorized, ready to be sorted. */
const IMPORT_STAMP = /^data dictionary file$/i;

function normalizeCategory(value) {
  const s = (value || "").trim();
  return IMPORT_STAMP.test(s) ? "" : s;
}

function readExtraAttrs(el, known) {
  const out = [];
  for (const a of Array.from(el.attributes)) {
    if (!known.includes(a.name)) out.push([a.name, a.value]);
  }
  return out;
}
function writeExtraAttrs(extra) {
  return (extra || []).map(([n, v]) => ` ${n}="${escXml(v)}"`).join("");
}

class FxlDocument {
  constructor(rawXmlText, filename) {
    this.filename = filename || "untitled.fxl";
    this.raw = rawXmlText;
    this.parseError = null;
    this.codes = [];
    this._parse();
  }

  _parse() {
    let dom;
    try {
      dom = new DOMParser().parseFromString(this.raw, "application/xml");
    } catch (e) {
      this.parseError = "The file could not be read as XML. " + (e.message || "");
      return;
    }
    const perr = dom.querySelector("parsererror");
    if (perr) {
      this.parseError = "The file is not well-formed XML:\n" + perr.textContent.trim().slice(0, 300);
      return;
    }
    const layersEl = dom.getElementsByTagName("LayerDefinitions")[0];
    this.layers = layersEl
      ? Array.from(layersEl.children).filter((c) => c.tagName === "LayerDefinition").map(readLayer).filter((L) => L.name)
      : [];

    const defsEl = dom.getElementsByTagName("FeatureDefinitions")[0];
    if (!defsEl) {
      this.parseError = "No FeatureDefinitions section found. This does not look like an FXL feature library.";
      return;
    }
    this.codes = Array.from(defsEl.children)
      .filter((el) => GEOMETRY[el.tagName])
      .map((el) => this._readCode(el));

    /* A feature this build does not model - a BlockFeatureDefinition, say -
       is kept as the exact XML it arrived as and written back out. The
       feature definitions are rebuilt from scratch on export, so without
       this those codes would be dropped from the file without a word.
       Trimble's own GlobalFeatures.fxl has 19 of them. */
    this.foreignDefs = [];
    let seenCodes = 0;
    for (const el of Array.from(defsEl.children)) {
      if (GEOMETRY[el.tagName]) { seenCodes++; continue; }
      /* Anchored to the code it followed, so it is written back in roughly
         the same place rather than all of them landing at the end. */
      this.foreignDefs.push({ after: seenCodes - 1, xml: cleanForeignXml(el.outerHTML) });
    }

    /* Descriptions come from the comment this app writes. Older files that
       this app exported carried a Description attribute instead, which
       _readCode still picks up, so nothing written before is lost. */
    const notes = readDescriptionNote(this.raw);
    for (const c of this.codes) {
      const note = notes[(c.code || "").trim()];
      if (note) c.description = note;
    }
  }

  _readCode(el) {
    const attrsEl = Array.from(el.children).find((c) => c.tagName === "Attributes");
    return {
      id: uid("code"),
      geometry: GEOMETRY[el.tagName],
      tag: el.tagName,
      code: el.getAttribute("Code") || "",
      name: el.getAttribute("Name") || "",
      description: el.getAttribute("Description") || "",
      category: normalizeCategory(el.getAttribute("Category")),
      includeInSurface: el.getAttribute("IncludeInSurface") === "true",
      color: el.getAttribute("Color") || "FE000000",
      layer: el.getAttribute("Layer") || "0",
      pointLabelStyle: el.getAttribute("PointLabelStyle") || "",
      /* Anything this build doesn't model is carried through untouched so a
         file written by another version of the software loses nothing. */
      extra: readExtraAttrs(el, CODE_KNOWN_ATTRS),
      /* A feature definition can also carry <Symbols> - how the point is
         drawn - or <Lines>. This build does not edit them, but they are the
         feature's symbology and must survive an export: 45 of the 112
         features in Trimble's GlobalFeatures.fxl have one. */
      foreignChildren: Array.from(el.children)
        .filter((c) => c.tagName !== "Attributes")
        .map((c) => cleanForeignXml(c.outerHTML)),
      attributes: attrsEl
        ? Array.from(attrsEl.children).filter((c) => ATTR_TAGS.includes(c.tagName)).map((a) => this._readAttr(a))
        : [],
      /* An attribute element this build does not model, kept as it arrived
         and anchored to the attribute it followed. Dropping one would both
         delete it from the user's library and shift every later attribute's
         ATTRIBUTE1..N column in a QAQC run. */
      foreignAttrs: attrsEl ? readForeignAttrs(attrsEl) : [],
    };
  }

  _readAttr(el) {
    const a = {
      id: uid("attr"),
      tag: el.tagName,
      name: el.getAttribute("Name") || "",
      description: el.getAttribute("Description") || "",
      /* Optional, Required and OfficeUseOnly are all real - the last one
         means the field is filled in back at the office, not in the field,
         so it is never treated as missing during a QAQC run. Anything else
         a future version introduces is kept as it was found. */
      entryMethod: el.getAttribute("EntryMethod") || "Optional",
      isLabelVisible: el.getAttribute("IsLabelVisible") !== "false",
      /* Trimble's own GlobalFeatures.fxl never writes IsLabelVisible while
         other libraries write it on every attribute. Both are valid, so
         whether it appears is remembered rather than forced either way. */
      hadLabelVisible: el.hasAttribute("IsLabelVisible"),
      extra: readExtraAttrs(el, ATTR_KNOWN_ATTRS),
    };
    /* A text attribute can have a default as well, so this is read for every
       type - DefaultValue is a known attribute and would otherwise be
       dropped rather than falling through to the passthrough list. */
    a.defaultValue = el.getAttribute("DefaultValue") || "";
    if (el.tagName === "DoubleAttribute" || el.tagName === "IntegerAttribute") {
      a.minimumValue = el.getAttribute("MinimumValue") || "";
      a.maximumValue = el.getAttribute("MaximumValue") || "";
      a.numberOfDecimals = el.getAttribute("NumberOfDecimals") || "";
    }
    if (el.tagName === "ListAttribute") {
      const itemsEl = Array.from(el.children).find((c) => c.tagName === "ListItems");
      a.listItems = itemsEl ? Array.from(itemsEl.children).filter((c) => c.tagName === "Item").map((i) => i.textContent) : [];
    }
    return a;
  }

  findByCode(code) {
    if (!code) return undefined;
    const k = code.trim().toUpperCase();
    return this.codes.find((c) => c.code.trim().toUpperCase() === k);
  }

  /* Placeholder file, so serialize() always takes the "no FeatureDefinitions
     to slot into" branch and writes a complete document from these codes. */
  static blank(filename) {
    const doc = Object.create(FxlDocument.prototype);
    doc.filename = filename;
    doc.raw = "";
    doc.parseError = null;
    doc.codes = [];
    doc.layers = blankLayers();
    return doc;
  }

  /* Rebuild the FeatureDefinitions block, and the LayerDefinitions block when
     the layers have been edited; every other section of the original document
     (line styles, symbols, label styles) is kept byte-for-byte. */
  serialize() {
    const body = this._writeDefs();
    const m = FEATUREDEFS_RE.exec(this.raw);
    let out;
    if (m) {
      const openAttrs = (m[1] || "").replace(/\s*\/$/, "");
      const replacement = `<FeatureDefinitions${openAttrs}>\n${body}  </FeatureDefinitions>`;
      out = this.raw.slice(0, m.index) + replacement + this.raw.slice(m.index + m[0].length);
      out = this._writeLayersInto(out);
    } else {
      /* No FeatureDefinitions section to slot into - this is a library built
         from scratch (New library, an XLSX import, or the sample data), so a
         complete minimal document is written, including a Layer "0" - a real
         FXL always declares the layer its codes point to. */
      const now = new Date().toISOString();
      out = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n` +
        `<!--This file represents feature coding definitions-->\n` +
        `<FeatureCodingDefinitions CreationDate="${now}" DateModified="${now}" SchemaVersion="9" xmlns="http://trimble.com/schema/fxl">\n` +
        BLANK_PREAMBLE +
        writeLayers(this.layers && this.layers.length ? this.layers : blankLayers(), "  ") +
        `  <FeatureDefinitions>\n${body}  </FeatureDefinitions>\n</FeatureCodingDefinitions>\n`;
      return applyDescriptionNote(out, this.codes);
    }
    const nowIso = new Date().toISOString();
    if (/DateModified="[^"]*"/.test(out)) out = out.replace(/DateModified="[^"]*"/, `DateModified="${nowIso}"`);
    out = applyDescriptionNote(out, this.codes);
    /* The blocks rebuilt above are written with plain newlines. A file that
       arrived with Windows line endings goes back out with them, so an
       untouched export differs from the original only where it must. */
    if (/\r\n/.test(this.raw)) out = out.replace(/\r?\n/g, "\r\n");
    return out;
  }

  /* Replaces the document's LayerDefinitions with the current layer list.
     A file whose layers were never touched is left exactly as it arrived,
     so an untouched export stays byte-for-byte identical. */
  _writeLayersInto(xml) {
    if (!this.layersEdited) return xml;
    const m = LAYERDEFS_RE.exec(xml);
    /* Keep whatever was on the opening tag - a version, a namespace - rather
       than rewriting it away along with the layers inside. */
    const block = writeLayers(this.layers || [], m ? m[1] : "  ", m ? (m[2] || "").replace(/\s*\/$/, "") : "");
    if (!m) {
      /* No layer block at all: put one in front of the feature definitions,
         which is where a real FXL keeps it. */
      const at = xml.search(/[ \t]*<FeatureDefinitions\b/);
      return at === -1 ? xml : xml.slice(0, at) + block + xml.slice(at);
    }
    return xml.slice(0, m.index) + block.replace(/\n$/, "") + xml.slice(m.index + m[0].length);
  }

  _writeDefs() {
    let out = "";
    const foreign = this.foreignDefs || [];
    const emitForeign = (after) => {
      for (const f of foreign) if (f.after === after) out += `    ${f.xml}\n`;
    };
    emitForeign(-1);
    let i = 0;
    for (const c of this.codes) {
      const tag = c.tag || "PointFeatureDefinition";
      out += `    <${tag} ${writeFeatureAttrs(c, tag)}>\n`;
      /* A code with no attributes is self-closing in a real FXL rather than
         carrying an empty <Attributes> block - 64 of the 112 features in
         Trimble's GlobalFeatures.fxl are written that way. */
      const kids = c.foreignChildren || [];
      const alien = c.foreignAttrs || [];
      if (!c.attributes.length && !kids.length && !alien.length) {
        out = out.replace(/>\n$/, " />\n");
        emitForeign(i++);
        continue;
      }
      /* An FXL omits <Attributes> entirely rather than writing an empty one. */
      if (c.attributes.length || alien.length) {
        out += "      <Attributes>\n";
        const alienAt = (n) => { for (const f of alien) if (f.after === n) out += `        ${f.xml}\n`; };
        alienAt(-1);
        c.attributes.forEach((a, n) => { out += this._writeAttr(a); alienAt(n); });
        for (const f of alien) if (f.after >= c.attributes.length) out += `        ${f.xml}\n`;
        out += "      </Attributes>\n";
      }
      for (const k of kids) out += `      ${k}\n`;
      out += `    </${tag}>\n`;
      emitForeign(i++);
    }
    /* Anything anchored past the last remaining code, because codes were
       deleted since the file was read. */
    for (const f of foreign) if (f.after >= i) out += `    ${f.xml}\n`;
    return out;
  }

  _writeAttr(a) {
    const opt = (n, v) => (v !== undefined && v !== null && v !== "" ? ` ${n}="${escXml(v)}"` : "");
    /* Written only when the file it came from had it, or when it is actually
       false - true is the default and Trimble's own libraries leave it out. */
    const labelVisible = a.isLabelVisible === false ? ' IsLabelVisible="false"'
      : a.hadLabelVisible ? ' IsLabelVisible="true"' : "";
    const head = `Name="${escXml(a.name)}"` + opt("Description", a.description) +
      ` EntryMethod="${escXml(a.entryMethod || "Optional")}"` +
      /* Only a typed-in field has a default. A menu uses DefaultItemIndex
         instead, and a photo has nothing to default to - writing one there
         would be inventing an attribute the schema does not declare, which
         is enough to have the file refused. */
      labelVisible +
      (a.tag === "ListAttribute" || a.tag === "PhotoAttribute" ? "" : opt("DefaultValue", a.defaultValue)) +
      writeExtraAttrs(a.extra);
    if (a.tag === "ListAttribute") {
      let s = `        <ListAttribute ${head}>\n          <ListItems>\n`;
      for (const item of a.listItems || []) s += `            <Item>${escXml(item)}</Item>\n`;
      return s + "          </ListItems>\n        </ListAttribute>\n";
    }
    if (a.tag === "DoubleAttribute" || a.tag === "IntegerAttribute") {
      /* NumberOfDecimals belongs to a Double only - an integer has no
         decimals and Trimble's schema does not declare the attribute
         there, which is enough to have the whole file refused. */
      const decimals = a.tag === "DoubleAttribute" ? opt("NumberOfDecimals", a.numberOfDecimals) : "";
      /* Default (written in the head above), then min, max, decimals - the
         order both reference libraries use, so a re-export reads as the
         same file rather than a reshuffled one. */
      return `        <${a.tag} ${head}` +
        opt("MinimumValue", a.minimumValue) + opt("MaximumValue", a.maximumValue) + decimals + " />\n";
    }
    return `        <${a.tag} ${head} />\n`;
  }
}

/* Build a fully-formed FxlDocument from code objects (not parsed from a
   file) by writing them out with the class's own serializer and reading
   the result back in - the same code path a real load goes through, so a
   library built from scratch, from an XLSX import, or from the sample data
   is proven to round-trip before it ever reaches the screen. */
function fxlFromCodes(codes, filename, layers) {
  const stub = FxlDocument.blank(filename);
  stub.codes = codes;
  /* Every layer the codes name has to be declared, or the file this builds
     will not open. Whatever the caller supplies is kept, and anything the
     codes reference beyond it is added. */
  const declared = new Map((layers || blankLayers()).map((L) => [L.name, L]));
  for (const c of codes) {
    for (const name of [c.layer, c.geometry !== "Point" ? codePointLayer(c) : null]) {
      if (name && !declared.has(name)) declared.set(name, makeLayer(name));
    }
  }
  stub.layers = Array.from(declared.values());
  const xml = stub.serialize();
  return new FxlDocument(xml, filename);
}

/* ============================================================
   CSV (PNEZD) PARSER
   ============================================================ */

const PNEZD_HEADER = ["POINT", "NORTHING", "EASTING", "ELEVATION", "DESCRIPTION"];

function splitCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* Header detection: row 1 is only treated as a header when it actually looks
   like one. Otherwise it is data and nothing is dropped. */
function looksLikeHeader(fields) {
  const up = fields.map((f) => f.trim().toUpperCase());
  let hits = 0;
  for (let i = 0; i < PNEZD_HEADER.length; i++) if (up[i] === PNEZD_HEADER[i]) hits++;
  if (hits >= 3) return true;
  /* Fall back, for a header that uses its own labels (PT,N,E,Z,DESC): the
     point number, northing and easting columns must all be present and
     non-numeric, and something must read like a header word. Requiring the
     coordinates to be filled in matters - a data row such as
     "1,,,,POINT_CONTROL" has blank coordinates and a description that
     contains POINT, and must not be mistaken for a header and dropped. */
  const isNum = (v) => /^-?\d*\.?\d+$/.test(v);
  const filled = (v) => typeof v === "string" && v !== "";
  if (!filled(up[0]) || !filled(up[1]) || !filled(up[2])) return false;
  if (isNum(up[0]) || isNum(up[1]) || isNum(up[2])) return false;
  return up.some((v) => /POINT|NORTH|EAST|ELEV|DESC|CODE|ATTR/.test(v));
}

function parsePnezdCsv(text) {
  // Keep true file line numbers: number first, filter blanks after.
  const all = text.split(/\r\n|\r|\n/).map((content, i) => ({ n: i + 1, content }));
  const used = all.filter((l) => l.content.trim().length > 0);
  if (used.length === 0) {
    return { rows: [], header: [], hasHeader: false, empty: true };
  }
  const firstFields = splitCsvLine(used[0].content);
  const hasHeader = looksLikeHeader(firstFields);
  const header = hasHeader ? firstFields.map((s) => s.trim()) : [];
  const dataLines = hasHeader ? used.slice(1) : used;

  const rows = [];
  for (const line of dataLines) {
    const f = splitCsvLine(line.content);
    const attributes = f.slice(5).map((v) => (v === undefined ? "" : v.trim()));
    rows.push({
      lineNumber: line.n,
      point: (f[0] || "").trim(),
      code: (f[4] || "").trim(),
      attributes,
    });
  }
  return { rows, header, hasHeader, empty: false };
}

/* ============================================================
   QAQC ENGINE
   Scope: attribute conformance against the FXL. Coordinates and elevations
   are intentionally not validated - this is an attribute checker.
   ============================================================ */

function isStrictNumber(s) {
  return /^-?\d+(\.\d+)?$/.test(String(s).trim());
}

function runQaqc(fxl, csv) {
  const findings = [];
  const byPoint = new Map();

  const add = (row, severity, field, message) => {
    findings.push({ line: row.lineNumber, point: row.point || "(blank)", code: row.code || "(blank)", severity, field, message });
  };

  for (const row of csv.rows) {
    if (row.point) {
      let list = byPoint.get(row.point);
      if (!list) byPoint.set(row.point, (list = []));
      list.push(row);
    }

    if (!row.code) {
      add(row, "error", "CODE", "Feature code (DESCRIPTION column) is blank.");
      continue;
    }
    const def = fxl.findByCode(row.code);
    if (!def) {
      add(row, "error", "CODE", `Feature code "${row.code}" is not defined in the loaded FXL.`);
      continue;
    }

    const attrs = def.attributes;
    for (let i = 0; i < attrs.length; i++) {
      const ad = attrs[i];
      /* A photo is taken on the data collector, not typed, so there is
         nothing here to check - not its value, and not whether it is there.
         It still counts as an attribute so everything after it lines up
         against the right column. */
      if (ad.tag === "PhotoAttribute") continue;
      const value = (row.attributes[i] || "").trim();
      const field = `ATTRIBUTE${i + 1} (${ad.name})`;

      if (value === "") {
        if (ad.entryMethod === "Required") add(row, "error", field, `Required attribute "${ad.name}" is missing.`);
        continue;
      }

      if (ad.tag === "ListAttribute") {
        const allowed = (ad.listItems || []).map((x) => x.trim().toUpperCase());
        if (!allowed.includes(value.toUpperCase())) {
          add(row, "warning", field, `"${value}" is not an allowed option for ${ad.name}.`);
        }
      } else if (ad.tag === "DoubleAttribute" || ad.tag === "IntegerAttribute") {
        if (!isStrictNumber(value)) {
          add(row, "warning", field, `"${value}" is not a plain number. ${ad.name} must contain digits only, with no units or symbols.`);
        } else {
          const num = parseFloat(value);
          const min = ad.minimumValue !== "" ? parseFloat(ad.minimumValue) : NaN;
          const max = ad.maximumValue !== "" ? parseFloat(ad.maximumValue) : NaN;
          if (!Number.isNaN(min) && num < min) add(row, "warning", field, `${num} is below the FXL minimum of ${min} for ${ad.name}.`);
          if (!Number.isNaN(max) && num > max) add(row, "warning", field, `${num} is above the FXL maximum of ${max} for ${ad.name}.`);
          if (ad.tag === "IntegerAttribute" && value.includes(".")) {
            add(row, "warning", field, `${ad.name} is an integer field but "${value}" has decimals.`);
          }
        }
      }
    }

    for (let i = attrs.length; i < row.attributes.length; i++) {
      const v = (row.attributes[i] || "").trim();
      if (v !== "") {
        add(row, "warning", `ATTRIBUTE${i + 1}`, `"${v}" has no matching attribute - ${row.code} defines ${attrs.length} attribute${attrs.length === 1 ? "" : "s"} in the FXL.`);
      }
    }
  }

  for (const [pt, rows] of byPoint) {
    if (rows.length > 1) {
      for (const r of rows) add(r, "error", "POINT", `Point number ${pt} is used ${rows.length} times in this file.`);
    }
  }

  findings.sort((a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return findings;
}

/* ============================================================
   FILE DELIVERY
   The viewer sandbox blocks ordinary downloads, so files go out through the
   downloads capability when it is available. Its extension allowlist has no
   .fxl entry, so FXL exports ship inside a .zip.
   ============================================================ */

let downloadsNs = null;
let downloadsResolved = false;
async function getDownloads() {
  if (downloadsResolved) return downloadsNs;
  downloadsResolved = true;
  try {
    if (window.claude && typeof window.claude.use === "function") {
      downloadsNs = await window.claude.use("downloads");
    }
  } catch { downloadsNs = null; }
  return downloadsNs;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/* Minimal store-mode (uncompressed) ZIP writer. */
function makeZip(entries, mime) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : enc.encode(e.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    dv.setUint16(8, 0, true);      // stored
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0x21, true);  // 1980-01-01
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: mime || "application/zip" });
}

/* Read a zip produced by this app (stored) or re-zipped by Windows (deflate).
   Entries come from the central directory, so sizes are always correct. */
async function readZip(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  const floor = Math.max(0, buffer.byteLength - 66000);
  for (let i = buffer.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("This does not look like a readable zip file.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.byteLength || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (localOff + 30 > buffer.byteLength) break;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start + compSize > buffer.byteLength) break;
    entries.push({ name, method, raw: u8.subarray(start, start + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const files = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    let bytes = e.raw;
    if (e.method === 8) {
      if (typeof DecompressionStream === "undefined") continue;
      const stream = new Blob([e.raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (e.method !== 0) continue;
    files.push({ name: e.name, text: new TextDecoder().decode(bytes) });
  }
  return files;
}

const DOWNLOAD_MESSAGES = {
  declined: "Download cancelled.",
  rate_limited: "Another download prompt is open. Try again in a moment.",
  too_large: "That file is too large for this viewer to save.",
  rejected_extension: "This viewer will not save that file type.",
};

/* A plain browser download via a temporary object URL and an <a download>
   click. Used whenever the artifact viewer's downloads capability isn't
   present - which is the normal case once this app is served on its own,
   e.g. from GitHub Pages or any static host. */
function browserDownload(filename, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Returns a short status string for the UI. */
async function offerDownload(filename, data) {
  const dl = await getDownloads();
  if (!dl) {
    try {
      browserDownload(filename, data);
      return { ok: true, status: `Saved ${filename}` };
    } catch {
      return { ok: false, status: "Could not save the file here. Use Copy instead." };
    }
  }
  try {
    const res = await dl.save({ filename, data });
    return { ok: true, status: res.status === "delivered" ? "Sent." : `Saved ${filename}` };
  } catch (err) {
    const code = err && err.code;
    return { ok: false, status: DOWNLOAD_MESSAGES[code] || "Could not save the file here. Use Copy instead." };
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true, status: "Copied to clipboard." };
  } catch {
    return { ok: false, status: "Copy blocked. Select the text and press Ctrl+C." };
  }
}

/* Strip a real file extension from an uploaded file name. */
function baseName(filename, fallback) {
  const n = (filename || fallback || "export").replace(/\.(fxl|xml|csv|txt|xlsx)$/i, "");
  return safeName(n) || safeName(fallback) || "export";
}

/* Sanitize a user-typed name without removing anything that looks like an
   extension - people legitimately use dots in library names. */
function safeName(s) {
  return String(s || "").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, " ").trim();
}

/* ============================================================
   STATE
   ============================================================ */

const state = {
  tab: "library",
  fxl: null,
  fxlName: "",
  fxlStem: "",
  fxlError: "",
  selectedCodeId: null,
  codeSearch: "",
  categories: [],
  csv: null,
  csvName: "",
  findings: [],
  qaqcStale: true,
  filter: "all",
  findingSearch: "",
  modal: null,
};

const FINDING_LIMIT = 500;

/* Any edit to the library or a new CSV invalidates the report. */
function markStale() { state.qaqcStale = true; }

function ensureFindings() {
  if (!state.qaqcStale) return;
  state.findings = state.fxl && state.csv && state.csv.rows.length ? runQaqc(state.fxl, state.csv) : [];
  state.qaqcStale = false;
}

/* ============================================================
   RENDER - shell
   ============================================================ */

const els = {};

function render() {
  const app = document.getElementById("app");
  /* Every cached node belongs to the tree about to be replaced. Drop them all
     so a targeted refresh can never write into a detached pane. */
  for (const k of Object.keys(els)) delete els[k];
  app.replaceChildren(
    renderMasthead(),
    renderTabs(),
    h("div", { class: "page" }, state.tab === "library" ? renderLibrary() : renderQaqc())
  );
  if (state.modal) app.appendChild(renderModal());
}

function renderMasthead() {
  const bits = [];
  if (state.fxl) bits.push(`${state.fxl.codes.length} codes`);
  if (state.csv) bits.push(`${state.csv.rows.length} points`);
  return h("div", { class: "masthead" }, h("div", { class: "masthead-inner" }, [
    h("div", {}, [
      h("div", { class: "wordmark", text: "Survey FXL Toolkit" }),
      h("div", { class: "wordmark-sub", text: "Feature library editor and PNEZD attribute QAQC" }),
    ]),
    h("div", { class: "masthead-status", text: bits.length ? bits.join("  /  ") : "No files loaded" }),
  ]));
}

function renderTabs() {
  const mk = (id, label) => h("button", {
    class: "tab" + (state.tab === id ? " tab-on" : ""),
    onclick: () => { state.tab = id; render(); },
  }, label);
  return h("div", { class: "tabbar" }, h("div", { class: "tabbar-inner" }, [
    mk("library", "Feature Library"),
    mk("qaqc", "QAQC Check"),
  ]));
}

/* ============================================================
   RENDER - Feature Library
   ============================================================ */

function renderLibrary() {
  if (!state.fxl) return renderLibraryEmpty();

  const toolbar = h("div", { class: "row" }, [
    importLibraryButton("Import"),
    h("button", { class: "btn", onclick: confirmNewLibrary }, "New library"),
    h("button", { class: "btn", onclick: addCode }, "New code"),
    h("button", { class: "btn", onclick: openCategoryManager }, "Categories"),
    h("button", { class: "btn", onclick: openLayerManager }, "Layers"),
    h("button", { class: "btn btn-primary", onclick: openFxlExport }, "Export FXL"),
    h("button", { class: "btn", onclick: openFdmCsvExport }, "Export CSV"),
    h("button", { class: "btn", onclick: openXlsxExport }, "Export XLS"),
    h("button", { class: "btn", onclick: openPdfExport }, "Export PDF"),
    h("div", { class: "grow" }),
    buildBulkAssign(),
    h("input", {
      class: "input search", type: "search", placeholder: "Search codes", value: state.codeSearch,
      oninput: (e) => { state.codeSearch = e.target.value; refreshCodeList(); },
    }),
  ]);

  const meta = h("div", { class: "meta" }, [
    h("span", { text: "Library name" }),
    h("span", { class: "name-edit" }, [
      h("input", {
        value: state.fxlStem,
        title: "Used as the file name when you export",
        "aria-label": "Library file name",
        oninput: (e) => { state.fxlStem = e.target.value; },
      }),
      h("span", { class: "name-ext", text: ".fxl" }),
    ]),
    h("span", { class: "dot", text: "/" }),
    h("span", { text: `${state.fxl.codes.length} feature codes` }),
    h("span", { class: "dot", text: "/" }),
    h("span", { text: "loaded from" }),
    h("span", { class: "meta-v", text: state.fxlName }),
  ]);

  els.codeListScroll = h("div", { class: "codelist-scroll" });
  els.detail = h("div", { class: "detail" });
  els.libNotice = h("div", {});
  refreshCodeList();
  refreshDetail();
  refreshLibNotice();

  return h("div", { class: "stack" }, [
    toolbar,
    meta,
    els.libNotice,
    h("div", { class: "lib" }, [h("div", { class: "codelist" }, els.codeListScroll), els.detail]),
  ]);
}

/* A code pointing at a layer the file never declares makes the FXL invalid,
   and the failure shows up as a crash inside Trimble's software rather than
   anything readable - so it is called out here, on the library itself. */
function refreshLibNotice() {
  if (!els.libNotice) return;
  const missing = undeclaredLayers();
  /* replaceChildren turns a null into the text "null", so the empty case
     passes no children at all. */
  els.libNotice.replaceChildren(...(missing.length ? [
    h("div", { class: "notice notice-warn" }, [
      h("span", { class: "notice-t", text: `${missing.length} layer${missing.length === 1 ? "" : "s"} used but not declared: ${missing.join(", ")}` }),
      h("span", {}, "An exported FXL will not open until every layer a code names is declared. "),
      h("button", { class: "btn btn-sm", onclick: openLayerManager }, "Open Layers"),
    ]),
  ] : []));
}

function renderLibraryEmpty() {
  return h("div", { class: "empty" }, [
    h("div", { class: "empty-h", text: "No feature library loaded" }),
    h("div", { class: "empty-p" }, "Load an FXL file to browse its feature codes, edit codes and attributes, and export a new FXL. A zip exported from this app works too. Files are read in your browser and never uploaded anywhere."),
    state.fxlError ? h("div", { class: "notice notice-err" }, [h("span", { class: "notice-t", text: "That file could not be read" }), state.fxlError]) : null,
    h("div", { class: "row" }, [
      importLibraryButton("Import", true),
      h("button", { class: "btn", onclick: newLibrary }, "Start new library"),
      h("button", { class: "btn", onclick: loadSampleData }, "Load sample data"),
    ]),
  ]);
}

/* Installs a loaded/created FxlDocument as the current library. Survey data
   already loaded is left alone - replacing the library is a common way to
   recheck the same CSV against a corrected FXL. */
function installFxl(doc, sourceName) {
  state.fxl = doc;
  state.fxlName = sourceName;
  state.fxlStem = baseName(sourceName, "feature_library");
  state.fxlError = "";
  state.selectedCodeId = doc.codes.length ? doc.codes[0].id : null;
  seedCategories();
  markStale();
}

async function handleFxlFile(file) {
  let xmlText = null;
  let sourceName = file.name;

  const buf = await file.arrayBuffer();
  const isZip = buf.byteLength > 4 && new Uint8Array(buf, 0, 4).every((b, i) => b === [0x50, 0x4b, 0x03, 0x04][i]);

  if (isZip) {
    let files;
    try {
      files = await readZip(buf);
    } catch (err) {
      state.fxlError = err.message || "The zip file could not be read.";
      render();
      return;
    }
    const fxlEntry = files.find((f) => /\.(fxl|xml)$/i.test(f.name));
    if (!fxlEntry) {
      state.fxlError = `${file.name} does not contain an .fxl file.`;
      render();
      return;
    }
    xmlText = fxlEntry.text;
    sourceName = fxlEntry.name;
  } else {
    xmlText = new TextDecoder().decode(buf);
  }

  const doc = new FxlDocument(xmlText, sourceName);
  if (doc.parseError) {
    state.fxlError = doc.parseError;
    render();
    return;
  }
  installFxl(doc, sourceName);
  render();
}

async function handleXlsxFile(file) {
  const buf = await file.arrayBuffer();
  let wb, result;
  try {
    wb = await readXlsxWorkbook(buf);
    result = importXlsxCodes(wb, state.fxl ? state.fxl.codes : null);
  } catch (err) {
    openModal({
      title: "Could not import that file",
      body: h("p", { class: "modal-note" }, (err && err.message) || "That file could not be read as an Excel workbook."),
      actions: [{ label: "Close", primary: true, onclick: closeModal }],
    });
    return;
  }
  const doc = fxlFromCodes(result.codes, file.name);
  installFxl(doc, file.name);
  if (result.warnings.length) {
    openModal({
      title: `Imported ${result.codes.length} feature code${result.codes.length === 1 ? "" : "s"}`,
      body: h("div", {}, [
        h("p", { class: "modal-note" }, `${result.warnings.length} row${result.warnings.length === 1 ? "" : "s"} could not be matched and ${result.warnings.length === 1 ? "was" : "were"} skipped:`),
        h("ul", { class: "modal-note" }, result.warnings.slice(0, 20).map((w) => h("li", {}, w))),
        result.warnings.length > 20 ? h("p", { class: "modal-note" }, `...and ${result.warnings.length - 20} more.`) : null,
      ]),
      actions: [{ label: "OK", primary: true, onclick: closeModal }],
    });
  } else {
    render();
  }
}

async function handleFdmCsvFile(file) {
  const text = await file.text();
  let result;
  try {
    result = importCsvCodes(text, state.fxl ? state.fxl.codes : null);
  } catch (err) {
    openModal({
      title: "Could not import that file",
      body: h("p", { class: "modal-note" }, (err && err.message) || "That file could not be read as a Feature Definition Manager CSV."),
      actions: [{ label: "Close", primary: true, onclick: closeModal }],
    });
    return;
  }
  installFxl(fxlFromCodes(result.codes, file.name), file.name);

  /* The CSV carries an attribute's name and type and nothing else, so the
     user is told plainly what came back from the previous library and what
     they will have to fill in again. */
  const notes = [];
  if (result.restored) {
    notes.push(`${result.restored} attribute${result.restored === 1 ? "" : "s"} kept their menu options, entry method and number ranges from the library just replaced.`);
  }
  notes.push("A Feature Definition Manager CSV records only each attribute's name and type. Menu options, Required entry, minimum, maximum and decimals are not in the file - any attribute that was not already in the library comes in as Optional with no options or limits.");

  openModal({
    title: `Imported ${result.codes.length} feature code${result.codes.length === 1 ? "" : "s"}`,
    body: h("div", {}, [
      ...notes.map((t) => h("p", { class: "modal-note" }, t)),
      result.warnings.length
        ? h("div", {}, [
            h("p", { class: "modal-note" }, `${result.warnings.length} row${result.warnings.length === 1 ? "" : "s"} were skipped:`),
            h("ul", { class: "modal-note" }, result.warnings.slice(0, 20).map((w) => h("li", {}, w))),
          ])
        : null,
    ]),
    actions: [{ label: "OK", primary: true, onclick: closeModal }],
  });
}

/* A single entry point for bringing a library in, with a choice of format -
   an FXL/XML/zip file, a Feature Definition Manager CSV, or an Excel
   workbook exported from this app. Any of them replaces the library
   currently loaded. */
function importLibraryButton(label, primary) {
  return h("button", { class: "btn" + (primary ? " btn-primary" : ""), onclick: openImportChooser }, label);
}

function openImportChooser() {
  const fxlPicker = fileButton("Choose file", ".fxl,.xml,.zip", false, (file) => {
    closeModal();
    handleFxlFile(file);
  });
  const xlsxPicker = fileButton("Choose file", ".xlsx", false, (file) => {
    closeModal();
    handleXlsxFile(file);
  });
  const csvPicker = fileButton("Choose file", ".csv", false, (file) => {
    closeModal();
    handleFdmCsvFile(file);
  });
  openModal({
    title: "Import feature library",
    body: h("div", { class: "stack" }, [
      h("div", { class: "import-opt" }, [
        h("div", {}, [
          h("div", { class: "import-opt-t", text: "FXL file" }),
          h("div", { class: "import-opt-s", text: ".fxl, .xml, or a .zip containing one" }),
        ]),
        fxlPicker,
      ]),
      h("div", { class: "import-opt" }, [
        h("div", {}, [
          h("div", { class: "import-opt-t", text: "Feature Definition Manager CSV" }),
          h("div", { class: "import-opt-s", text: "A .csv exported from Trimble’s Feature Definition Manager. Carries attribute names and types only - options and limits are kept from the current library where the code still matches." }),
        ]),
        csvPicker,
      ]),
      h("div", { class: "import-opt" }, [
        h("div", {}, [
          h("div", { class: "import-opt-t", text: "Excel workbook" }),
          h("div", { class: "import-opt-s", text: "A .xlsx with Codes / Attributes / Options sheets, as exported by “Export XLS”. The only format that carries everything." }),
        ]),
        xlsxPicker,
      ]),
      h("p", { class: "modal-note" }, "Any of these replaces the feature library currently loaded. Survey data already loaded is kept."),
    ]),
    actions: [{ label: "Cancel", onclick: closeModal }],
  });
}

/* ---------- new library / sample data ---------- */

function newLibrary() {
  const doc = fxlFromCodes([], "untitled.fxl");
  installFxl(doc, "untitled.fxl");
  state.tab = "library";
  render();
}

function confirmNewLibrary() {
  if (state.fxl && state.fxl.codes.length) {
    openModal({
      title: "Start a new library",
      body: h("p", { class: "modal-note" }, `This clears the ${state.fxl.codes.length} feature code${state.fxl.codes.length === 1 ? "" : "s"} currently loaded and starts a blank library. This cannot be undone.`),
      actions: [
        { label: "Cancel", onclick: closeModal },
        { label: "Start new library", primary: true, onclick: () => { closeModal(); newLibrary(); } },
      ],
    });
  } else {
    newLibrary();
  }
}

function sampleAttr(tag, name, opts) {
  const o = opts || {};
  const a = { id: uid("attr"), tag, name, description: o.description || "", entryMethod: o.required ? "Required" : "Optional", isLabelVisible: true, extra: [] };
  if (tag === "DoubleAttribute" || tag === "IntegerAttribute") {
    a.minimumValue = o.min ?? "";
    a.maximumValue = o.max ?? "";
    a.numberOfDecimals = o.decimals ?? "";
    a.defaultValue = "";
  }
  if (tag === "ListAttribute") a.listItems = o.options || [];
  return a;
}
function sampleCode(code, geometry, opts, attributes) {
  const o = opts || {};
  return {
    id: uid("code"), geometry, tag: GEOMETRY_TAG[geometry],
    code, name: o.name || code, description: o.description || "", category: o.category || "",
    includeInSurface: true, color: "FE000000", layer: "0", pointLabelStyle: "", extra: [],
    attributes,
  };
}

/* Five everyday survey codes - nothing tied to one industry - spanning
   point and line geometry, every attribute type, Required and Optional
   entry, and all three categories. Codes are the usual three-letter
   shorthand, with the full word in Name. The matching CSV below
   deliberately carries a few problems so the QAQC tab shows both
   severities immediately, not just a clean report. */
function buildSampleCodes() {
  const NATURAL = "NATURAL FEATURE";
  const MANMADE = "MAN-MADE FEATURE";
  return [
    sampleCode("TRE", "Point", { name: "TREE", category: NATURAL, description: "A significant tree, shot for clearing, vegetation or canopy records." }, [
      sampleAttr("ListAttribute", "SPECIES", { options: ["OAK", "PINE", "CEDAR", "ELM", "OTHER"] }),
      sampleAttr("DoubleAttribute", "TRUNK_DIAMETER_INCHES", { min: "0", max: "60", decimals: "1" }),
      sampleAttr("StringAttribute", "NOTES"),
    ]),
    sampleCode("FNC", "Line", { name: "FENCE", category: MANMADE, description: "Property or right-of-way fencing. Shot as a line, corner to corner." }, [
      sampleAttr("ListAttribute", "TYPE", { options: ["BARB WIRE", "CHAINLINK", "WOOD", "VINYL"] }),
      sampleAttr("DoubleAttribute", "HEIGHT_FEET", { min: "0", max: "10", decimals: "1" }),
      sampleAttr("StringAttribute", "NOTES"),
    ]),
    sampleCode("UPL", "Point", { name: "UTILITY POLE", category: MANMADE, description: "An above-ground utility pole. Record what it carries and what it is made of." }, [
      sampleAttr("ListAttribute", "TYPE", { options: ["POWER", "TELEPHONE", "LIGHT"] }),
      sampleAttr("ListAttribute", "MATERIAL", { options: ["WOOD", "METAL", "CONCRETE"] }),
      sampleAttr("StringAttribute", "NOTES"),
    ]),
    sampleCode("FHY", "Point", { name: "FIRE HYDRANT", category: MANMADE, description: "A fire hydrant. CONDITION is required - it is the field the fire marshal asks for." }, [
      sampleAttr("ListAttribute", "CONDITION", { required: true, options: ["IN SERVICE", "OUT OF SERVICE", "DAMAGED"] }),
      sampleAttr("IntegerAttribute", "OUTLET_COUNT", { min: "1", max: "4" }),
      sampleAttr("StringAttribute", "NOTES"),
    ]),
    sampleCode("CTL", "Point", { name: "CONTROL POINT", category: "OTHER", description: "A survey control point. MONUMENT is required so the point can be recovered later." }, [
      sampleAttr("ListAttribute", "MONUMENT", { required: true, options: ["REBAR", "IRON PIPE", "DISK", "NAIL"] }),
      sampleAttr("StringAttribute", "NOTES"),
    ]),
  ];
}

/* Ten shots against the codes above. Rows 2, 3, 7, 8, 9 and 10 each carry a
   different kind of problem, so every check the QAQC tab makes shows up in
   the sample report. */
const SAMPLE_CSV_TEXT = [
  "POINT,NORTHING,EASTING,ELEVATION,DESCRIPTION,ATTRIBUTE1,ATTRIBUTE2,ATTRIBUTE3,ATTRIBUTE4",
  "1,10000.00,5000.00,1200.00,TRE,OAK,18.5,Near the property corner,",
  "2,10010.25,5005.10,1201.20,TRE,PINE,24 IN,,",
  "3,10020.00,5010.00,1199.80,FNC,CHAINLINK,6.0,,Replaced 2021",
  "4,10030.00,5015.00,1198.50,UPL,POWER,WOOD,,",
  "5,10040.00,5020.00,1197.00,FHY,IN SERVICE,2,,",
  "6,10050.00,5025.00,1196.40,CTL,REBAR,Set on the north line,,",
  "7,10060.00,5030.00,1195.10,FHY,,3,,",
  "8,10070.00,5035.00,1194.00,TRE,MAPLE,12.0,,",
  "8,10075.00,5036.00,1194.10,FNC,WOOD,5.0,,",
  "10,10090.00,5045.00,1192.00,XYZ,,,,",
].join("\r\n") + "\r\n";

function loadSampleData() {
  const doc = fxlFromCodes(buildSampleCodes(), "sample_library.fxl");
  installFxl(doc, "sample_library.fxl");
  const csv = parsePnezdCsv(SAMPLE_CSV_TEXT);
  state.csv = csv;
  state.csvName = "sample_survey.csv";
  state.filter = "all";
  state.findingSearch = "";
  markStale();
  render();
}

/* One definition of what the code search matches, used by the list, the bulk
   assign control and the PDF export so the three can never disagree. */
function filterCodes(query) {
  if (!state.fxl) return [];
  const q = String(query || "").trim().toUpperCase();
  if (!q) return state.fxl.codes;
  return state.fxl.codes.filter((c) =>
    c.code.toUpperCase().includes(q) ||
    (c.name || "").toUpperCase().includes(q) ||
    (c.category || "").toUpperCase().includes(q));
}

/* Assigning a category to everything currently matching the search. The
   library's prefixes (CP_, UTILITY_, EDGE_, FUTURE_, PROPOSED_, CL_) make this
   the quick way to sort a hundred codes. Only shown while a search is active. */
function matchingCodes() {
  return state.codeSearch.trim() ? filterCodes(state.codeSearch) : [];
}

function buildBulkAssign() {
  const label = h("span", { class: "bulk-label" });
  const sel = h("select", { class: "input input-sm" });
  const btn = h("button", { class: "btn btn-sm" }, "Assign");
  const wrap = h("div", { class: "bulk-assign" }, [label, sel, btn]);

  btn.addEventListener("click", () => {
    const target = sel.value;
    for (const c of matchingCodes()) c.category = target;
    markStale();
    refreshCodeList();
    refreshDetail();
  });

  els.bulkAssign = { wrap, label, sel };
  paintBulkAssign();
  return wrap;
}

function paintBulkAssign() {
  const b = els.bulkAssign;
  if (!b) return;
  const n = matchingCodes().length;
  b.wrap.hidden = n === 0;
  if (!n) return;
  b.label.textContent = `Put ${n} matching code${n === 1 ? "" : "s"} in`;
  const current = b.sel.value;
  b.sel.replaceChildren(
    h("option", { value: "" }, "no category"),
    ...categoryOptions().map((c) => h("option", { value: c, selected: c === current }, c))
  );
}

function refreshCodeList() {
  if (!els.codeListScroll || !state.fxl) return;
  paintBulkAssign();
  const q = state.codeSearch.trim();
  const codes = filterCodes(q);
  if (!codes.length) {
    els.codeListScroll.replaceChildren(h("div", { class: "list-empty", text: q ? "No codes match that search." : "This library has no feature codes." }));
    return;
  }
  els.codeListScroll.replaceChildren(...codes.map((c) => h("button", {
    class: "coderow" + (c.id === state.selectedCodeId ? " coderow-on" : ""),
    onclick: () => { state.selectedCodeId = c.id; refreshCodeList(); refreshDetail(); },
  }, [
    h("span", { class: "coderow-geo", text: GEO_ABBR[c.geometry] || "PT" }),
    h("span", { class: "coderow-name", text: c.code || "(unnamed)" }),
    codeHasPhoto(c) ? cameraIcon("Asks the crew for a photo") : null,
    h("span", { class: "coderow-n", text: String(c.attributes.length) }),
  ])));
}

function refreshDetail() {
  if (!els.detail) return;
  /* Layer changes are made here, so the undeclared-layer notice is kept in
     step from the same place. */
  refreshLibNotice();
  const code = state.fxl ? state.fxl.codes.find((c) => c.id === state.selectedCodeId) : null;
  if (!code) {
    els.detail.replaceChildren(h("div", { class: "list-empty", text: state.fxl && state.fxl.codes.length ? "Select a feature code." : "This library has no feature codes yet." }));
    return;
  }

  const nameInput = h("input", {
    class: "input mono", value: code.name,
    title: "The full name stored in the FXL. Useful when the code itself is shorthand.",
    oninput: (e) => { code.name = e.target.value; markStale(); },
  });

  const top = h("div", { class: "detail-top" }, [
    h("label", { class: "field grow" }, [
      h("span", { class: "label", text: "Code" }),
      h("input", {
        class: "input mono", value: code.code,
        oninput: (e) => {
          /* Name follows Code only while the two already match, so a library
             that deliberately sets them differently keeps its Name. */
          const mirrored = code.name === code.code;
          code.code = normalizeInto(e.target, e.target.value);
          if (mirrored) {
            code.name = code.code;
            nameInput.value = code.name;
          }
          markStale();
          refreshCodeList();
        },
      }),
    ]),
    h("label", { class: "field grow" }, [
      h("span", { class: "label", text: "Name" }),
      nameInput,
    ]),
    h("label", { class: "field grow" }, [
      h("span", { class: "label", text: "Category" }),
      categorySelect(code),
    ]),
    h("label", { class: "field" }, [
      h("span", { class: "label", text: "Geometry" }),
      h("select", {
        class: "input",
        /* Changing geometry changes which layer fields apply, so the whole
           detail pane is rebuilt rather than just the list. */
        onchange: (e) => {
          code.geometry = e.target.value;
          code.tag = GEOMETRY_TAG[e.target.value];
          markStale();
          refreshCodeList();
          refreshDetail();
        },
      }, ["Point", "Line", "Polygon"].map((g) => h("option", { value: g, selected: g === code.geometry }, g))),
    ]),
    h("label", { class: "field" }, [
      h("span", { class: "label", text: "Layer" }),
      layerSelect(code.layer, (v) => { code.layer = v; markStale(); refreshDetail(); }),
    ]),
    /* A line or polygon also says which layer its vertex points land on. */
    code.geometry !== "Point"
      ? h("label", { class: "field" }, [
          h("span", { class: "label", text: "Point layer" }),
          layerSelect(codePointLayer(code), (v) => { setCodePointLayer(code, v); markStale(); refreshDetail(); }),
        ])
      : null,
    h("label", { class: "check" }, [
      h("input", { type: "checkbox", checked: code.includeInSurface, onchange: (e) => { code.includeInSurface = e.target.checked; } }),
      "In surface",
    ]),
    h("button", { class: "btn btn-danger", onclick: () => confirmDeleteCode(code) }, "Delete code"),
  ]);

  const descRow = h("label", { class: "field descbox" }, [
    h("span", { class: "label", text: "Description" }),
    h("input", {
      class: "input",
      value: code.description || "",
      placeholder: "Explanation of feature code and its uses",
      title: "Written into the FXL and used in the printed code report",
      oninput: (e) => { code.description = e.target.value; },
    }),
  ]);

  const attrHead = h("div", { class: "attrhead" }, [
    h("h2", { class: "attrhead-t", text: `Attributes (${code.attributes.length})` }),
    h("span", { class: "attrhead-s", text: "Order sets ATTRIBUTE1..N in the CSV" }),
    h("div", { class: "grow" }),
    h("button", { class: "btn btn-sm", onclick: () => { code.attributes.push(newAttr()); markStale(); refreshDetail(); refreshCodeList(); } }, "Add attribute"),
    /* A photo is a type of attribute, but nobody goes looking for it inside a
       type dropdown, so it gets its own button and arrives ready to use. */
    h("button", {
      class: "btn btn-sm",
      title: "Ask the crew for a photo when they store this feature",
      onclick: () => { code.attributes.push(newPhotoAttr(code)); markStale(); refreshDetail(); refreshCodeList(); },
    }, "Add photo"),
  ]);

  const rows = code.attributes.length
    ? code.attributes.map((a, i) => attrRow(code, a, i))
    : [h("div", { class: "aempty", text: "This code has no attributes. CSV rows using it should carry no attribute values." })];

  els.detail.replaceChildren(top, descRow, attrHead, h("div", { class: "ahead" }, [
    h("div", { text: "#" }), h("div", { text: "Name / prompt" }), h("div", { text: "Type" }),
    h("div", { text: "Entry" }), h("div", { text: "Values" }), h("div", {}),
  ]), ...rows);
}

/* ---------- categories ----------
   Category groups codes in the feature library. A code with no category shows
   as an empty selection - there is no "Undefined" value anywhere, in the UI or
   in the file. */

/* Categories the picker offers even before any code uses them, so a library
   that arrives uncategorized still starts with something to choose. */
/* Offered on every library so a blank one has somewhere to start, and so the
   dropdown is never empty. A generic split that suits any discipline - a
   loaded library's own categories are added to these. */
const SUGGESTED_CATEGORIES = ["NATURAL FEATURE", "MAN-MADE FEATURE", "OTHER"];

/* The list of available categories. Seeded from whatever the loaded library
   already uses, plus the suggestions. The FXL can only record a category on a
   code, so a category with no codes lives for this session only. */
function seedCategories() {
  const set = new Set(SUGGESTED_CATEGORIES);
  if (state.fxl) for (const c of state.fxl.codes) if (c.category) set.add(c.category);
  state.categories = Array.from(set).sort((a, b) => a.localeCompare(b));
}

function categoryOptions() {
  return state.categories;
}

function categoryCount(name) {
  if (!state.fxl) return 0;
  return state.fxl.codes.filter((c) => (name === "" ? !c.category : c.category === name)).length;
}

function categorySelect(code) {
  const sel = h("select", {
    class: "input",
    title: "Groups this code in the feature library",
    /* The list and the bulk-assign control both filter on category, so they
       have to be rebuilt or they keep showing a set this code is no longer
       part of. */
    onchange: (e) => { code.category = e.target.value; markStale(); refreshCodeList(); },
  }, [
    h("option", { value: "", selected: !code.category }, ""),
    ...categoryOptions().map((c) => h("option", { value: c, selected: c === code.category }, c)),
  ]);
  return sel;
}

/* A layer picker. A layer the file never declares still has to be selectable,
   or opening a code would silently move it somewhere else - so it is listed,
   marked, and reported by the notice above the code list. */
function layerSelect(value, onPick) {
  const names = (state.fxl && state.fxl.layers ? state.fxl.layers : []).map((L) => L.name);
  const missing = value && !names.includes(value);
  const sel = h("select", {
    class: "input" + (missing ? " input-warn" : ""),
    title: missing ? `Layer "${value}" is not declared in this library` : "The layer this code draws on",
    onchange: (e) => onPick(e.target.value),
  }, [
    ...names.map((n) => h("option", { value: n, selected: n === value }, n)),
    missing ? h("option", { value, selected: true }, `${value} (not declared)`) : null,
  ]);
  return sel;
}

function openLayerManager() {
  if (!state.fxl) return;
  const list = h("div", { class: "cat-list" });
  const note = h("div", {});
  const layers = () => state.fxl.layers;

  const paint = () => {
    const missing = undeclaredLayers();
    note.replaceChildren(...[
      missing.length
        ? h("div", { class: "notice notice-warn" }, [
            h("span", { class: "notice-t", text: `${missing.length} layer${missing.length === 1 ? " is" : "s are"} used but not declared` }),
            `${missing.join(", ")}. Trimble's Feature Definition Manager will not open a file whose codes point at a layer it cannot find. Add ${missing.length === 1 ? "it" : "them"} below, or move those codes onto a declared layer.`,
          ])
        : null,
      h("p", { class: "modal-note" }, "Every code names the layer it draws on, and a line or polygon also names the layer for its vertex points. Layer 0 is the fallback and cannot be removed."),
    ].filter(Boolean));

    const rows = layers().map((L, idx) => {
      const used = layerCount(L.name);
      const isZero = L.name === "0";
      /* Renaming moves every code that referenced the old name, so it commits
         on leaving the field rather than per keystroke - the same reasoning as
         the category manager. */
      const commit = (e) => {
        const next = e.target.value.trim();
        const current = layers()[idx].name;
        if (next === current) { e.target.value = current; return; }
        const clash = !next || layers().some((x, i) => i !== idx && x.name.toLowerCase() === next.toLowerCase());
        if (clash) { e.target.value = current; return; }
        for (const c of state.fxl.codes) {
          if (c.layer === current) c.layer = next;
          if (c.geometry !== "Point" && codePointLayer(c) === current) setCodePointLayer(c, next);
        }
        layers()[idx].name = next;
        layers()[idx].fields.Name = next;
        state.fxl.layersEdited = true;
        markStale();
        paint();
        refreshDetail();
      };
      return h("div", { class: "cat-row" }, [
        h("input", {
          class: "input input-sm", value: L.name, disabled: isZero,
          title: isZero ? "Layer 0 is the fallback layer and keeps its name" : "Renaming moves any codes already on this layer. Takes effect when you leave the box.",
          onblur: commit,
          onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
        }),
        h("div", { class: "cat-count mono", text: used ? `${used} code${used === 1 ? "" : "s"}` : "unused" }),
        h("button", {
          class: "btn btn-sm btn-danger", disabled: isZero || used > 0,
          title: isZero ? "Layer 0 cannot be removed"
            : used ? `In use by ${used} code${used === 1 ? "" : "s"} - move them to another layer first`
            : "Remove this layer",
          onmousedown: (e) => e.preventDefault(),
          onclick: () => {
            if (isZero || layerCount(layers()[idx].name)) return;
            layers().splice(idx, 1);
            state.fxl.layersEdited = true;
            markStale();
            paint();
            refreshDetail();
          },
        }, "Remove"),
      ]);
    });
    list.replaceChildren(...rows);
  };

  const addInput = h("input", {
    class: "input input-sm", placeholder: "e.g. UtilityWater",
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } },
  });
  const add = () => {
    const name = addInput.value.trim();
    if (!name) return;
    if (!layers().some((L) => L.name.toLowerCase() === name.toLowerCase())) {
      layers().push(makeLayer(name));
      state.fxl.layersEdited = true;
      markStale();
    }
    addInput.value = "";
    paint();
    refreshDetail();
    addInput.focus();
  };

  paint();
  openModal({
    title: "Layers",
    body: h("div", { class: "stack" }, [
      note, list,
      h("div", { class: "row" }, [addInput, h("button", { class: "btn btn-sm", onclick: add }, "Add layer")]),
    ]),
    actions: [{ label: "Done", primary: true, onclick: closeModal }],
  });
}

function openCategoryManager() {
  if (!state.fxl) return;
  const list = h("div", { class: "cat-list" });
  const blankLine = h("p", { class: "modal-note" });

  const paint = () => {
    const n = categoryCount("");
    blankLine.textContent = n ? `${n} code${n === 1 ? " has" : "s have"} no category set.` : "";

    const rows = state.categories.map((name, idx) => {
      const used = categoryCount(name);
      /* A rename commits when the field is left, not on every keystroke.
         Renaming live would drag every code onto each half-typed name, so
         passing through a name another category already holds would merge the
         two sets with no way to tell them apart again. */
      const commit = (e) => {
        const next = e.target.value.trim();
        const current = state.categories[idx];
        if (next === current) { e.target.value = current; return; }
        const clash = !next || state.categories.some((c, i) => i !== idx && c.toLowerCase() === next.toLowerCase());
        if (clash) { e.target.value = current; return; }
        for (const c of state.fxl.codes) if (c.category === current) c.category = next;
        state.categories[idx] = next;
        state.categories.sort((a, b) => a.localeCompare(b));
        markStale();
        paint();
        refreshDetail();
        refreshCodeList();
      };
      return h("div", { class: "cat-row" }, [
        h("input", {
          class: "input input-sm", value: name,
          title: "Renaming moves any codes already using this category. Takes effect when you leave the box.",
          onblur: commit,
          onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
        }),
        h("div", { class: "cat-count mono", text: used ? `${used} code${used === 1 ? "" : "s"}` : "unused" }),
        h("button", {
          class: "btn btn-sm btn-danger",
          title: used ? `Removes the category and clears it from ${used} code${used === 1 ? "" : "s"}` : "Remove this category",
          onmousedown: (e) => e.preventDefault(), // keep a pending rename from committing under the click
          onclick: () => {
            const current = state.categories[idx];
            for (const c of state.fxl.codes) if (c.category === current) c.category = "";
            state.categories.splice(idx, 1);
            markStale();
            paint();
            refreshDetail();
            refreshCodeList();
          },
        }, "Remove"),
      ]);
    });
    if (!rows.length) rows.push(h("div", { class: "cat-empty", text: "No categories yet. Add one below." }));
    list.replaceChildren(...rows);
  };

  const addInput = h("input", {
    class: "input input-sm", placeholder: "e.g. Cathodic Protection",
    onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } },
  });
  const add = () => {
    const name = addInput.value.trim();
    if (!name) return;
    if (!state.categories.some((c) => c.toLowerCase() === name.toLowerCase())) {
      state.categories.push(name);
      state.categories.sort((a, b) => a.localeCompare(b));
    }
    addInput.value = "";
    paint();
    refreshDetail();
    refreshCodeList();
    addInput.focus();
  };

  paint();

  openModal({
    title: "Categories",
    body: h("div", {}, [
      h("p", { class: "modal-note" }, "The categories available to assign codes to. Assign them from the Category box on any code, or several at once from the library toolbar."),
      list,
      blankLine,
      h("div", { class: "cat-add" }, [
        addInput,
        h("button", { class: "btn btn-sm", onclick: add }, "Add"),
      ]),
    ]),
    actions: [{ label: "Done", primary: true, onclick: closeModal }],
  });
  setTimeout(() => addInput.focus(), 0);
}


function newAttr(name) {
  return { id: uid("attr"), tag: "StringAttribute", name: name || "NEW_ATTRIBUTE", description: "", entryMethod: "Optional", isLabelVisible: true, extra: [] };
}

/* Named PHOTO because that is the word the crew sees on the data collector,
   and what Trimble's own libraries call it. A code that already has one gets
   PHOTO_2, PHOTO_3 and so on rather than a duplicate name. */
function newPhotoAttr(code) {
  const taken = new Set((code.attributes || []).map((a) => (a.name || "").toUpperCase()));
  let name = "PHOTO";
  for (let n = 2; taken.has(name); n++) name = `PHOTO_${n}`;
  return { id: uid("attr"), tag: "PhotoAttribute", name, description: "", entryMethod: "Optional", isLabelVisible: true, extra: [] };
}

function codeHasPhoto(c) {
  return (c.attributes || []).some((a) => a.tag === "PhotoAttribute");
}

/* Drawn rather than typed: a camera reads the same in any language, and the
   code list is already crowded with mono text. */
function cameraIcon(title) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "coderow-cam");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const body = document.createElementNS(ns, "path");
  body.setAttribute("d", "M3 8h4l1.5-2h7L17 8h4v11H3z");
  body.setAttribute("fill", "none");
  body.setAttribute("stroke", "currentColor");
  body.setAttribute("stroke-width", "2");
  body.setAttribute("stroke-linejoin", "round");
  const lens = document.createElementNS(ns, "circle");
  lens.setAttribute("cx", "12"); lens.setAttribute("cy", "13"); lens.setAttribute("r", "3.2");
  lens.setAttribute("fill", "none");
  lens.setAttribute("stroke", "currentColor");
  lens.setAttribute("stroke-width", "2");
  const t = document.createElementNS(ns, "title");
  t.textContent = title || "Photo";
  svg.appendChild(t); svg.appendChild(body); svg.appendChild(lens);
  return svg;
}

function attrRow(code, a, idx) {
  const values = h("div", {});
  if (a.tag === "ListAttribute") values.appendChild(listEditor(a));
  else if (a.tag === "DoubleAttribute" || a.tag === "IntegerAttribute") {
    values.appendChild(h("div", { class: "anum" }, [
      numInput(a, "minimumValue", "min"), numInput(a, "maximumValue", "max"), numInput(a, "numberOfDecimals", "dec"),
    ]));
  } else if (a.tag === "PhotoAttribute") {
    values.appendChild(h("span", { class: "amuted", text: "photo taken on the data collector" }));
  } else values.appendChild(h("span", { class: "amuted", text: "free text" }));

  return h("div", { class: "arow" }, [
    h("div", { class: "aidx", text: String(idx + 1) }),
    h("div", { class: "anamecell" }, [
      h("input", {
        class: "input input-sm mono", value: a.name,
        oninput: (e) => { a.name = normalizeInto(e.target, e.target.value); markStale(); },
      }),
      h("input", {
        class: "input input-sm aprompt", value: a.description || "",
        placeholder: "prompt on the data collector",
        title: "Stored in the FXL as this attribute's Description, and used as the DESCRIPTION column in the PDF",
        oninput: (e) => { a.description = e.target.value; },
      }),
    ]),
    h("select", {
      class: "input input-sm",
      onchange: (e) => {
        a.tag = e.target.value;
        if (a.tag === "ListAttribute" && !a.listItems) a.listItems = [];
        if ((a.tag === "DoubleAttribute" || a.tag === "IntegerAttribute") && a.minimumValue === undefined) {
          a.minimumValue = ""; a.maximumValue = ""; a.numberOfDecimals = ""; a.defaultValue = "";
        }
        /* The code list carries a camera for any code that asks for a
           photo, so changing a type to or from Photo has to repaint it. */
        markStale(); refreshDetail(); refreshCodeList();
      },
    }, ATTR_TAGS.map((t) => h("option", { value: t, selected: t === a.tag }, TYPE_LABEL[t]))),
    h("select", {
      class: "input input-sm",
      onchange: (e) => { a.entryMethod = e.target.value; markStale(); },
    }, (() => {
      const known = ["Optional", "Required", "OfficeUseOnly"];
      /* A value from a future version of the software still has to be
         selectable, or opening the code would quietly change it. */
      const all = known.includes(a.entryMethod) ? known : known.concat(a.entryMethod);
      return all.map((r) => h("option", { value: r, selected: r === a.entryMethod }, ENTRY_LABEL[r] || r));
    })()),
    values,
    h("div", { class: "aacts" }, [
      h("button", { class: "btn btn-icon", title: "Move earlier in the attribute order", "aria-label": "Move earlier", disabled: idx === 0, onclick: () => moveAttr(code, idx, -1) }, "<"),
      h("button", { class: "btn btn-icon", title: "Move later in the attribute order", "aria-label": "Move later", disabled: idx === code.attributes.length - 1, onclick: () => moveAttr(code, idx, 1) }, ">"),
      h("button", { class: "btn btn-icon btn-danger", title: "Remove attribute", "aria-label": "Remove attribute", onclick: () => { code.attributes.splice(idx, 1); markStale(); refreshDetail(); refreshCodeList(); } }, "X"),
    ]),
  ]);
}

function numInput(a, key, ph) {
  return h("input", {
    class: "input input-sm input-num mono", placeholder: ph, value: a[key] ?? "",
    oninput: (e) => { a[key] = e.target.value; markStale(); },
  });
}

function listEditor(a) {
  const items = a.listItems || (a.listItems = []);
  const wrap = h("div", { class: "opts" });
  const list = h("div", { class: "opt-list" }, items.map((item, i) => h("span", { class: "opt" }, [
    h("span", { text: item }),
    h("button", { class: "opt-x", title: "Remove option", onclick: () => { items.splice(i, 1); markStale(); refreshDetail(); } }, "x"),
  ])));
  const input = h("input", {
    class: "input input-sm", placeholder: "Add option, then Enter",
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = e.target.value.trim().toUpperCase();
      if (!v) return;
      items.push(v);
      markStale();
      e.target.value = "";
      list.appendChild(h("span", { class: "opt" }, [
        h("span", { text: v }),
        h("button", { class: "opt-x", title: "Remove option", onclick: () => { const j = items.indexOf(v); if (j > -1) items.splice(j, 1); markStale(); refreshDetail(); } }, "x"),
      ]));
    },
  });
  wrap.appendChild(list);
  wrap.appendChild(input);
  return wrap;
}

function moveAttr(code, idx, dir) {
  const t = idx + dir;
  if (t < 0 || t >= code.attributes.length) return;
  const [item] = code.attributes.splice(idx, 1);
  code.attributes.splice(t, 0, item);
  markStale();
  refreshDetail();
}

function addCode() {
  if (!state.fxl) return;
  const code = {
    id: uid("code"), geometry: "Point", tag: "PointFeatureDefinition",
    code: "NEW_CODE", name: "NEW_CODE", description: "", category: "",
    includeInSurface: true, color: "FE000000", layer: "0", pointLabelStyle: "", extra: [],
    attributes: [newAttr("NOTES")],
  };
  state.fxl.codes.unshift(code);
  state.selectedCodeId = code.id;
  state.codeSearch = "";
  markStale();
  render();
}

function confirmDeleteCode(code) {
  openModal({
    title: "Delete feature code",
    body: h("p", { class: "modal-note" }, `Delete ${code.code} and its ${code.attributes.length} attribute${code.attributes.length === 1 ? "" : "s"} from the library? Survey points already using this code will then be reported as undefined.`),
    actions: [
      { label: "Cancel", onclick: closeModal },
      {
        label: "Delete code", primary: true, onclick: () => {
          state.fxl.codes = state.fxl.codes.filter((c) => c.id !== code.id);
          state.selectedCodeId = state.fxl.codes.length ? state.fxl.codes[0].id : null;
          markStale();
          closeModal();
        },
      },
    ],
  });
}

function openFxlExport() {
  if (!state.fxl) return;
  const xml = state.fxl.serialize();
  const stem = safeName(state.fxlStem) || "feature_library";
  const ta = h("textarea", { class: "xml mono", readOnly: true }, xml);
  const status = h("div", { class: "modal-status", text: "" });

  openModal({
    title: "Export FXL",
    body: h("div", {}, [
      h("p", { class: "modal-note" }, `${state.fxl.codes.length} feature codes. Everything outside the feature definitions - line styles, symbols, label styles and layers - is carried over from the original file unchanged.`),
      h("p", { class: "modal-note" }, "Downloads here cannot use the .fxl extension, so the file comes inside a zip. Unzip it to get the .fxl for your data collector."),
      describedCodes().length
        ? h("div", { class: "notice" }, [
            h("span", { class: "notice-t", text: `${describedCodes().length} code description${describedCodes().length === 1 ? "" : "s"} included` }),
            "Descriptions are written into the .fxl itself, so they come back whenever you load this file again.",
          ])
        : null,
      ta,
    ]),
    statusEl: status,
    actions: [
      {
        label: "Copy XML", onclick: async () => {
          ta.select();
          status.textContent = (await copyText(xml)).status;
        },
      },
      {
        label: "Download zip", primary: true, onclick: async () => {
          status.textContent = "Preparing...";
          const blob = makeZip([{ name: stem + ".fxl", data: xml }]);
          status.textContent = (await offerDownload(stem + ".zip", blob)).status;
        },
      },
      { label: "Close", onclick: closeModal },
    ],
  });
}

function openFdmCsvExport() {
  if (!state.fxl) return;
  const stem = safeName(state.fxlStem) || "feature_library";
  const csv = buildLibraryCsv(state.fxl.codes);
  const byGeom = state.fxl.codes.reduce((m, c) => { m[c.geometry] = (m[c.geometry] || 0) + 1; return m; }, {});
  const parts = Object.keys(byGeom).map((g) => `${byGeom[g]} ${g.toLowerCase()}`).join(", ");
  const menus = state.fxl.codes.reduce((n, c) => n + (c.attributes || []).filter((a) => a.tag === "ListAttribute").length, 0);
  const required = state.fxl.codes.reduce((n, c) => n + (c.attributes || []).filter((a) => a.entryMethod === "Required").length, 0);
  const status = h("div", { class: "modal-status", text: "" });

  openModal({
    title: "Export CSV",
    body: h("div", {}, [
      h("p", { class: "modal-note" }, `${state.fxl.codes.length} feature codes (${parts}) in the layout the Feature Definition Manager reads and writes.`),
      menus || required
        ? h("div", { class: "notice notice-warn" }, [
            h("span", { class: "notice-t", text: "This format records attribute names and types only" }),
            `${menus ? `${menus} menu attribute${menus === 1 ? "'s options" : "s' options"}` : ""}${menus && required ? " and " : ""}${required ? `${required} Required entry setting${required === 1 ? "" : "s"}` : ""}, along with any minimum, maximum and decimals, are not part of a CSV and will not be in this file. Export FXL or XLS to keep them.`,
          ])
        : null,
    ]),
    statusEl: status,
    actions: [
      {
        label: "Download CSV", primary: true, onclick: async () => {
          status.textContent = (await offerDownload(stem + ".csv", csv)).status;
        },
      },
      { label: "Close", onclick: closeModal },
    ],
  });
}

function openXlsxExport() {
  if (!state.fxl) return;
  const stem = safeName(state.fxlStem) || "feature_library";
  const optionCount = state.fxl.codes.reduce((n, c) => n + (c.attributes || []).reduce((m, a) => m + (a.tag === "ListAttribute" ? (a.listItems || []).length : 0), 0), 0);
  const status = h("div", { class: "modal-status", text: "" });

  openModal({
    title: "Export XLS",
    body: h("div", {}, [
      h("p", { class: "modal-note" }, `${state.fxl.codes.length} feature codes as a Codes / Attributes / Options workbook (${optionCount} menu option${optionCount === 1 ? "" : "s"}). Re-import it here with Import > Excel workbook.`),
      h("p", { class: "modal-note" }, "Keep the header row and the sheet names as they are - columns can be reordered, and rows added or deleted. The workbook holds codes, attributes and menu options; styling the FXL carries, such as colors and layers, stays with the library here and is put back on re-import."),
    ]),
    statusEl: status,
    actions: [
      {
        label: "Download XLSX", primary: true, onclick: async () => {
          status.textContent = "Preparing...";
          const blob = buildLibraryXlsx(state.fxl.codes);
          status.textContent = (await offerDownload(stem + ".xlsx", blob)).status;
        },
      },
      { label: "Close", onclick: closeModal },
    ],
  });
}

/* ---------- code descriptions sidecar ---------- */

/* Descriptions live on the code itself and are written into the FXL. */
function describedCodes() {
  return state.fxl ? state.fxl.codes.filter((c) => c.description) : [];
}

function descriptionMap() {
  const m = {};
  for (const c of describedCodes()) m[c.code.trim().toUpperCase()] = c.description;
  return m;
}

/* ---------- PDF report ---------- */

function openPdfExport() {
  if (!state.fxl) return;
  const q = state.codeSearch.trim();
  const all = state.fxl.codes;
  const filtered = filterCodes(q);

  const scope = { value: q ? "filtered" : "all" };
  const status = h("div", { class: "modal-status", text: "" });
  const countLine = h("p", { class: "modal-note" });
  const paint = () => {
    const n = scope.value === "filtered" ? filtered.length : all.length;
    countLine.textContent = `${n} feature code${n === 1 ? "" : "s"} will be included, with a table of contents.`;
  };

  const body = h("div", {}, [
    h("p", { class: "modal-note" }, "A printable feature code report: every code with its attributes, prompts, menu options and Required flags."),
    q
      ? h("label", { class: "check radio-line" }, [
          h("input", { type: "checkbox", checked: true, onchange: (e) => { scope.value = e.target.checked ? "filtered" : "all"; paint(); } }),
          `Limit to the ${filtered.length} code${filtered.length === 1 ? "" : "s"} matching "${state.codeSearch.trim()}"`,
        ])
      : null,
    countLine,
    describedCodes().length === 0
      ? h("div", { class: "notice" }, [
          h("span", { class: "notice-t", text: "No code descriptions yet" }),
          "The report leaves the description line blank for each code. Fill in the Description box under any code and it is saved into the FXL with everything else.",
        ])
      : null,
  ]);
  paint();

  openModal({
    title: "Export feature code report",
    body,
    statusEl: status,
    actions: [
      {
        label: "Download PDF", primary: true, onclick: async () => {
          const codes = scope.value === "filtered" ? filtered : all;
          if (!codes.length) { status.textContent = "Nothing to export."; return; }
          status.textContent = "Building the report...";
          try {
            const stem = safeName(state.fxlStem) || "feature_library";
            const blob = buildLibraryPdf(codes, descriptionMap(), {
              title: stem,
              subtitle: "Feature code report",
              dateStr: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
            });
            status.textContent = (await offerDownload(stem + "_code_report.pdf", blob)).status;
          } catch (err) {
            status.textContent = "Could not build the PDF: " + (err && err.message ? err.message : "unknown error");
          }
        },
      },
      { label: "Close", onclick: closeModal },
    ],
  });
}

/* ============================================================
   RENDER - QAQC
   ============================================================ */

function renderQaqc() {
  if (!state.fxl || !state.csv) return renderQaqcEmpty();
  ensureFindings();

  const toolbar = h("div", { class: "row" }, [
    loadCsvButton("Replace CSV"),
    h("button", { class: "btn", onclick: openReportExport, disabled: state.findings.length === 0 }, "Export report"),
    h("div", { class: "grow" }),
    h("input", {
      class: "input search", type: "search", placeholder: "Filter by point or code", value: state.findingSearch,
      oninput: (e) => { state.findingSearch = e.target.value; refreshFindings(); },
    }),
  ]);

  const meta = h("div", { class: "meta" }, [
    h("span", { text: "Survey data" }), h("span", { class: "meta-v", text: state.csvName }),
    h("span", { class: "dot", text: "/" }),
    h("span", { text: "Checked against" }), h("span", { class: "meta-v", text: state.fxlStem + ".fxl" }),
  ]);

  const parts = [toolbar, meta];
  if (!state.csv.hasHeader) {
    parts.push(h("div", { class: "notice" }, [
      h("span", { class: "notice-t", text: "No header row detected" }),
      "Columns are being read in PNEZD order: point, northing, easting, elevation, description, then ATTRIBUTE1 onward. Every row is treated as data. If your file does have a header, check that its first five column names match the template.",
    ]));
  }

  const errors = state.findings.filter((f) => f.severity === "error").length;
  const warnings = state.findings.length - errors;
  const codesUsed = new Set(state.csv.rows.map((r) => r.code).filter(Boolean)).size;

  parts.push(h("div", { class: "stats" }, [
    stat("Points checked", state.csv.rows.length, ""),
    stat("Codes used", codesUsed, ""),
    stat("Errors", errors, "stat-err"),
    stat("Warnings", warnings, "stat-warn"),
  ]));

  els.segWrap = h("div", { class: "row" });
  els.findings = h("div", { class: "ftable" });
  parts.push(els.segWrap, els.findings);
  refreshFindings();

  return h("div", { class: "stack" }, parts);
}

function stat(label, value, cls) {
  return h("div", { class: "stat " + cls }, [
    h("div", { class: "stat-v", text: String(value) }),
    h("div", { class: "stat-l", text: label }),
  ]);
}

function renderQaqcEmpty() {
  const fxlOk = !!state.fxl;
  const csvOk = !!state.csv;
  return h("div", { class: "empty" }, [
    h("div", { class: "empty-h", text: "Check survey data against a feature library" }),
    h("div", { class: "empty-p" }, "Every point's feature code and attribute values are checked against the FXL. Coordinates and elevations are not checked."),
    h("div", { class: "empty-p" }, [
      h("strong", { text: "Errors" }),
      " are problems that stop a point being used as collected: an unknown or blank feature code, a duplicate point number, or a missing attribute the FXL marks Required. ",
      h("strong", { text: "Warnings" }),
      " are attribute values worth reviewing: a value outside a menu's option list, a number that is not a plain number, a value outside the FXL's min or max, or data in columns the code does not define.",
    ]),
    h("div", { class: "steps" }, [
      h("div", { class: "step" }, [
        h("span", { class: "step-n", text: "1" }),
        h("div", { class: "step-body" }, [
          h("div", { class: "step-t", text: "Feature library (.fxl)" }),
          h("div", { class: "step-s" + (fxlOk ? " step-s-ok" : ""), text: fxlOk ? state.fxlStem + ".fxl" : "Not loaded" }),
        ]),
        h("div", { class: "row" }, [
          importLibraryButton(fxlOk ? "Replace" : "Import"),
          !fxlOk ? h("button", { class: "btn", onclick: loadSampleData }, "Load sample data") : null,
        ]),
      ]),
      h("div", { class: "step" }, [
        h("span", { class: "step-n", text: "2" }),
        h("div", { class: "step-body" }, [
          h("div", { class: "step-t", text: "Survey data (.csv, PNEZD)" }),
          h("div", { class: "step-s" + (csvOk ? " step-s-ok" : ""), text: csvOk ? state.csvName : "Not loaded" }),
        ]),
        loadCsvButton(csvOk ? "Replace" : "Load CSV"),
      ]),
    ]),
    h("div", { class: "empty-p" }, [
      "Expected column order: ",
      h("code", { text: "POINT, NORTHING, EASTING, ELEVATION, DESCRIPTION, ATTRIBUTE1 ... ATTRIBUTEn" }),
      ". The description column holds the feature code, and attribute columns must follow the order the FXL defines for that code.",
    ]),
    h("button", { class: "btn", onclick: openTemplateExport }, "Download blank CSV template"),
  ]);
}

function loadCsvButton(label, primary) {
  return fileButton(label, ".csv,.txt", primary, async (file) => {
    const text = await file.text();
    const csv = parsePnezdCsv(text);
    if (csv.empty) {
      openModal({
        title: "Empty file",
        body: h("p", { class: "modal-note" }, `${file.name} has no rows in it.`),
        actions: [{ label: "Close", primary: true, onclick: closeModal }],
      });
      return;
    }
    state.csv = csv;
    state.csvName = file.name;
    state.filter = "all";
    state.findingSearch = "";
    markStale();
    render();
  });
}

function refreshFindings() {
  if (!els.findings) return;
  ensureFindings();
  const errors = state.findings.filter((f) => f.severity === "error").length;
  const warnings = state.findings.length - errors;

  if (els.segWrap) {
    const seg = (id, label) => h("button", {
      class: "seg-b" + (state.filter === id ? " seg-on" : ""),
      onclick: () => { state.filter = id; refreshFindings(); },
    }, label);
    els.segWrap.replaceChildren(
      h("div", { class: "seg" }, [
        seg("all", `All ${state.findings.length}`),
        seg("error", `Errors ${errors}`),
        seg("warning", `Warnings ${warnings}`),
      ]),
      h("span", { class: "sev-key" }, "Errors stop a point being used as collected. Warnings are attribute values to review.")
    );
  }

  let rows = state.findings;
  if (state.filter !== "all") rows = rows.filter((f) => f.severity === state.filter);
  const q = state.findingSearch.trim().toUpperCase();
  if (q) rows = rows.filter((f) => f.point.toUpperCase().includes(q) || f.code.toUpperCase().includes(q));

  if (!rows.length) {
    els.findings.replaceChildren(state.findings.length === 0
      ? h("div", { class: "fclean", text: "No attribute problems found. Every point matches the feature library." })
      : h("div", { class: "fnone", text: "No findings match this filter." }));
    return;
  }

  const shown = rows.slice(0, FINDING_LIMIT);
  const out = [h("div", { class: "fhead" }, [
    h("div", { text: "Line" }), h("div", { text: "Point" }), h("div", { text: "Code" }),
    h("div", { text: "Level" }), h("div", { text: "Field" }), h("div", { text: "Problem" }),
  ])];
  for (const f of shown) {
    out.push(h("div", { class: "frow" }, [
      h("div", { class: "mono", text: String(f.line) }),
      h("div", { class: "mono", text: f.point }),
      h("div", { class: "mono", text: f.code }),
      h("div", {}, h("span", { class: "fsev sev-" + f.severity, text: f.severity })),
      h("div", { class: "mono", text: f.field }),
      h("div", { class: "fmsg", text: f.message }),
    ]));
  }
  if (rows.length > shown.length) {
    out.push(h("div", { class: "fnote", text: `Showing the first ${shown.length} of ${rows.length} findings. Export the report to see all of them.` }));
  }
  els.findings.replaceChildren(...out);
}

function openReportExport() {
  const lines = ["Line,Point,Code,Severity,Field,Problem"];
  const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
  for (const f of state.findings) lines.push([f.line, f.point, f.code, f.severity, f.field, f.message].map(cell).join(","));
  const csvText = lines.join("\r\n");
  const stem = baseName(state.csvName, "survey") + "_qaqc";
  const status = h("div", { class: "modal-status", text: "" });

  openModal({
    title: "Export QAQC report",
    body: h("div", {}, [
      h("p", { class: "modal-note" }, `${state.findings.length} finding${state.findings.length === 1 ? "" : "s"}, with the line number of each point as it appears in the source file.`),
      h("textarea", { class: "xml mono", readOnly: true }, csvText),
    ]),
    statusEl: status,
    actions: [
      { label: "Copy", onclick: async () => { status.textContent = (await copyText(csvText)).status; } },
      { label: "Download CSV", primary: true, onclick: async () => { status.textContent = (await offerDownload(stem + ".csv", csvText)).status; } },
      { label: "Close", onclick: closeModal },
    ],
  });
}

function openTemplateExport() {
  const cols = ["POINT", "NORTHING", "EASTING", "ELEVATION", "DESCRIPTION"];
  for (let i = 1; i <= 20; i++) cols.push("ATTRIBUTE" + i);
  const example = ["1", "10000.000", "5000.000", "1000.000", "YOUR_FEATURE_CODE"];
  for (let i = 1; i <= 20; i++) example.push(i <= 3 ? "ATTRIBUTE_" + i + "_VALUE" : "");
  const csvText = [cols.join(","), example.join(","), ""].join("\r\n");
  const status = h("div", { class: "modal-status", text: "" });

  openModal({
    title: "Blank PNEZD template",
    body: h("div", {}, [
      h("p", { class: "modal-note" }, "Twenty attribute columns are included. Delete the example row before collecting data, and delete any attribute columns your codes do not use."),
      h("p", { class: "modal-note" }, "Attribute columns are positional: ATTRIBUTE1 must hold the first attribute the FXL defines for that feature code, ATTRIBUTE2 the second, and so on."),
      h("textarea", { class: "xml mono", readOnly: true }, csvText),
    ]),
    statusEl: status,
    actions: [
      { label: "Copy", onclick: async () => { status.textContent = (await copyText(csvText)).status; } },
      { label: "Download CSV", primary: true, onclick: async () => { status.textContent = (await offerDownload("PNEZD_template.csv", csvText)).status; } },
      { label: "Close", onclick: closeModal },
    ],
  });
}

/* ============================================================
   shared widgets
   ============================================================ */

function fileButton(label, accept, primary, onFile) {
  const input = h("input", {
    type: "file", accept, class: "file-hidden",
    onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onFile(f); },
  });
  return h("span", {}, [
    h("button", { class: "btn" + (primary ? " btn-primary" : ""), onclick: () => input.click() }, label),
    input,
  ]);
}

function openModal(cfg) { state.modal = cfg; render(); }
function closeModal() {
  document.removeEventListener("keydown", escOnce);
  state.modal = null;
  render();
}

function renderModal() {
  const cfg = state.modal;
  const overlay = h("div", {
    class: "overlay",
    onclick: (e) => { if (e.target === overlay) closeModal(); },
  });
  overlay.appendChild(h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
    h("div", { class: "modal-h" }, [
      h("h2", { text: cfg.title }),
      h("button", { class: "btn btn-sm", onclick: closeModal, title: "Close" }, "Close"),
    ]),
    h("div", { class: "modal-b" }, cfg.body),
    h("div", { class: "modal-f" }, [
      cfg.statusEl || null,
      ...(cfg.actions || [{ label: "Close", primary: true, onclick: closeModal }]).map((a) =>
        h("button", { class: "btn" + (a.primary ? " btn-primary" : ""), onclick: a.onclick }, a.label)
      ),
    ]),
  ]));
  document.addEventListener("keydown", escOnce);
  return overlay;
}
function escOnce(e) {
  if (e.key === "Escape" && state.modal) closeModal();
}

render();
