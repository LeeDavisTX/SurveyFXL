# Survey FXL Toolkit

A browser-based tool for editing Trimble-style FXL feature libraries and
QAQC-checking PNEZD survey CSVs against them.

No build step, no dependencies. Everything runs client-side in the browser.

## Running it

Just open `index.html` in a browser, or serve the folder with any static
file server, e.g.:

```
npx serve .
```

or

```
python3 -m http.server 8000
```

## Files

- `index.html` - page shell, styling, design tokens
- `app.js` - FXL parser/serializer, CSV parser, QAQC engine, UI
- `pdf.js` - self-contained PDF writer used for the feature code report export

## Notes

- The app opens blank; load an `.fxl` (or a `.zip` containing one) and/or a
  PNEZD `.csv` to get started.
- Downloads (FXL export, PDF report, QAQC report, CSV template) use the
  browser's native download flow when running as a plain static site.
