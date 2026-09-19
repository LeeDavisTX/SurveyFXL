# Survey FXL Toolkit

A browser-based tool for editing Trimble-style FXL feature libraries and
QAQC-checking PNEZD survey CSVs against them.

No build step, no dependencies, no network calls. Everything runs client-side
in the browser, and survey data never leaves the machine it is opened on.

## Running it

Open `index.html` in a browser, or serve the folder with any static file
server:

```
python3 -m http.server 8000
```

To publish it on GitHub Pages: push these files to a repository, then in
**Settings > Pages** set the source to the `main` branch and the `/ (root)`
folder. The app is a plain static site, so nothing else is needed.

## What it does

**Feature Library tab** — load an FXL and browse, edit, add or delete feature
codes: their geometry, category, layer, description, and the attributes each
one collects (text, number, integer, photo, or a menu with a fixed option
list). Export back to FXL, to CSV, to Excel, or to a PDF feature code report.

**Add photo** puts a photo capture on a code in one click — the crew is asked
for a picture when they store the feature. It appears as an attribute named
PHOTO, and codes that ask for one are marked with a camera in the code list.
Photos are never QAQC-checked.

Every code names the layer it draws on, and a line or polygon also names the
layer its vertex points land on. **Layers** manages that list — add, rename
(which moves every code already on it), or remove an unused one. A code
naming a layer the file doesn't declare is flagged on the library, because
Trimble's software will not open a file like that.

Anything the editor doesn't model — block features, per-feature symbology,
line styles, label styles — is carried through an edit untouched. Loading a
library and exporting it without changing anything reproduces the original
file exactly, which the test suite verifies against Trimble's own
GlobalFeatures.fxl.

**QAQC Check tab** — load a PNEZD CSV and check every row against the loaded
library. Expected column order is:

```
POINT, NORTHING, EASTING, ELEVATION, DESCRIPTION, ATTRIBUTE1 ... ATTRIBUTEn
```

The DESCRIPTION column holds the feature code, and the attribute columns must
follow the order the FXL defines for that code.

*Errors* are problems that stop a point being used as collected: an unknown or
blank feature code, a duplicate point number, or a missing attribute the FXL
marks Required. *Warnings* are attribute values worth reviewing: a value
outside a menu's option list, a number that is not a plain number, a value
outside the FXL's min or max, or data in columns the code does not define.

Photo attributes are never checked — a photo is taken on the data collector,
not typed — but they still count in the attribute order.

Coordinates and elevations are not checked.

## Getting started

The app opens blank. Three ways in, all on the start screen:

- **Import** — an `.fxl`, an `.xml`, a `.zip` containing one, a `.csv`
  exported from the Feature Definition Manager, or an `.xlsx` previously
  exported from here.
- **Start new library** — build one from scratch in the UI.
- **Load sample data** — 5 everyday survey codes (TRE, FNC, UPL, FHY, CTL)
  plus a matching survey CSV that carries a few deliberate problems, so the
  QAQC tab has something to show.

## Feature Definition Manager CSV

**Export CSV** writes the same layout Trimble's Feature Definition Manager
reads and writes, so a library can go straight between the two. It is six
sections in one file — point, line, polygon and block features, then control
codes and control code blocks — each a header row followed by its rows, with
a UTF-8 BOM and CRLF line endings. Each row is that geometry's fixed columns
followed by a variable-length tail of `name,type` attribute pairs.

Round-tripping FDM's own export through this tool reproduces the file byte
for byte, which the test suite checks against a real export. Columns can be
reordered and the file will still import — they are matched by name.

**The format records only each attribute's name and type.** Menu options,
Required entry, minimum, maximum, decimals and descriptions are not in a CSV
at all — and those are exactly what the QAQC tab checks. On import the tool
recovers them from the library being replaced wherever the same code and
attribute are still there, and tells you how many it restored. Anything new
arrives as Optional with no options or limits. Use FXL or XLS when you need
a lossless round trip.

## Editing a library in Excel

**Export XLS** writes a three-sheet workbook:

| Sheet | One row per | Columns |
| --- | --- | --- |
| Codes | feature code | Code, Name, Geometry, Category, Layer, Point Layer, Description, In Surface |
| Attributes | attribute | Code, Order, Attribute Name, Prompt, Type, Entry, Min, Max, Decimals, Default |
| Options | menu option | Code, Attribute Name, Order, Option |

Edit it in Excel, then bring it back with **Import > Excel workbook**. Keep the
header row and the sheet names; columns can be reordered, and rows added or
deleted freely. `Order` on the Attributes sheet is what sets ATTRIBUTE1..N in
the CSV, so it matters.

Anything the workbook has no column for — colors, layers, and any part of the
FXL this tool does not model — is taken back from the library being replaced
when the same code is still there, so an export/edit/re-import round trip does
not quietly reset it.

## Files

- `index.html` — page shell, styling, design tokens
- `app.js` — FXL parser/serializer, CSV parser, QAQC engine, UI
- `pdf.js` — self-contained PDF writer for the feature code report
- `xlsx.js` — self-contained Excel reader/writer for the XLS import/export
- `csvfdm.js` — reader/writer for the Feature Definition Manager's CSV layout

## Notes

- Downloads use the browser's native download flow. FXL exports come wrapped
  in a `.zip`, because browsers will not save a bare `.fxl`; unzip it to get
  the file for your data collector.
- Feature codes and attribute names are stored upper case with underscores,
  matching how they are typed on a data collector. Names already in a loaded
  FXL are left exactly as they are.
