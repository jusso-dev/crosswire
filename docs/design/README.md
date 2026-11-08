# Design and security reference

| File | What it is |
|------|------------|
| `analyst-workspace-design.html` | Source. Self-contained (inline CSS, no scripts, no external assets), unbranded. |
| `analyst-workspace-design.pdf` | Generated from the HTML. A4, selectable text, live links, bookmarks from headings. |
| `render.sh` | Regenerates the PDF. |

Verified against commit `95c7f97` on `main`. When the code changes, update the HTML and re-render. The code is the source of truth.

## Render

```sh
bash docs/design/render.sh
```

Needs Google Chrome or Chromium (set `CHROME=/path/to/binary` to override). It runs headless Chrome with
`--print-to-pdf --no-pdf-header-footer --generate-pdf-document-outline`; page size and margins come from the
document's `@page` rule.

## Review after rendering

```sh
pdfinfo docs/design/analyst-workspace-design.pdf          # page count, A4
pdfinfo -url docs/design/analyst-workspace-design.pdf     # external links
qpdf --check docs/design/analyst-workspace-design.pdf     # structure
pdftoppm -r 60 -png docs/design/analyst-workspace-design.pdf /tmp/page   # look for clipped tables
```

Tools: `poppler` and `qpdf` (Homebrew). The only block that does not wrap is the component diagram in section 3.1. Keep it under about 100 characters wide.
