"""Build the printable Bifrost guide from its maintainable Markdown source.

Use the Codex bundled Python runtime with reportlab, pypdf and Pillow installed.
The PDF contains no live credentials, screenshots or production request data.
"""

from pathlib import Path
import html
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Flowable, Paragraph, Spacer, Table, TableStyle
from reportlab.lib import textsplit
from reportlab.platypus import paragraph as paragraph_engine

# ReportLab's default Japanese punctuation set omits several Chinese marks.
# Extend it for this builder only so closing punctuation cannot start a line.
for module in (textsplit, paragraph_engine):
    module.ALL_CANNOT_START += "，；：！？）】》”’％"


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/BIFROST_USER_GUIDE.md"
OUTPUT = ROOT / "output/pdf/Bifrost_使用教程.pdf"
W, H = letter
LEFT, RIGHT, TOP, BOTTOM = 48, 48, 44, 45
WIDTH = W - LEFT - RIGHT
INK = colors.HexColor("#20232C")
MUTED = colors.HexColor("#666D7D")
ACCENT = colors.HexColor("#7050B4")
LINE = colors.HexColor("#D9D9D9")
PALE = colors.HexColor("#F6F7FA")

pdfmetrics.registerFont(TTFont("Guide", "C:/Windows/Fonts/msyh.ttc", subfontIndex=0))
pdfmetrics.registerFont(TTFont("GuideBold", "C:/Windows/Fonts/msyhbd.ttc", subfontIndex=0))
pdfmetrics.registerFontFamily("Guide", normal="Guide", bold="GuideBold", italic="Guide", boldItalic="GuideBold")

BODY = ParagraphStyle("Body", fontName="Guide", fontSize=10.7, leading=17.3, textColor=INK,
                      wordWrap="CJK", spaceAfter=7, splitLongWords=True)
STYLES = {
    "body": BODY,
    "title": ParagraphStyle("Title", parent=BODY, fontName="GuideBold", fontSize=27, leading=37,
                            textColor=colors.black, spaceAfter=14),
    "h1": ParagraphStyle("H1", parent=BODY, fontName="GuideBold", fontSize=23, leading=32,
                         textColor=colors.black, spaceAfter=15),
    "h2": ParagraphStyle("H2", parent=BODY, fontName="GuideBold", fontSize=13, leading=20,
                         textColor=colors.black, spaceBefore=8, spaceAfter=7),
    "small": ParagraphStyle("Small", parent=BODY, fontSize=9.2, leading=14.8, textColor=MUTED),
    "subtitle": ParagraphStyle("Subtitle", parent=BODY, fontSize=12, leading=20,
                               textColor=colors.black, spaceAfter=4),
    "step": ParagraphStyle("Step", parent=BODY, leftIndent=20, firstLineIndent=-20, spaceAfter=7),
    "cell": ParagraphStyle("Cell", parent=BODY, fontSize=10, leading=15.3, spaceAfter=0),
    "cellhead": ParagraphStyle("CellHead", parent=BODY, fontName="GuideBold", fontSize=10,
                               leading=15.3, textColor=colors.white, spaceAfter=0),
}


def inline(text):
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`(.+?)`", r'<font color="#4F3881">\1</font>', text)
    # Link the one real daily entry; examples and browser-internal URLs remain text.
    text = text.replace("https://bifrost.vanillacake.cn/", '<link href="https://bifrost.vanillacake.cn/" color="#7050B4">https://bifrost.vanillacake.cn/</link>')
    return text


class StepsDiagram(Flowable):
    def __init__(self, labels):
        Flowable.__init__(self)
        self.labels = labels
        self.width = WIDTH
        self.height = 61

    def draw(self):
        c = self.canv
        n = len(self.labels)
        step = WIDTH / n
        c.setStrokeColor(LINE)
        c.setLineWidth(1)
        c.line(step / 2, 41, WIDTH - step / 2, 41)
        for i, label in enumerate(self.labels):
            x = (i + 0.5) * step
            c.setFillColor(ACCENT)
            c.circle(x, 41, 11, stroke=0, fill=1)
            c.setFillColor(colors.white)
            c.setFont("GuideBold", 9)
            c.drawCentredString(x, 37.7, str(i + 1))
            c.setFillColor(INK)
            c.setFont("Guide", 9.5)
            c.drawCentredString(x, 15, label)


class Timeline(Flowable):
    def __init__(self, rows):
        Flowable.__init__(self)
        self.rows = rows
        self.width = WIDTH
        self.height = len(rows) * 35 + 5

    def draw(self):
        c = self.canv
        c.setStrokeColor(LINE)
        c.line(48, 24, 48, self.height - 14)
        for i, (time, title, detail) in enumerate(self.rows):
            y = self.height - 14 - 35 * i
            c.setFont("Guide", 9)
            c.setFillColor(MUTED)
            c.drawString(0, y - 3, time)
            c.setFillColor(ACCENT)
            c.circle(48, y, 3.2, stroke=0, fill=1)
            c.setFillColor(INK)
            c.setFont("GuideBold", 10.5)
            c.drawString(63, y - 3, title)
            c.setFillColor(MUTED)
            c.setFont("Guide", 9.5)
            c.drawString(63, y - 20, detail)


def table(lines):
    rows = [[s.strip() for s in row.strip().strip("|").split("|")] for row in lines]
    rows = [row for row in rows if not all(re.match(r"^:?-+:?$", cell) for cell in row)]
    if rows[0][-1] == "页码":
        widths = [WIDTH - 48, 48]
    elif len(rows[0]) == 3:
        widths = [108, 155, WIDTH - 263]
    else:
        widths = [135, WIDTH - 135]
    cells = []
    for i, row in enumerate(rows):
        cells.append([])
        for j, cell in enumerate(row):
            content = inline(cell)
            style = STYLES["cellhead" if i == 0 else "cell"]
            if rows[0][-1] == "页码" and j == 1:
                style = ParagraphStyle("PageNumber", parent=style, alignment=TA_CENTER)
                if i:
                    content = f'<link href="#page{cell}" color="#7050B4">{content}</link>'
            cells[-1].append(Paragraph(content, style))
    t = Table(cells, colWidths=widths, hAlign="LEFT", repeatRows=1)
    ops = [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#343B51")),
           ("GRID", (0, 0), (-1, -1), 0.45, LINE),
           ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
           ("LEFTPADDING", (0, 0), (-1, -1), 9),
           ("RIGHTPADDING", (0, 0), (-1, -1), 9),
           ("TOPPADDING", (0, 0), (-1, -1), 5),
           ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]
    for i in range(1, len(cells)):
        ops.append(("BACKGROUND", (0, i), (-1, i), colors.white if i % 2 else PALE))
    if rows[0][-1] == "页码":
        # Compact navigation, with real page destinations in the page-number cells.
        ops.extend([("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3)])
    t.setStyle(TableStyle(ops))
    t.spaceBefore = 3
    t.spaceAfter = 11
    return t


def parse_page(text, first=False):
    flow = []
    lines = text.strip().splitlines()
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s:
            i += 1
            continue
        if s.startswith("# "):
            flow.append(Paragraph(inline(s[2:]), STYLES["title" if first else "h1"]))
        elif s.startswith("## "):
            flow.append(Paragraph(inline(s[3:]), STYLES["h2"]))
        elif s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            flow.append(table(rows))
            continue
        elif s == ":::flow":
            flow.append(StepsDiagram(lines[i + 1].split("|")))
            i += 2
        elif s == ":::timeline":
            rows = []
            i += 1
            while lines[i].strip() != ":::":
                rows.append(lines[i].split("|"))
                i += 1
            flow.append(Timeline(rows))
        elif s.startswith("面向 QA"):
            flow.append(Paragraph(inline(s), STYLES["subtitle"]))
        elif s.startswith("2026 年"):
            flow.append(Paragraph(inline(s), STYLES["small"]))
        elif re.match(r"^\d+\. ", s):
            flow.append(Paragraph(inline(s), STYLES["step"]))
        elif s.startswith("- "):
            flow.append(Paragraph("•　" + inline(s[2:]), STYLES["step"]))
        elif s != ":::":
            flow.append(Paragraph(inline(s), STYLES["body"]))
        i += 1
    return flow


def build():
    pages = SOURCE.read_text(encoding="utf-8").split("<!-- sources -->")[0].split("<!-- page -->")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=letter, pageCompression=1)
    c.setTitle("Bifrost 使用教程")
    c.setAuthor("guanzhen")
    c.setSubject("面向 QA 与研发的版本选择和提测指南")
    c.setViewerPreference("DisplayDocTitle", "true")
    c.showOutline()
    overflows = []
    for page_index, text in enumerate(pages, 1):
        title = next(x[2:] for x in text.splitlines() if x.startswith("# "))
        c.bookmarkPage(f"page{page_index}")
        c.addOutlineEntry(title, f"page{page_index}", 0)
        if page_index > 1:
            c.setFont("Guide", 8)
            c.setFillColor(colors.black)
            c.drawString(LEFT, H - 25, "Bifrost 使用教程")
        y = H - TOP
        for item in parse_page(text, first=page_index == 1):
            y -= item.getSpaceBefore()
            _, height = item.wrap(WIDTH, H)
            if y - height < BOTTOM:
                overflows.append(f"Page {page_index} overflow by {BOTTOM - (y-height):.1f} pt")
            item.drawOn(c, LEFT, y - height)
            y -= height + item.getSpaceAfter()
        c.setFont("Guide", 8)
        c.setFillColor(MUTED)
        c.drawString(LEFT, 24, "2026 年 9 月版    扩展 0.11.23")
        c.setFillColor(colors.black)
        c.drawRightString(W - RIGHT, 24, f"{page_index:02d} / {len(pages):02d}")
        print(f"Page {page_index}: used {H-TOP-y:.1f} pt; bottom {y:.1f} pt; {title}")
        c.showPage()
    if overflows:
        raise RuntimeError("; ".join(overflows))
    c.save()
    print(OUTPUT)


if __name__ == "__main__":
    build()
