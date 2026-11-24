"""
Fill the Milestone 2 template with real results.

Usage:
    python fill_m2.py --template M2_template.docx --results results/results.json \
                      --figs results/figures --out M2_final.docx

- Replaces every «KEY» in the document with results.json["KEY"].
- Replaces the figure slots «FIG2», «FIG3», «FIG4» with figures/fig2.png, fig3.png, fig4.png.
- Removes the yellow highlight from filled values.
- Refuses to finish if any «KEY» is left unfilled, and lists what is missing.
- Exports a PDF next to the .docx (needs LibreOffice: soffice).
"""
import argparse, json, re, subprocess, sys
from pathlib import Path
from docx import Document
from docx.shared import Inches
from docx.enum.text import WD_COLOR_INDEX

TOKEN = re.compile(r"«([A-Z0-9_]+)»")
FIGS = {"FIG2": "fig2.png", "FIG3": "fig3.png", "FIG4": "fig4.png"}


def all_paragraphs(doc):
    for p in doc.paragraphs:
        yield p
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    yield p


def clear_border(p):
    pPr = p._p.pPr
    if pPr is not None:
        for el in list(pPr):
            if el.tag.endswith("}pBdr"):
                pPr.remove(el)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", default="M2_template.docx")
    ap.add_argument("--results", default="results/results.json")
    ap.add_argument("--figs", default="results/figures")
    ap.add_argument("--out", default="M2_final.docx")
    a = ap.parse_args()

    vals = json.loads(Path(a.results).read_text(encoding="utf-8"))
    vals = {k: ("" if v is None else str(v)) for k, v in vals.items()}
    doc = Document(a.template)
    missing = set()

    for p in list(all_paragraphs(doc)):
        txt = p.text.strip()
        # figure slots
        m = TOKEN.match(txt)
        if m and m.group(1) in FIGS:
            img = Path(a.figs) / FIGS[m.group(1)]
            if not img.exists():
                missing.add(f"{m.group(1)} (file {img})")
                continue
            for r in p.runs:
                r.text = ""
            clear_border(p)
            p.runs[0].font.highlight_color = None
            p.runs[0].add_picture(str(img), width=Inches(6.3))
            continue
        # text tokens
        for r in p.runs:
            if "«" not in r.text:
                continue
            def sub(mm):
                k = mm.group(1)
                if k not in vals or vals[k].strip() == "":
                    missing.add(k)
                    return mm.group(0)
                return vals[k]
            new = TOKEN.sub(sub, r.text)
            if new != r.text:
                r.font.highlight_color = None
                lines = new.split("\n")
                r.text = lines[0]
                for line in lines[1:]:
                    r.add_break()
                    r.add_text(line)

    if missing:
        print("NOT DONE. Missing values for:", ", ".join(sorted(missing)))
        sys.exit(1)

    # final check: nothing left
    left = [TOKEN.findall(p.text) for p in all_paragraphs(doc)]
    left = sorted({k for l in left for k in l})
    if left:
        print("Unfilled tokens remain:", left)
        sys.exit(1)

    doc.save(a.out)
    print("Saved", a.out)
    try:
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir",
                        str(Path(a.out).parent or "."), a.out], check=True)
        print("PDF exported")
    except Exception as e:
        print("PDF export failed (open the .docx in Word and Save As PDF):", e)


if __name__ == "__main__":
    main()
