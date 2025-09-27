import os
import faiss
import numpy as np
from sentence_transformers import SentenceTransformer
from typing import List, Tuple, Dict, Any
import json

# 1) Load an embedding model (once, at startup)
EMBED_MODEL = SentenceTransformer("all-MiniLM-L6-v2")

# 2) Initialize a FAISS index (in-memory). Dimension = 384 for all-MiniLM-L6-v2
EMBED_DIM = 384
index = faiss.IndexFlatL2(EMBED_DIM)

# 3) Metadata store: list of (id → original text chunk)
#    a Python list where index i corresponds to vector i.
METADATA: List[Dict[str, Any]] = []


INDEX_PATH = "index.faiss"
META_PATH  = "metadata.json"

def clear_index(delete_files: bool = True):
    """
    Reset the in-memory FAISS index and metadata.
    Optionally delete persistence files on disk.
    """
    global index, METADATA
    # Recreate empty index
    new_index = faiss.IndexFlatL2(EMBED_DIM)
    index = new_index
    METADATA = []

    if delete_files:
        for p in (INDEX_PATH, META_PATH):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass

def embed_and_store(items: List[Dict[str, Any]]) -> None:
    """
    items: [
      {"text": "...", "source": filename, "page": page_num, "chunk_id": id},
      ...
    ]
    Embeds each `item["text"]` and appends the full item dict to METADATA.
    """
    # 1) Extract just the texts in order
    texts = [item["text"] for item in items]

    # 2) Compute embeddings
    vectors = EMBED_MODEL.encode(texts, show_progress_bar=False)
    vectors = np.array(vectors).astype("float32")

    # 3) Add to FAISS and record metadata
    index.add(vectors)
    METADATA.extend(items)


def search(query: str, top_k: int = 5) -> List[Tuple[str, float]]:
    """
    Given a query string, return up to top_k (chunk_text, score) tuples.
    Bad indices (e.g. -1 or out of range) are skipped.
    """
    q_vec = EMBED_MODEL.encode([query]).astype("float32")
    distances, indices = index.search(q_vec, top_k)

    results: List[Tuple[str, float]] = []
    for dist, idx in zip(distances[0], indices[0]):
        # Skip invalid indices
        if idx < 0 or idx >= len(METADATA):
            continue
        results.append((METADATA[idx], float(dist)))
    return results

def save_index_and_metadata():
    # 1) Save FAISS index
    faiss.write_index(index, INDEX_PATH)
    # 2) Save METADATA
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(METADATA, f, ensure_ascii=False, indent=2)

def load_index_and_metadata():
    global index, METADATA
    # 1) Load FAISS index if present
    if os.path.exists(INDEX_PATH):
        index = faiss.read_index(INDEX_PATH)
    # 2) Load METADATA if present
    if os.path.exists(META_PATH):
        with open(META_PATH, "r", encoding="utf-8") as f:
            METADATA = json.load(f)