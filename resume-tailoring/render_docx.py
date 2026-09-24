#!/usr/bin/env python3
"""Canonical, content-preserving DOCX renderer for Resume Template V1.0."""
import json
import sys
import zipfile
from html import escape
from pathlib import Path
from xml.etree import ElementTree as ET

STYLE = json.loads((Path(__file__).resolve().parent / 'style-v1.json').read_text())
TITLES = {
    'summary': 'Professional Summary', 'experience': 'Professional Experience',
    'skill': 'Technical Skills', 'project': 'Selected Projects',
    'education': 'Education', 'certification': 'Certifications / Professional Development',
}
NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

def run(value, size=None):
    prop = f'<w:rPr><w:sz w:val="{round(size * 2)}"/></w:rPr>' if size else ''
    return f'<w:r>{prop}<w:t xml:space="preserve">{escape(str(value))}</w:t></w:r>'

def paragraph(value, style, claim_id=None, date=None):
    marker = ''
    if claim_id is not None:
        safe = ''.join(ch if ch.isalnum() or ch == '_' else '_' for ch in str(claim_id))[:38]
        marker = f'<w:bookmarkStart w:id="1" w:name="claim_{safe}"/>'
    content = (run('• ') if style == 'Bullet' else '') + run(value)
    if date:
        content += '<w:r><w:tab/></w:r>' + run(date, STYLE['common']['date_pt'])
    ending = '<w:bookmarkEnd w:id="1"/>' if marker else ''
    return f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr>{marker}{content}{ending}</w:p>'

def content_xml(draft, contact):
    out = [paragraph(contact.get('name') or 'Resume Draft', 'Name')]
    details = ' · '.join(str(contact[k]) for k in ('email', 'phone', 'location', 'linkedin') if contact.get(k))
    if details:
        out.append(paragraph(details, 'Contact'))
    for kind in ['summary', *draft['content']['section_order']]:
        items = draft['content']['sections'].get(kind, [])
        if not items:
            continue
        heading = 'Finance / Systems Skills' if kind == 'skill' and draft['evaluation']['track'] == 'C' else TITLES[kind]
        out.append(paragraph(heading, 'Section'))
        if kind in ('experience', 'project'):
            previous = None
            for item in items:
                key = (item.get('role', ''), item.get('organization', ''), item.get('dates', ''))
                if key != previous:
                    label = ' — '.join(part for part in key[:2] if part) or TITLES[kind]
                    out.append(paragraph(label, 'Entry', date=key[2]))
                    previous = key
                out.append(paragraph(item['text'], 'Bullet', claim_id=item['id']))
        else:
            out.extend(paragraph(item['text'], 'Body', claim_id=item['id']) for item in items)
    return ''.join(out)

def style_xml(name, size, before=0, after=0, line=115, bold=False, indent='', tab='', border=''):
    font = STYLE['font']
    ink = STYLE['common']['ink']
    rpr = f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}"/><w:sz w:val="{round(size * 2)}"/><w:color w:val="{ink}"/>{"<w:b/>" if bold else ""}</w:rPr>'
    ppr = f'<w:pPr><w:spacing w:before="{round(before * 20)}" w:after="{round(after * 20)}" w:line="{round(line * 240 / 100)}" w:lineRule="auto"/>{indent}{tab}{border}</w:pPr>'
    return f'<w:style w:type="paragraph" w:styleId="{name}"><w:name w:val="{name}"/>{ppr}{rpr}</w:style>'

def styles(preset):
    s, c = STYLE[preset], STYLE['common']
    indent = f'<w:ind w:left="{c["bullet_left_twips"]}" w:hanging="{c["bullet_hanging_twips"]}"/>'
    tab = f'<w:tabs><w:tab w:val="right" w:pos="{c["date_tab_twips"]}"/></w:tabs>'
    border = f'<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="{c["rule"]}"/></w:pBdr>'
    defs = [
        style_xml('Normal', s['body_pt'], line=s['line_percent']),
        style_xml('Name', c['name_pt'], after=s['name_after_pt'], bold=True, line=110),
        style_xml('Contact', c['contact_pt'], after=s['contact_after_pt'], line=110),
        style_xml('Section', c['section_pt'], before=s['section_before_pt'], after=s['section_after_pt'], bold=True, border=border),
        style_xml('Entry', c['entry_pt'], before=s['entry_before_pt'], after=s['entry_after_pt'], bold=True, tab=tab),
        style_xml('Bullet', s['body_pt'], after=s['bullet_after_pt'], line=s['line_percent'], indent=indent),
        style_xml('Body', s['body_pt'], after=s['body_after_pt'], line=s['line_percent']),
    ]
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{NS}">{"".join(defs)}</w:styles>'

def write_docx(draft, contact, destination, preset='standard'):
    if preset not in ('standard', 'compact'):
        raise ValueError('preset must be standard or compact')
    page = STYLE['page']
    document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{NS}"><w:body>{content_xml(draft, contact)}<w:sectPr>
<w:pgSz w:w="{page['width_twips']}" w:h="{page['height_twips']}"/>
<w:pgMar w:top="{page['margin_twips']}" w:right="{page['margin_twips']}" w:bottom="{page['margin_twips']}" w:left="{page['margin_twips']}"/>
</w:sectPr></w:body></w:document>'''
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>''')
        archive.writestr('_rels/.rels', '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>''')
        archive.writestr('word/document.xml', document)
        archive.writestr('word/styles.xml', styles(preset))
        archive.writestr('word/_rels/document.xml.rels', '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''')

def inspect_docx(path):
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
        style_root = ET.fromstring(archive.read('word/styles.xml'))
    result = []
    for p in root.findall(f'.//{{{NS}}}body/{{{NS}}}p'):
        parts = []
        for node in p.iter():
            if node.tag == f'{{{NS}}}t':
                parts.append(node.text or '')
            elif node.tag == f'{{{NS}}}tab':
                parts.append('\t')
        marker = p.find(f'{{{NS}}}bookmarkStart')
        result.append({'text': ''.join(parts), 'claim_id': marker.get(f'{{{NS}}}name')[6:] if marker is not None else None})
    return {'paragraphs': result, 'styles': ET.tostring(style_root, encoding='unicode')}

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--inspect':
        print(json.dumps(inspect_docx(sys.argv[2])))
    elif len(sys.argv) in (4, 5):
        write_docx(json.loads(Path(sys.argv[1]).read_text()), json.loads(Path(sys.argv[2]).read_text()), sys.argv[3], sys.argv[4] if len(sys.argv) == 5 else 'standard')
    else:
        raise SystemExit('usage: render_docx.py draft.json contact.json output.docx [standard|compact] | --inspect output.docx')
