"""Independent PDF text/link inspection. Requires pypdf==6.21.3 in the invoking environment."""
import json
from pathlib import Path
import pypdf
from pypdf import PdfReader

root = Path(__file__).resolve().parent.parent / 'evidence/source'
report = {'inspector': f'pypdf {pypdf.__version__}', 'documents': {}}
for name in ['initial', 'human-edited', 'json-updated', 'repaired', 'migrated-report']:
    reader = PdfReader(root / name / 'report.pdf')
    text = '\n'.join(page.extract_text() for page in reader.pages)
    pages = {page.indirect_reference.idnum: index + 1 for index, page in enumerate(reader.pages)}
    links = []
    for index, page in enumerate(reader.pages):
        for reference in page.get('/Annots', []):
            annotation = reference.get_object()
            if annotation.get('/Subtype') != '/Link':
                continue
            destination = annotation.get('/Dest')
            assert destination is not None, 'Expected an internal report link'
            target = pages[destination[0].idnum]
            links.append({'page': index + 1, 'targetPage': target,
                          'target': [float(value) for value in destination[2:]],
                          'rect': [float(value) for value in annotation['/Rect']]})
    assert links, f'No PDF navigation links: {name}'
    report['documents'][name] = {'pages': len(reader.pages), 'text': text, 'links': links}

before = report['documents']['human-edited']['text']
after = report['documents']['json-updated']['text']
assert '营收：120' in before and '增长率：20%' in before
assert '营收：180' in after and '增长率：80%' in after
assert '营收同比增长 20%' in after, 'JSON updates must not rewrite analysis prose'
assert '跟随模板：图 1。 不附题注：图 1。 编号与题注：图 1 「' in after
assert '计算公式见 式 2' in after
assert '品牌见 图 2' in after and '本图见 图 1' in after
actual = report['documents']['migrated-report']['text']
assert '62.5%' in actual and '37.5%' in actual and '营收趋势见 图 1' in actual
(root / 'pdf-inspection.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print({name: {'pages': value['pages'], 'links': len(value['links'])}
       for name, value in report['documents'].items()})
