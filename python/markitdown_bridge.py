#!/usr/bin/env python3
"""One conversion per isolated process. stdin contains authorized bytes, never a source path.

Protocol v1: prepare JSON, exact source bytes, convert JSON; ready JSON, release JSON,
exact body bytes, exact mapping NDJSON bytes. stdout is reserved for this protocol.
"""
from __future__ import annotations
import contextlib
import csv
import hashlib
import html
import importlib.metadata
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import re
import shutil
import sys
import tempfile
import uuid
import warnings
import zipfile
from xml.etree import ElementTree as ET

PROTOCOL = 1
BASELINE = "pypi:markitdown==0.1.7;markitdown-ocr==0.1.0"
MAX_FRAME = 65536
MIB = 1024 * 1024


class BridgeError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def frame(stream):
    data = stream.readline(MAX_FRAME + 1)
    if len(data) > MAX_FRAME or not data.endswith(b"\n"):
        raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "协议帧长度错误。")
    obj = json.loads(data)
    if not isinstance(obj, dict):
        raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "协议帧必须为对象。")
    return obj


def send(stream, obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
    if len(data) > MAX_FRAME:
        raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "元数据帧超限。")
    stream.write(data)
    stream.flush()


def doctor():
    for package, expected in (("markitdown", "0.1.7"), ("markitdown-ocr", "0.1.0")):
        if importlib.metadata.version(package) != expected:
            raise BridgeError("MARKITDOWN_INCOMPATIBLE", "MarkItDown 版本不符合固定基线，请运行安装脚本。")
    # Verify the installed converter code against the published distributions.
    checks = json.loads(Path(__file__).with_name("upstream-hashes.json").read_text())
    import markitdown
    import markitdown_ocr
    for module, name in ((markitdown, "markitdown"), (markitdown_ocr, "markitdown_ocr")):
        root = Path(module.__file__).parent
        for rel, digest in checks[name].items():
            if hashlib.sha256((root / rel).read_bytes().replace(b"\r\n", b"\n")).hexdigest() != digest:
                raise BridgeError("MARKITDOWN_INCOMPATIBLE", "依赖源码与已验证的发布包不一致，请重建固定环境。")
    import openai  # noqa: F401 -- doctor verifies vision dependencies before conversion
    import pypdf  # noqa: F401
    return {"protocol": PROTOCOL, "baseline": BASELINE, "executable": sys.executable, "python": list(sys.version_info[:3])}


class Writer:
    def __init__(self, options, temp):
        self.options = options
        self.body = tempfile.SpooledTemporaryFile(max_size=options["memoryBytes"], dir=temp)
        self.mapping = tempfile.SpooledTemporaryFile(max_size=options["memoryBytes"], dir=temp)
        self.pos = 0
        self.line = 1
        self.records = 0
        self.warnings = []
        self.partial = False
        self.unknown = False
        self.tokens = {}
        self.scope = "block"
        self.excluded = set()
        self.block = 0
        self.heading = []
        self.assets = {}
        self.images = []

    def warn(self, message, gap=True):
        self.partial |= gap
        if message not in self.warnings and len(self.warnings) < 24:
            self.warnings.append(message[:400])

    def token(self, value):
        token = "DRTOKEN" + uuid.uuid4().hex.upper()
        self.tokens[token] = value
        return token

    def append(self, text, location, scope, source="native"):
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if not text:
            return
        data = text.encode("utf-8")
        start, line = self.pos, self.line
        self.body.write(data)
        self.pos += len(data)
        self.line += text.count("\n")
        # Bound location metadata separately from potentially long document text.
        loc = dict(location)
        if "heading" in loc:
            loc["heading"] = [x[:160] for x in loc["heading"][-6:]]
        record = {"start": start, "end": self.pos, "startLine": line,
                  "endLine": self.line, "scope": scope, "location": loc, "source": source}
        raw = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        if len(raw) > MAX_FRAME or self.records >= self.options["maxMapRecords"]:
            raise BridgeError("DOCUMENT_LIMIT_EXCEEDED", "位置映射超限，请调整 conversion.maxMapRecords。")
        self.mapping.write(raw)
        self.records += 1
        if self.pos + self.mapping.tell() > self.options["maxResultBytes"]:
            raise BridgeError("DOCUMENT_LIMIT_EXCEEDED", "转换结果与位置映射超过硬上限。")
        if source not in ("native", "ocr_transcript", "metadata"):
            self.excluded.add(source)

    def fragment(self, text, location, scope):
        # Only unpredictable markers inserted by this invocation change source labels.
        parts = re.split(r"(DRTOKEN[A-F0-9]{32})", text)
        for part in parts:
            if part in self.tokens:
                for source, content in self.tokens[part]:
                    if source == "deferred_image":
                        image_id = "image:" + str(len(self.images) + 1)
                        self.images.append({"id": image_id, "hash": content, "scope": scope,
                                            "location": dict(location), "line": self.line})
                        self.append("[图片 " + image_id + "：图片内容单独读取]", location, scope, "metadata")
                        continue
                    self.append("\n[图像" + ("转录" if source == "ocr_transcript" else "分析") + "]\n", location, scope, "metadata")
                    self.append(content, location, scope, source)
                    self.append("\n", location, scope, "metadata")
            else:
                self.append(part, location, scope)

    def markdown(self, text, location, scope, blocks=False):
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        # Markdown paragraphs and table records define Word search blocks.
        pieces = re.split(r"(\n\s*\n)", text)
        for piece in pieces:
            if not piece:
                continue
            rows = piece.splitlines(keepends=True) if piece.lstrip().startswith("|") else [piece]
            for row in rows:
                loc = dict(location)
                if blocks:
                    self.block += 1
                    scope = "block:" + str(self.block)
                    loc.update(block=scope, heading=list(self.heading))
                    heading = re.match(r"^(#{1,6})\s+(.+)", row)
                    if heading:
                        level = len(heading[1])
                        self.heading = self.heading[:level - 1] + [heading[2][:160]]
                        loc["heading"] = list(self.heading)
                # Cell separators are metadata, so a phrase cannot span cells.
                if row.lstrip().startswith("|"):
                    cells = re.split(r"(?<!\\)(\|)", row)
                    for cell in cells:
                        if cell == "|":
                            self.append(cell, loc, scope, "metadata")
                        else:
                            self.fragment(cell, loc, scope)
                else:
                    self.fragment(row, loc, scope)

    def close(self):
        self.body.close()
        self.mapping.close()


class Vision:
    def __init__(self, config, writer, visual_request=None):
        self.visual_request = visual_request
        self.config, self.writer = config, writer
        self.calls = self.success = 0
        self.vision_used = self.ocr_used = False
        self.enabled = config["vision"] or config["ocr"]
        self.service = None
        self.client = None
        if self.enabled and not config.get("deferred") and config.get("source") != "dsh":
            import httpx
            from openai import OpenAI
            from markitdown_ocr._ocr_service import LLMVisionOCRService
            # An explicit endpoint is the only permitted network destination.
            self.client = OpenAI(base_url=config["baseURL"], api_key=os.environ["DOCUMENT_READER_VISION_KEY"],
                                 timeout=config["requestTimeoutMs"] / 1000, max_retries=0,
                                 http_client=httpx.Client(follow_redirects=False, trust_env=False))
            self.service = LLMVisionOCRService(self.client, config["model"], config["prompt"])

    def analyze(self, stream, info=None):
        if self.config.get("deferred"):
            directory = Path(self.writer.options["deferredDir"])
            stream.seek(0)
            digest = hashlib.sha256()
            # Spool large images rather than creating a full in-memory copy.
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as out:
                name = Path(out.name)
                total = 0
                while True:
                    chunk = stream.read(65536)
                    if not chunk: break
                    total += len(chunk)
                    if total > self.writer.options["maxArchiveBytes"]:
                        raise BridgeError("DOCUMENT_LIMIT_EXCEEDED", "内嵌图片过大。")
                    digest.update(chunk); out.write(chunk)
            key = digest.hexdigest()
            target = directory / (key + ".image")
            if target.exists(): name.unlink()
            else: name.replace(target)
            self.writer.assets[key] = total
            return [("deferred_image", key)]
        if not self.enabled:
            self.writer.warn("存在未分析的图片；视觉/OCR 已关闭。")
            return [("metadata", "[图片未分析]")]
        if self.calls >= self.config["maxCallsPerDocument"]:
            self.writer.warn("已达到单文档图像调用上限，剩余图片未分析。")
            return [("metadata", "[图像调用上限]")]
        retries = 0 if self.config.get("source") == "dsh" else self.config["maxRetries"]
        for attempt in range(retries + 1):
            if self.calls >= self.config["maxCallsPerDocument"]:
                break
            self.calls += 1
            if self.config.get("source") == "dsh":
                if self.visual_request is None:
                    raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "未提供 DSH 图片调用通道。")
                result = self.visual_request(stream, self.calls)
            else:
                stream.seek(0)
                result = self.service.extract_text(stream, stream_info=info)
            if not result.error:
                break
        if result.error or not result.text.strip():
            self.writer.warn("图像识别失败或返回空内容；请检查视觉模型配置。" + (" 原因：" + result.code if getattr(result, "code", None) else ""))
            return [("metadata", "[图片读取失败]")]
        self.success += 1
        text = result.text.strip()
        # Require a machine-checked separation; malformed model prose remains mixed.
        try:
            obj = json.loads(text)
            if not isinstance(obj, dict) or set(obj) != {"transcript", "description"} or not all(isinstance(x, str) for x in obj.values()):
                raise ValueError("invalid fields")
            chunks = []
            if self.config["ocr"] and obj["transcript"]:
                chunks.append(("ocr_transcript", obj["transcript"]))
                self.ocr_used = True
            if self.config["vision"] and obj["description"]:
                chunks.append(("generated_description", obj["description"]))
                self.vision_used = True
            if not chunks:
                self.writer.warn("图像响应无所请求的转录/说明字段内容。")
                return [("metadata", "[图像无可用文字]")]
            return chunks
        except (ValueError, TypeError):
            self.writer.warn("图像响应未按转录/说明结构返回；保留为混合分析，默认搜索不包含它。")
            self.vision_used |= self.config["vision"]
            return [("mixed_or_unknown", text)]

    def close(self):
        if self.client:
            self.client.close()


def engine(converter):
    from markitdown import MarkItDown
    md = MarkItDown(enable_builtins=False, enable_plugins=False)
    md.register_converter(converter)
    return md


def convert_with(converter, source, extension):
    from markitdown import StreamInfo
    source.seek(0)
    if isinstance(source, io.BufferedIOBase):
        return engine(converter).convert_stream(source, stream_info=StreamInfo(extension="." + extension)).markdown
    buffered = io.BufferedReader(source)
    try:
        return engine(converter).convert_stream(buffered, stream_info=StreamInfo(extension="." + extension)).markdown
    finally:
        buffered.detach()


def checked_ooxml(source, fmt, options, writer):
    """Reject active external resources and bound expansion before invoking parsers."""
    source.seek(0)
    archive = zipfile.ZipFile(source)
    items = archive.infolist()
    if len(items) > options["maxArchiveEntries"] or sum(i.file_size for i in items) > options["maxArchiveBytes"]:
        archive.close()
        raise BridgeError("DOCUMENT_LIMIT_EXCEEDED", "Office 容器展开大小或条目数超过上限。")
    names = set(archive.namelist())
    required = {"docx": "word/document.xml", "pptx": "ppt/presentation.xml", "xlsx": "xl/workbook.xml"}[fmt]
    if required not in names or "[Content_Types].xml" not in names:
        archive.close()
        raise BridgeError("DOCUMENT_UNSUPPORTED_FORMAT", "扩展名与 Office 容器类型不一致。")
    from defusedxml.ElementTree import fromstring
    for name in names:
        if name.endswith(".rels"):
            root = fromstring(archive.read(name))
            for rel in root:
                if rel.get("TargetMode") == "External" and not rel.get("Type", "").endswith("/hyperlink"):
                    archive.close()
                    raise BridgeError("DOCUMENT_EXTERNAL_RESOURCE", "文档包含外部图片或资源关系；请嵌入资源后读取。")
    patterns = {"docx": ("word/header", "word/footer", "word/comments", "word/footnotes", "word/endnotes", "word/embeddings"),
                "pptx": ("ppt/diagrams", "ppt/embeddings"), "xlsx": ("xl/comments", "xl/charts", "xl/embeddings")}
    if any(name.startswith(patterns[fmt]) for name in names):
        writer.warn("存在页眉页脚、批注、脚注或复杂嵌入对象；当前转换不保证完整覆盖。")
    if fmt == "docx" and re.search(rb"<w:(?:ins|del)[\s>]", archive.read(required)):
        writer.warn("文档包含修订记录；仅以转换结果为准，不保证保留全部修订。")
    return archive


def patched_zip(archive, changes, temp, memory):
    out = tempfile.SpooledTemporaryFile(max_size=memory, dir=temp)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for info in archive.infolist():
            target.writestr(info, changes.get(info.filename, archive.read(info.filename)))
    out.seek(0)
    return out


def pdf(source, w, v):
    from pypdf import PdfReader, PdfWriter
    from markitdown.converters import PdfConverter
    from markitdown_ocr._pdf_converter_with_ocr import _extract_images_from_page
    import pdfplumber
    source.seek(0)
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise BridgeError("DOCUMENT_ENCRYPTED", "不支持加密 PDF，请提供已解密文件。")
    source.seek(0)
    with pdfplumber.open(source) as rendered:
        for n, page in enumerate(reader.pages, 1):
            loc, scope = {"kind": "page", "page": n}, "page:" + str(n)
            w.append(f"## Page {n}\n\n", loc, scope, "metadata")
            with io.BytesIO() as one:
                split = PdfWriter()
                split.add_page(page)
                split.write(one)
                text = convert_with(PdfConverter(), one, "pdf")
            w.markdown(text + "\n\n", loc, scope)
            p = rendered.pages[n - 1]
            if p.images:
                if not v.enabled:
                    w.warn("PDF 存在未分析的图片；视觉/OCR 已关闭。")
                else:
                    images = _extract_images_from_page(p)
                    if len(images) < len(p.images):
                        w.warn(f"PDF 第 {n} 页存在未提取到的图片。")
                    for image in images:
                        with image["stream"] as image_stream:
                            for kind, value in v.analyze(image_stream):
                                w.append("\n[图像分析]\n", loc, scope, "metadata")
                                w.append(value + "\n", loc, scope, kind)
                    if not images and not text.strip():
                        full_page(p, n, w, v, loc, scope)
            elif not text.strip():
                full_page(p, n, w, v, loc, scope)
            if p.curves or p.lines:
                w.unknown = True
            p.close()
    w.scope = "page"


def full_page(page, n, w, v, loc, scope):
    # Check content, not the synthetic page heading, before triggering OCR.
    try:
        image = page.to_image(resolution=w.options["pdfDpi"]).original.convert("RGB")
        extrema = image.getextrema()
        if all(low == high and low >= 250 for low, high in extrema):
            return  # A genuinely blank page still retains its physical page number.
        with io.BytesIO() as stream:
            image.save(stream, format="PNG")
            stream.seek(0)
            for kind, value in v.analyze(stream):
                w.append(value + "\n", loc, scope, kind)
    except Exception:
        w.warn(f"PDF 第 {n} 页渲染失败，不能保证扫描内容完整。")


def stable_adapter():
    import importlib.util
    spec = importlib.util.spec_from_file_location("document_reader_stable_compat", Path(__file__).with_name("stable_compat.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def office(source, fmt, w, v, temp):
    from defusedxml.ElementTree import fromstring
    converter = stable_adapter().office_converter(fmt, v)
    with checked_ooxml(source, fmt, w.options, w) as archive:
        if fmt == "docx":
            text = convert_with(converter, source, fmt)
            w.markdown(text, {"kind": "block"}, "block:0", blocks=True)
            w.scope = "block"
            return
        changes, markers = {}, []
        if fmt == "xlsx":
            root = fromstring(archive.read("xl/workbook.xml"))
            for n, sheet in enumerate(root.findall("{*}sheets/{*}sheet"), 1):
                marker = "DRS" + uuid.uuid4().hex[:24]
                loc = {"kind": "sheet", "sheet": sheet.attrib["name"], "hidden": sheet.get("state", "visible") != "visible"}
                markers.append((marker, None, loc, "sheet:" + str(n)))
                sheet.set("name", marker)
            changes["xl/workbook.xml"] = ET.tostring(root)
        else:
            # Inject unique text markers into existing OOXML; native converter still owns shapes/tables/charts.
            ns_p = "http://schemas.openxmlformats.org/presentationml/2006/main"
            ns_a = "http://schemas.openxmlformats.org/drawingml/2006/main"
            ns_r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            rels = {r.get("Id"): r.get("Target") for r in fromstring(archive.read("ppt/_rels/presentation.xml.rels"))}
            root = fromstring(archive.read("ppt/presentation.xml"))
            for n, slide in enumerate(root.findall("{*}sldIdLst/{*}sldId"), 1):
                import posixpath
                target = rels[slide.get("{" + ns_r + "}id")]
                name = target.lstrip("/") if target.startswith("/") else posixpath.normpath("ppt/" + target)
                xml = fromstring(archive.read(name))
                loc = {"kind": "slide", "slide": n, "part": "body", "hidden": xml.get("show", "1") == "0"}
                marker = "DRSLIDE" + uuid.uuid4().hex.upper()
                end_marker = "DREND" + uuid.uuid4().hex.upper()
                markers.append((marker, end_marker, loc, "slide:" + str(n)))
                shape = ET.fromstring(f'<p:sp xmlns:p="{ns_p}" xmlns:a="{ns_a}"><p:nvSpPr><p:cNvPr id="2147483000" name="reader-marker"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="-2147480000" y="-2147480000"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{marker}</a:t></a:r></a:p></p:txBody></p:sp>')
                tree = xml.find("{*}cSld/{*}spTree")
                # Missing coordinates sort as -infinity in the pinned native converter.
                # Insert the start marker before any user shape with missing coordinates.
                import copy
                ending = copy.deepcopy(shape)
                ending.find(".//{*}cNvPr").set("id", "2147483001")
                ending.find(".//{*}off").set("x", "9223372036854775807")
                ending.find(".//{*}off").set("y", "9223372036854775807")
                ending.find(".//{*}t").text = end_marker
                shape.find("{*}spPr").remove(shape.find("{*}spPr/{*}xfrm"))
                tree.insert(2, shape)
                tree.append(ending)
                changes[name] = ET.tostring(xml)
                relname = posixpath.dirname(name) + "/_rels/" + posixpath.basename(name) + ".rels"
                if relname in archive.namelist():
                    for rel in fromstring(archive.read(relname)):
                        if rel.get("Type", "").endswith("/notesSlide"):
                            note_name = posixpath.normpath(posixpath.dirname(name) + "/" + rel.get("Target"))
                            note = fromstring(archive.read(note_name))
                            for sp in note.findall(".//{*}sp"):
                                ph = sp.find(".//{*}ph")
                                if ph is not None and ph.get("type") == "body":
                                    tb = sp.find("{*}txBody")
                                    token = "DRNOTE" + uuid.uuid4().hex.upper()
                                    note_end = "DRNOTEEND" + uuid.uuid4().hex.upper()
                                    markers.append((token, note_end, {**loc, "part": "notes"}, "slide:" + str(n)))
                                    para = ET.fromstring(f'<a:p xmlns:a="{ns_a}"><a:r><a:t>{token}</a:t></a:r></a:p>')
                                    tb.insert(2, para)
                                    end_para = copy.deepcopy(para)
                                    end_para.find(".//{*}t").text = note_end
                                    tb.append(end_para)
                            changes[note_name] = ET.tostring(note)
            w.unknown = True  # Native vectors/SmartArt are not a complete visual rendering.
        with patched_zip(archive, changes, temp, w.options["memoryBytes"]) as modified:
            text = convert_with(converter, modified, fmt)
        positions = sorted((text.find(marker), marker, ending, loc, scope) for marker, ending, loc, scope in markers)
        if any(pos < 0 for pos, *_ in positions):
            raise BridgeError("DOCUMENT_LOCATION_UNAVAILABLE", "转换器未保留定位标记，拒绝返回错误页码。")
        for index, (pos, marker, ending, loc, scope) in enumerate(positions):
            if ending:
                end = text.find(ending, pos + len(marker))
                if end < 0:
                    raise BridgeError("DOCUMENT_LOCATION_UNAVAILABLE", "转换器未保留结束定位标记。")
            else:
                # The unique next sheet name is always emitted by the native converter as '## NAME'.
                end = positions[index + 1][0] - 3 if index + 1 < len(positions) else len(text)
            chunk = text[pos + len(marker):end]
            if fmt == "pptx":
                title = f"## Slide {loc['slide']}" + (" Notes" if loc["part"] == "notes" else "")
            else:
                title = "## " + loc["sheet"]
            w.append(title + "\n", loc, scope, "metadata")
            w.markdown(chunk.strip() + "\n\n", loc, scope)
        w.scope = "slide" if fmt == "pptx" else "sheet"


def xls(source, w):
    # Capture official converter's individual HTML results; never guess sheet boundaries from user headings.
    import xlrd
    from markitdown.converters import XlsConverter
    source.seek(0)
    book = xlrd.open_workbook(file_contents=source.read(), on_demand=True)
    sheets = [(sheet.name, bool(sheet.visibility)) for sheet in book.sheets()]
    book.release_resources()
    converter = XlsConverter()
    original = converter._html_converter
    outputs = []
    class Capture:
        def convert_string(self, text, **kwargs):
            result = original.convert_string(text, **kwargs)
            outputs.append(result.markdown)
            return result
    converter._html_converter = Capture()
    convert_with(converter, source, "xls")
    if len(outputs) != len(sheets):
        raise BridgeError("DOCUMENT_LOCATION_UNAVAILABLE", "工作表映射不一致。")
    for n, ((name, hidden), text) in enumerate(zip(sheets, outputs), 1):
        loc, scope = {"kind": "sheet", "sheet": name, "hidden": hidden}, "sheet:" + str(n)
        w.append("## " + name + "\n", loc, scope, "metadata")
        w.markdown(text + "\n\n", loc, scope)
    w.scope = "sheet"
    w.unknown = True
    w.warn("XLS 图片、批注及图表不在转换覆盖范围内。", gap=False)


def csv_document(source, w):
    from charset_normalizer import from_bytes
    escape_table_cell = stable_adapter().escape_table_cell
    source.seek(0)
    detected = from_bytes(source.read()).best()
    if detected is None:
        raise BridgeError("DOCUMENT_ENCODING_INVALID", "无法可靠识别 CSV 编码。")
    csv.field_size_limit(w.options["maxResultBytes"])
    for n, row in enumerate(csv.reader(io.StringIO(str(detected).lstrip("\ufeff"), newline="")), 1):
        loc, scope = {"kind": "record", "record": n}, "record:" + str(n)
        w.append("|", loc, scope, "metadata")
        for cell in row:
            w.append(" " + escape_table_cell(cell) + " ", loc, scope)
            w.append("|", loc, scope, "metadata")
        w.append("\n", loc, scope, "metadata")
    w.scope = "record"


def convert(source, request, temp, visual_request=None):
    w = Writer(request["options"], temp)
    v = Vision(request["visual"], w, visual_request)
    fmt = request["format"]
    try:
        source.seek(0)
        magic = source.read(8)
        source.seek(0)
        if fmt == "pdf" and not magic.startswith(b"%PDF-"):
            raise BridgeError("DOCUMENT_UNSUPPORTED_FORMAT", "文件不是有效 PDF。")
        if fmt == "xls" and magic != bytes.fromhex("D0CF11E0A1B11AE1"):
            raise BridgeError("DOCUMENT_UNSUPPORTED_FORMAT", "文件不是有效 XLS。")
        if fmt == "pdf": pdf(source, w, v)
        elif fmt in ("docx", "pptx", "xlsx"): office(source, fmt, w, v, temp)
        elif fmt == "xls": xls(source, w)
        elif fmt == "csv": csv_document(source, w)
        elif fmt in ("png", "jpg", "jpeg"):
            from PIL import Image
            image = Image.open(source)
            expected = "PNG" if fmt == "png" else "JPEG"
            if image.format != expected:
                raise BridgeError("DOCUMENT_UNSUPPORTED_FORMAT", "图片扩展名与实际格式不一致。")
            source.seek(0)
            for kind, content in v.analyze(source):
                w.append(content, {"kind": "image"}, "image:1", kind)
            w.scope = "image"
        else:
            raise BridgeError("DOCUMENT_UNSUPPORTED_FORMAT", "格式不受支持。")
        if request["options"].get("deferredDir"):
            manifest = {"images": w.images, "assets": w.assets}
            Path(request["options"]["deferredDir"], "images.json").write_text(
                json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        meta = {"protocol": PROTOCOL, "ok": True, "bodyBytes": w.pos, "mapBytes": w.mapping.tell(),
                "records": w.records, "totalLines": w.line if w.pos else 0, "scope": w.scope,
                "visionUsed": v.vision_used, "ocrUsed": v.ocr_used, "partial": w.partial,
                "warnings": w.warnings, "extraction_coverage": "known_gaps" if w.partial else "unknown" if w.unknown else "no_known_gaps",
                "excluded_content": sorted(w.excluded)}
        return w, meta
    except BaseException:
        w.close()
        raise
    finally:
        v.close()


def main():
    wire_out, wire_in = sys.stdout.buffer, sys.stdin.buffer
    if "--doctor" in sys.argv:
        with contextlib.redirect_stdout(open(os.devnull, "w")):
            result = doctor()
        send(wire_out, result)
        return
    request = frame(wire_in)
    if request.get("protocol") != PROTOCOL:
        raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "协议版本不兼容。")
    size = request.get("sourceBytes")
    if not isinstance(size, int) or size < 0 or size > request["options"]["maxSourceBytes"]:
        raise BridgeError("DOCUMENT_LIMIT_EXCEEDED", "源文件大小超过限制。")
    with contextlib.redirect_stdout(open(os.devnull, "w")), warnings.catch_warnings():
        warnings.simplefilter("ignore")  # upstream warnings may embed endpoint or exception bodies
        doctor()
        # Parent owns this directory and removes it only after this process exits.
        temp = os.environ["DOCUMENT_READER_TEMP"]
        with tempfile.SpooledTemporaryFile(max_size=request["options"]["memoryBytes"], dir=temp) as source:
            remaining = size
            while remaining:
                chunk = wire_in.read(min(65536, remaining))
                if not chunk:
                    raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "源文件字节不足。")
                source.write(chunk)
                remaining -= len(chunk)
            if frame(wire_in).get("action") != "convert":
                raise BridgeError("DOCUMENT_CANCELLED", "源文件版本复核未通过。")
            def visual_request(image_stream, request_id):
                from PIL import Image
                image_stream.seek(0)
                data = image_stream.read(request["visual"]["maxImageBytes"] + 1)
                if not data or len(data) > request["visual"]["maxImageBytes"]:
                    return SimpleNamespace(error=True, text="", code="IMAGE_TOO_LARGE")
                try:
                    image = Image.open(io.BytesIO(data))
                    media_type = Image.MIME.get(image.format)
                    if media_type not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
                        return SimpleNamespace(error=True, text="", code="IMAGE_TYPE_UNSUPPORTED")
                except Exception:
                    return SimpleNamespace(error=True, text="", code="IMAGE_INVALID")
                # IDs count sent requests, not locally rejected images.
                visual_request.serial += 1
                serial = visual_request.serial
                send(wire_out, {"kind": "vision", "id": serial, "bytes": len(data), "mediaType": media_type})
                wire_out.write(data)
                wire_out.flush()
                response = frame(wire_in)
                count = response.get("textBytes")
                if response.get("action") != "vision-result" or response.get("id") != serial or type(count) is not int or not 0 <= count <= request["visual"]["maxResponseBytes"]:
                    raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "DSH 图片返回协议无效。")
                text = wire_in.read(count)
                if len(text) != count:
                    raise BridgeError("DOCUMENT_PROTOCOL_INVALID", "DSH 图片返回意外结束。")
                return SimpleNamespace(error=not response.get("ok"), text=text.decode("utf-8"), code=response.get("code"))
            visual_request.serial = 0
            w, meta = convert(source, request, temp, visual_request)
            try:
                send(wire_out, meta)
                if frame(wire_in).get("action") != "release":
                    raise BridgeError("DOCUMENT_CANCELLED", "转换结果未获接收许可。")
                for stream in (w.body, w.mapping):
                    stream.seek(0)
                    shutil.copyfileobj(stream, wire_out, 65536)
                wire_out.flush()
            finally:
                w.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        if isinstance(exc, BridgeError):
            code, message = exc.code, exc.message
        elif isinstance(exc, (ImportError, importlib.metadata.PackageNotFoundError)):
            code, message = "MARKITDOWN_MISSING", "Python 依赖不完整，请运行安装脚本。"
        else:
            code, message = "DOCUMENT_CONVERSION_FAILED", "文档转换失败，请检查格式、文件完整性和依赖基线。"
        # Never serialize raw upstream exceptions or tracebacks.
        send(sys.stdout.buffer, {"protocol": PROTOCOL, "ok": False, "code": code, "message": message})
        sys.exit(1)
