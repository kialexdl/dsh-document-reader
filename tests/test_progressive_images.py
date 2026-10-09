import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prepare_image',ROOT/'python/prepare_image.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ProgressiveImageTests(unittest.TestCase):
    def test_lossless_tiles_cover_entire_image_with_overlap(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory,'source.png')
            image=Image.new('RGB',(2500,2100),'white')
            image.putpixel((2499,2099),(12,34,56));image.save(source)
            opts=dict(source=str(source),directory=directory,maxImagePixels=10000000,tilePixels=1800,tileOverlap=96,maxTiles=64,maxBytes=20*1024*1024)
            result=module.prepare(opts)
            self.assertEqual(len(result['tiles']),4)
            self.assertIn('warning',result)
            last=Image.open(Path(directory,result['tiles'][-1]))
            self.assertEqual(last.size,(1800,1800))
            self.assertEqual(last.getpixel((1799,1799)),(12,34,56))
            self.assertEqual(module.prepare(opts)['tiles'],result['tiles'])
    def test_tile_and_pixel_limits_fail_without_downsampling(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory,'source.png');Image.new('RGB',(3000,3000),'black').save(source)
            opts=dict(source=str(source),directory=directory,maxImagePixels=10000000,tilePixels=800,tileOverlap=96,maxTiles=2,maxBytes=20*1024*1024)
            with self.assertRaises(ValueError):module.prepare(opts)
            opts['maxTiles']=64;opts['maxImagePixels']=1000000
            with self.assertRaises(Exception):module.prepare(opts)
