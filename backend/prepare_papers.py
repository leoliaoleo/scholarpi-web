"""One-off prep for the preset demo papers.

Downloads each PDF from arXiv, pulls its metadata from the Atom API and writes a
per-page text index, so the judge can open the web app and start an agent reading
session without hunting for a PDF.

    python backend/prepare_papers.py
"""

import json
import os
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET

import requests
from pypdf import PdfReader

ARXIV_IDS = [
    "1706.03762",  # Attention Is All You Need
    "1512.03385",  # Deep Residual Learning for Image Recognition
    "1810.04805",  # BERT: Pre-training of Deep Bidirectional Transformers
]

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "data", "demo_papers")
UA = "Mozilla/5.0 ScholarPiWeb/0.1 (research demo; server-side fetch)"
ATOM = "{http://www.w3.org/2005/Atom}"


def fetch_meta(arxiv_id: str) -> dict:
    url = f"https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}"
    xml = requests.get(url, headers={"User-Agent": UA}, timeout=40).text
    entry = ET.fromstring(xml).find(f"{ATOM}entry")
    if entry is None:
        raise SystemExit(f"arXiv 没有返回 {arxiv_id} 的元数据")

    def text(tag):
        node = entry.find(ATOM + tag)
        return re.sub(r"\s+", " ", node.text or "").strip() if node is not None and node.text else ""

    authors = []
    for a in entry.findall(ATOM + "author"):
        n = a.find(ATOM + "name")
        if n is not None and n.text:
            authors.append(n.text.strip())
    link = entry.find(ATOM + "link")
    categories = [c.get("term") for c in entry.findall("{http://arxiv.org/schemas/atom}category") if c.get("term")]
    published = text("published")[:10]
    return {
        "title": text("title"),
        "abstract": text("summary"),
        "authors": authors,
        "published": published,
        "year": published[:4],
        "categories": categories[:4],
        "absUrl": link.get("href") if link is not None else "",
    }


def extract_pages(path: str) -> list:
    reader = PdfReader(path)
    pages = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception as e:  # a broken page must not kill the whole index
            print(f"  ! 第 {len(pages) + 1} 页解析失败：{e.__class__.__name__}")
            t = ""
        t = t.replace("\x0c", "").replace("\r\n", "\n")
        t = re.sub(r"[ \t]+\n", "\n", t)
        t = re.sub(r"\n{3,}", "\n\n", t)
        pages.append(t.strip())
    return pages


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = []
    for arxiv_id in ARXIV_IDS:
        slug = arxiv_id.replace(".", "p")
        pdf_name = f"{slug}.pdf"
        pdf_path = os.path.join(OUT_DIR, pdf_name)
        print(f"== {arxiv_id}")
        meta = fetch_meta(arxiv_id)
        print(f"   {meta['title'][:70]}")
        if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) < 10000:
            with requests.get(f"https://arxiv.org/pdf/{arxiv_id}", headers={"User-Agent": UA}, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(pdf_path, "wb") as f:
                    for chunk in r.iter_content(65536):
                        f.write(chunk)
            print(f"   PDF -> {os.path.getsize(pdf_path) / 1e6:.1f} MB")
        pages = extract_pages(pdf_path)
        chars = sum(len(p) for p in pages)
        print(f"   解析出 {len(pages)} 页 / {chars} 字符")
        if chars < 2000:
            sys.exit(f"{arxiv_id} 文本抽取几乎为空，请检查 PDF")
        with open(os.path.join(OUT_DIR, f"{slug}.json"), "w", encoding="utf-8") as f:
            json.dump({"id": arxiv_id, "title": meta["title"], "pages": pages}, f, ensure_ascii=False)
        manifest.append(
            {
                "id": arxiv_id,
                "slug": slug,
                "title": meta["title"],
                "authors": meta["authors"],
                "year": meta["year"],
                "venue": "arXiv",
                "abstract": meta["abstract"],
                "categories": meta["categories"],
                "url": meta["absUrl"],
                "pdfUrl": f"https://arxiv.org/pdf/{arxiv_id}",
                "pdfFile": pdf_name,
                "textFile": f"{slug}.json",
                "totalPages": len(pages),
                "bytes": os.path.getsize(pdf_path),
            }
        )
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n写入 {os.path.join(OUT_DIR, 'manifest.json')}（{len(manifest)} 篇）")


if __name__ == "__main__":
    main()
