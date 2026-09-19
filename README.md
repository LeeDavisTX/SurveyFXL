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
codes: their geometry, category, description, and the attributes each one
collects (text, number, integer, or a menu with a fixed option list). Export
back to FXL, to Excel, or to a PDF feature code report.

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

Coordinates and elevations are not checked.

## Getting started

The app opens blank. Three ways in, all on the start screen:

- **Import** — an `.fxl`, an `.xml`, a `.zip` containing one, or an `.xlsx`
  previously exported from here.
- **Start new library** — build one from scratch in the UI.
- **Load sample data** — 5 everyday survey codes (TRE, FNC, UPL, FHY, CTL)
  plus a matching survey CSV that carries a few deliberate problems, so the
  QAQC tab has something to show.

## Editing a library in Excel

**Export XLS** writes a three-sheet workbook:

| Sheet | One row per | Columns |
| --- | --- | --- |
| Codes | feature code | Code, Name, Geometry, Category, Description, In Surface |
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

## Notes

- Downloads use the browser's native download flow. FXL exports come wrapped
  in a `.zip`, because browsers will not save a bare `.fxl`; unzip it to get
  the file for your data collector.
- Feature codes and attribute names are stored upper case with underscores,
  matching how they are typed on a data collector. Names already in a loaded
  FXL are left exactly as they are.
