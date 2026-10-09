#!/usr/bin/env python3
"""Lossless, bounded raster tiles. Only plugin-owned cached paths enter this worker."""
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import warnings


def prepare(options):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = options['maxImagePixels']
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    with Image.open(options['source']) as original:
        if original.width * original.height > options['maxImagePixels']:
            raise ValueError('pixel limit')
        image = ImageOps.exif_transpose(original).convert('RGB')
        edge = options['tilePixels']; overlap = options['tileOverlap']
        def starts(size):
            values = list(range(0, max(1, size-edge+1), edge-overlap))
            if values[-1]+edge < size: values.append(size-edge)
            return values
        xs, ys = starts(image.width), starts(image.height)
        if len(xs)*len(ys) > options['maxTiles']:
            raise ValueError('tile limit')
        tiles = []
        output_bytes = 0
        for y in ys:
            for x in xs:
                crop = image.crop((x,y,min(x+edge,image.width),min(y+edge,image.height)))
                out = io.BytesIO(); crop.save(out, format='PNG')
                data = out.getvalue()
                output_bytes += len(data)
                if output_bytes > options.get('maxOutputBytes', 512*1024*1024): raise ValueError('tile output limit')
                if len(data) > options['maxBytes']: raise ValueError('byte limit')
                name = hashlib.sha256(data).hexdigest()+'.png'
                dest = Path(options['directory'], name)
                if not dest.exists():
                    with dest.open('xb') as f: f.write(data)
                tiles.append(name)
        return {'tiles':tiles, **({'warning':'多切片按从上到下、从左到右拼接；重叠处可能重复，跨切片词句不能保证连续。'} if len(tiles)>1 else {})}

if __name__ == '__main__':
    try:
        result = prepare(json.loads(sys.stdin.readline(65536)))
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print(json.dumps({'tiles':[], 'warning':'图片格式、像素数或切片数量超限，未识别该图片。'}, ensure_ascii=False))
        sys.exit(1)
