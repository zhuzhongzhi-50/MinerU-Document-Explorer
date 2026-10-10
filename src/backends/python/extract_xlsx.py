#!/usr/bin/env python3
"""Extract Markdown text from an .xlsx/.xls file (each sheet -> a Markdown table).

Uses openpyxl to read .xlsx workbooks. Legacy .xls is not supported by openpyxl;
in that case an error is returned suggesting conversion to .xlsx.

Output (stdout, JSON):
    { "markdown": "<joined markdown>", "sheets": [{"sheet_idx": N, "title": "...", "text": "...", "tokens": N}] }
On error:
    { "error": "message" }
"""
import sys
import json


def _escape(cell):
    return str(cell).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def _sheet_to_markdown(title, rows):
    if not rows:
        return ""
    ncols = max((len(r) for r in rows), default=0)

    def norm(row):
        row = list(row) + [""] * (ncols - len(row))
        return [_escape(c) for c in row]

    lines = ["## " + (title or "Sheet")]
    header = norm(rows[0])
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---"] * ncols) + " |")
    for row in rows[1:]:
        lines.append("| " + " | ".join(norm(row)) + " |")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: extract_xlsx.py <filepath>"}))
        sys.exit(1)
    filepath = sys.argv[1]

    try:
        import openpyxl
    except ImportError:
        print(json.dumps({"error": "openpyxl not installed. Run: pip install openpyxl"}))
        sys.exit(1)

    try:
        wb = openpyxl.load_workbook(filepath, data_only=True, read_only=True)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open XLSX: {e}. Legacy .xls requires conversion to .xlsx."}))
        sys.exit(1)

    sheets = []
    blocks = []
    for sheet_idx, ws in enumerate(wb.worksheets):
        rows = [list(row) for row in ws.iter_rows(values_only=True)]
        text = _sheet_to_markdown(ws.title, rows)
        tokens = len(text.split())
        sheets.append({"sheet_idx": sheet_idx, "title": ws.title, "text": text, "tokens": tokens})
        if text:
            blocks.append(text)

    print(json.dumps({"markdown": "\n\n".join(blocks), "sheets": sheets}))


if __name__ == "__main__":
    main()
