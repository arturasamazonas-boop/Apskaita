#!/usr/bin/env python3
"""Extract an EDS form layout from the official VMI .mxfd template (ABBYY eForm).

Usage: python3 scripts/mxfd-layout.py FR0600.mxfd assets/forms/fr0600-v3
Writes <out>.json (FormDefId, page size in template units (300 dpi), every FFData field with its cells)
and <out>.emf (page background). Convert the background once with LibreOffice:
  soffice --headless --convert-to pdf <out>.emf   (vector page used for PDF output)
"""
import binascii, json, re, sys

src, out = sys.argv[1], sys.argv[2]
t = open(src, encoding='utf-8').read()
rect = lambda s: [int(x) for x in re.findall(r'[ltrb]="(-?\d+)"', s)]
form_def = re.search(r'<FormDef [^>]*FormDefId="([^"]+)"', t).group(1)
items = {m.group(2): (m.group(1), m.group(3)) for m in re.finditer(r'<FormItem Type="(\w+)" UID="(0x[0-9A-F]+)">(.*?)</FormItem>', t, flags=re.S)}
fields = []
for m in re.finditer(r'<FieldDataDef FieldName="([^"]+)"[^>]*DataType="(\w+)"[^>]*ReferedXFDItem="([^"]*)">(.*?)</FieldDataDef>', t, flags=re.S):
    name, dtype, ref, body = m.groups()
    f = {'name': name, 'type': dtype}
    r = re.search(r'<Rect [^>]*/>', body)
    if r: f['rect'] = rect(r.group(0))
    if dtype == 'Radiogroup':
        f['items'] = re.findall(r'<RadiogroupItem>([^<]+)</RadiogroupItem>', body)
    al = re.search(r'<HorizontalAlignment>(\w+)</HorizontalAlignment>', body)
    if al: f['align'] = al.group(1)
    dp = re.search(r'<DecimalPlaces>(\d+)</DecimalPlaces>', body)
    if dp: f['decimals'] = int(dp.group(1))
    ro = re.search(r'<IsReadOnly>(\w+)</IsReadOnly>', body)
    f['readOnly'] = bool(ro and ro.group(1) == 'true')
    if ref in items:
        cells = re.search(r'<Cells>(.*?)</Cells>', items[ref][1], flags=re.S)
        if cells: f['cells'] = [rect(c) for c in re.findall(r'<Rect [^>]*/>', cells.group(1))]
        hint = re.search(r'<HintText>.*?<Text>([^<]*)</Text>', items[ref][1], flags=re.S)
        # Decimal fields carry their separator as a hint; only real text is printed on the form.
        if hint and hint.group(1).strip() and hint.group(1).strip() not in ',.': f['printed'] = hint.group(1).strip()
    fields.append(f)
size = re.search(r'<Size><Width>(\d+)</Width><Height>(\d+)</Height></Size>', t)
code = re.search(r'<ListPage>([^<]+)</ListPage>', t).group(1)
group = re.search(r'<Group Name="([^"]+)"', t).group(1)
json.dump({'source': src.split('/')[-1], 'formDefId': form_def, 'formCode': code, 'group': group, 'page': {'width': int(size.group(1)), 'height': int(size.group(2))}, 'fields': fields},
          open(out + '.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
img = re.search(r'<Image ImageSize="\d+" ImageType="EMF">([0-9A-Fa-f\s]+)</Image>', t)
open(out + '.emf', 'wb').write(binascii.unhexlify(re.sub(r'\s', '', img.group(1))))
print(form_def, code, len(fields), 'fields')
