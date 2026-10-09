#!/usr/bin/env python3
"""Create source-only or GitHub-ready ZIPs; never bundle downloaded dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--include-built',action='store_true',help='Include lib for direct GitHub URL installation; build first')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
kind='github' if args.include_built else 'source'
output=root/'dist'/f'dsh-document-reader-{version}-{kind}.zip'
output.parent.mkdir(exist_ok=True)
allowed_dirs={'src','python','prompts','scripts','tests','docs','licenses'}
allowed_root={'package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','cordis.patch.yml','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','.gitignore'}
allowed_extensions={'.ts','.tsx','.css','.mjs','.py','.ps1','.sh','.md','.txt','.json','.lock','.yml','.yaml'}
if args.include_built:
    allowed_dirs.add('lib')
    allowed_extensions.update({'.js','.map'})
    for entry in ('lib/index.js','lib/index.d.ts','lib/client.js','lib/client/index.d.ts'):
        if not (root/entry).is_file():parser.error(f'Missing {entry}; run npm run build first')
files=[]
for file in sorted(root.rglob('*')):
    rel=file.relative_to(root)
    if not file.is_file() or file.is_symlink():continue
    if len(rel.parts)==1:
        if file.name not in allowed_root:continue
    elif rel.parts[0] not in allowed_dirs or '__pycache__' in rel.parts or file.suffix not in allowed_extensions:continue
    files.append(file)
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
    for p in files:archive.write(p,'dsh-document-reader/'+p.relative_to(root).as_posix())
    archive.writestr('dsh-document-reader/source-manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    for name in archive.namelist():
        forbidden=('node_modules','.venv','__pycache__','.git') + (() if args.include_built else ('lib',))
        assert not any(part in name.split('/') for part in forbidden)
        assert not name.endswith(('.pyc','.whl','.tgz','.exe','.dll'))
print(json.dumps({'path':str(output),'files':len(files)+1,'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
