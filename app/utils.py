import pdfplumber
from typing import List, Dict, Any

def extract_text_from_pdf(path: str) -> str:
    """
    Open a PDF file at `path` and return all text concatenated.
    """
    text_pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            text_pages.append(text)
    return "\n".join(text_pages)

def chunk_text(text: str, max_chars: int = 800) -> List[str]:
    """
    Split `text` roughly into chunks of up to `max_chars` characters.
    Splitting at nearest newline or space.
    """
    chunks = []
    start = 0
    length = len(text)
    while start < length:
        end = start + max_chars
        if end < length:
            # try to split at nearest newline or space
            split_pos = text.rfind("\n", start, end)
            if split_pos == -1:
                split_pos = text.rfind(" ", start, end)
            if split_pos == -1 or split_pos <= start:
                split_pos = end
        else:
            split_pos = length
        chunk = text[start:split_pos].strip()
        if chunk:
            chunks.append(chunk)
        start = split_pos
    return chunks

def extract_pdf_chunks(
    path: str,
    source: str,
    max_chars: int = 800
) -> List[Dict[str, Any]]:
    """
    Open the PDF at `path`, split each page’s text into ~max_chars chunks,
    and return a list of metadata dicts:
      {
        "text": "<chunk text>",
        "source": "<filename>",
        "page": <page number>,
        "chunk_id": <sequential ID within this document>
      }
    """
    items: List[Dict[str, Any]] = []
    chunk_id = 0

    with pdfplumber.open(path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            raw = page.extract_text() or ""
            # reuse your chunk_text() to split the page’s raw text
            page_chunks = chunk_text(raw, max_chars)
            for chunk in page_chunks:
                items.append({
                    "text": chunk,
                    "source": source,
                    "page": page_num,
                    "chunk_id": chunk_id
                })
                chunk_id += 1

    return items