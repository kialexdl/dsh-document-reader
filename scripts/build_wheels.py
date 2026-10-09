#!/usr/bin/env python3
"""Prepare a checksummed wheelhouse on the same OS/architecture/Python as the target."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,default=ROOT/'dist'/'wheels')
a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True)
subprocess.run([sys.executable,'-m','pip','wheel','--wheel-dir',str(a.output),'-c',str(ROOT/'python/constraints.lock'),'-r',str(ROOT/'python/requirements.txt')],check=True)
manifest={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(a.output.glob('*.whl'))}
(a.output/'SHA256SUMS.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(a.output.resolve())
