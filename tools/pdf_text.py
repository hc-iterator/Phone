#!/usr/bin/env python3
"""Minimal PDF text extractor, to read a schematic without extra packages.

Only what is needed here: decompress FlateDecode content streams and pull the
text out of Tj / TJ operators. Schematic PDFs are usually just vector drawings
plus short labels, so this recovers pin names even though it handles no fonts
or encodings properly.

Usage: python tools/pdf_text.py <file.pdf> [outfile.txt]
"""

import re
import sys
import zlib


def extract_text(data: bytes) -> str:
    chunks = []

    # Content streams are Flate-compressed; find each "stream ... endstream"
    # that decompresses cleanly and harvest text operators from it.
    for match in re.finditer(rb"stream\r?\n", data):
        start = match.end()
        end = data.find(b"endstream", start)
        if end == -1:
            continue
        raw = data[start:end]
        try:
            text = zlib.decompress(raw)
        except zlib.error:
            continue

        # (literal) Tj  and  [(a) -1 (b)] TJ
        for t in re.finditer(rb"\((?:\\.|[^\\()])*\)", text):
            s = t.group(0)[1:-1]
            s = s.replace(b"\\(", b"(").replace(b"\\)", b")").replace(b"\\\\", b"\\")
            try:
                chunks.append(s.decode("latin-1"))
            except Exception:  # noqa: BLE001
                pass
        chunks.append("\n")

    return "".join(chunks)


def main() -> int:
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    with open(src, "rb") as fh:
        data = fh.read()
    txt = extract_text(data)
    # Collapse runs of whitespace so adjacent labels stay readable.
    txt = re.sub(r"[ \t]+", " ", txt)
    if dst:
        with open(dst, "w", encoding="utf-8") as fh:
            fh.write(txt)
        print(f"wrote {len(txt)} chars to {dst}")
    else:
        sys.stdout.write(txt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
