#!/usr/bin/env python3
"""Cell layout of the official Sodra SAM v07 paper form (PDF annex of Sodra order V-243), for SAM and SAM3SD pages.

Usage: python3 scripts/paper-form-layout.py SAM_v07_forma.pdf assets/forms
The PDF is rendered at 300 dpi (pdftoppm); input boxes ("combs" of cells) and tick lines are detected in the image and
mapped to the FFData field names of the SAM v07 data description. Writes sam-v07.json, sam3sd-v07.json and copies the PDF.
"""
import json, os, shutil, subprocess, sys, tempfile
from PIL import Image

def load(png):
    im = Image.open(png).convert('L'); return im, im.load()

def combs(png):
    im, px = load(png); W, H = im.size
    dark = lambda x, y: px[x, y] < 140
    runs = {}
    for y in range(H):
        x = 0
        while x < W:
            if dark(x, y):
                s = x
                while x < W and dark(x, y): x += 1
                if x - s >= 35: runs.setdefault(y, []).append((s, x - 1))
            x += 1
    out = []
    for y in sorted(runs):
        for s, e in runs[y]:
            if any(abs(s - o[0]) <= 3 and abs(y - o[1]) <= 4 for o in out): continue
            for h in range(30, 90):
                yb = y + h
                if yb in runs and any(abs(s2 - s) <= 3 and abs(e2 - e) <= 3 for s2, e2 in runs[yb]):
                    cols = [x for x in range(s, e + 1) if sum(1 for yy in range(y + 2, yb - 1) if dark(x, yy)) >= 0.25 * (h - 3)]
                    seps = []
                    for x in cols:
                        if seps and x - seps[-1][1] <= 2: seps[-1][1] = x
                        else: seps.append([x, x])
                    cells = [[seps[i][1] + 1, y + 3, seps[i + 1][0] - 1, yb - 3] for i in range(len(seps) - 1) if seps[i + 1][0] - seps[i][1] > 15]
                    out.append((s, y, e, yb, cells))
                    break
    return out

def ticks(png):
    im, px = load(png); W, H = im.size
    dark = lambda x, y: px[x, y] < 140
    out = []
    for y in range(40, H):
        x = 0
        while x < W:
            if dark(x, y):
                s = x
                while x < W and dark(x, y): x += 1
                if x - s >= 1200:
                    t = [c for c in range(s, x) if dark(c, y - 8) and dark(c, y - 12) and not dark(c, y - 30)]
                    seps = []
                    for c in t:
                        if seps and c - seps[-1][1] <= 2: seps[-1][1] = c
                        else: seps.append([c, c])
                    if len(seps) > 10 and not any(abs(o[0] - y) <= 3 for o in out):
                        out.append((y, s, x - 1, [[seps[i][1] + 1, y - 50, seps[i + 1][0] - 1, y - 2] for i in range(len(seps) - 1)]))
            x += 1
    return out

def find(boxes, x, y, tol=12):
    for b in boxes:
        if abs(b[0] - x) <= tol and abs(b[1] - y) <= tol: return b
    raise SystemExit(f'box not found at {x},{y}')

def field(name, b, typ='Decimal', align='RightJustified', decimals=0):
    return {'name': name, 'type': typ, 'rect': [b[0], b[1], b[2], b[3]], 'cells': b[4], 'align': align, 'decimals': decimals, 'readOnly': False}

def line(name, t):
    y, s, e, cells = t
    return {'name': name, 'type': 'Text', 'rect': [s, y - 50, e, y], 'cells': cells, 'align': 'LeftJustified', 'readOnly': False}

def main():
    src, out = sys.argv[1], sys.argv[2]
    tmp = tempfile.mkdtemp()
    subprocess.run(['pdftoppm', '-r', '300', '-png', '-f', '1', '-l', '2', src, os.path.join(tmp, 'p')], check=True)
    p1, p2 = os.path.join(tmp, 'p-1.png'), os.path.join(tmp, 'p-2.png')
    b1, t1 = combs(p1), ticks(p1)
    lines1 = sorted(t1)
    sam = [line('InsurerName', lines1[0]), line('InsurerAddress', lines1[1]), line('ManagerFullName', lines1[2]), line('PreparatorDetails', lines1[3]),
           field('InsurerCode', find(b1, 950, 413), align='LeftJustified'), field('JuridicalPersonCode', find(b1, 1374, 413), align='LeftJustified'),
           field('InsurerPhone', find(b1, 1891, 413), typ='Text', align='LeftJustified'), field('DocDate', find(b1, 1080, 791), typ='Date', align='LeftJustified'),
           field('CycleYear', find(b1, 1848, 945)), field('CycleMonth', find(b1, 2190, 945)), field('RevisedCycleYear', find(b1, 2485, 1051)), field('RevisedCycleMonth', find(b1, 2828, 1051)),
           field('Apdx2PageCount', find(b1, 1092, 1382)), field('Apdx2PersonCount', find(b1, 1422, 1382)), field('Apdx2InsIncomeSum', find(b1, 1777, 1382), decimals=2), field('Apdx2PaymentSum', find(b1, 2462, 1382), decimals=2),
           field('Apdx3PageCount', find(b1, 1092, 1488)), field('Apdx3PersonCount', find(b1, 1422, 1488)), field('Apdx3InsIncomeSum', find(b1, 1777, 1488), decimals=2), field('Apdx3PaymentSum', find(b1, 2462, 1488), decimals=2),
           field('ApdxPageCountTotal', find(b1, 1092, 1595))]
    for name, (x, y) in [('RevisedDocument', (2835, 958)), ('Appendixes2', (555, 1384)), ('Appendixes3', (555, 1489))]:
        b = find(b1, x, y); sam.append({'name': name, 'type': 'Checkmark', 'rect': [b[0], b[1], b[2], b[3]], 'readOnly': False})
    b2, t2 = combs(p2), sorted(ticks(p2))
    sd = [field('InsurerCode', find(b2, 442, 117), align='LeftJustified'), field('PageNumber', find(b2, 1540, 117)), field('PageTotal', find(b2, 1788, 117)),
          field('DocDate', find(b2, 2049, 235), typ='Date', align='LeftJustified'), field('InsIncomePage', find(b2, 2253, 2125), decimals=2), field('PaymentPage', find(b2, 2855, 2125), decimals=2)]
    tops = sorted({b[1] for b in b2 if abs(b[0] - 182) <= 3 and b[4]})
    for i, y in enumerate(tops[:6], 1):
        sd += [field(f'RowNumber_{i}', find(b2, 182, y)), field(f'PersonCode_{i}', find(b2, 489, y), align='LeftJustified'), field(f'InsuranceSeries_{i}', find(b2, 1092, y), typ='Text', align='LeftJustified'),
               field(f'InsuranceNumber_{i}', find(b2, 1222, y), align='LeftJustified'), field(f'InsIncomeSum_{i}', find(b2, 1918, y), decimals=2), field(f'TaxRate_{i}', find(b2, 2521, y), decimals=2),
               field(f'PaymentSum_{i}', find(b2, 2851, y), decimals=2), line(f'PersonFirstName_{i}', t2[2 * i - 2]), line(f'PersonLastName_{i}', t2[2 * i - 1])]
    page = {'width': 3508, 'height': 2480}
    for name, fields in [('SAM', sam), ('SAM3SD', sd)]:
        json.dump({'source': os.path.basename(src), 'formDefId': '{963BF380-47C3-4B69-A7F7-1B4593572CFE}', 'formCode': name, 'pageName': name, 'group': 'Forma', 'page': page, 'fields': fields},
                  open(os.path.join(out, f'{name.lower()}-v07.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(name, len(fields), 'fields')
    shutil.copy(src, os.path.join(out, 'sam-v07.pdf'))

main()
