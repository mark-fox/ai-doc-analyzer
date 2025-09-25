import os
import shutil
import app.embeddings as embeddings
import openai
from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from app.models import UploadResponse, QueryRequest, QueryResponse
from app.utils import extract_pdf_chunks
from app.embeddings import embed_and_store, load_index_and_metadata, save_index_and_metadata, search
from app.qa import answer_with_qa
from typing import List

openai.api_key = os.getenv("OPENAI_API_KEY")

# 1) Ensure an upload directory exists
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# 2) Initialize FastAPI
app = FastAPI(title="AI Document Analyzer – PDF Uploader")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # or ["http://127.0.0.1:5173"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def on_startup():
    load_index_and_metadata()

@app.on_event("shutdown")
async def on_shutdown():
    save_index_and_metadata()
    
@app.get("/")
async def root():
    return RedirectResponse(url="/docs")

@app.post("/upload-pdf", response_model=UploadResponse)
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    # 1) Save the uploaded PDF temporarily
    temp_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(temp_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # 2) Extract & chunk with metadata
    items = extract_pdf_chunks(temp_path, source=file.filename, max_chars=800)
    # items is a list of dicts: {"text", "source", "page", "chunk_id"}
    if not items:
        os.remove(temp_path)
        return JSONResponse(
            status_code=200,
            content={"filename": file.filename, "num_chunks": 0, "message": "No text found in PDF."},
        )

    # 3) Embed & store all metadata-rich items
    embed_and_store(items)

    # Clean up upload
    os.remove(temp_path)

    return {
        "filename": file.filename,
        "num_chunks": len(items),
        "message": "PDF processed and embeddings stored with metadata."
    }


@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.post("/search")
async def search_docs(
    query: str = Body(..., embed=True),
    top_k: int = Body(5, embed=True)
):
    """
    Returns up to top_k most similar chunks, including full metadata.
    """
    # `search()` now returns List[Tuple[Dict, float]]
    raw_results = search(query, top_k=top_k)
    # Build a list of enriched result dicts
    enriched = []
    for meta, score in raw_results:
        enriched.append({
            "text":     meta["text"],
            "source":   meta["source"],
            "page":     meta["page"],
            "chunk_id": meta["chunk_id"],
            "score":    score
        })
    return enriched

@app.post("/query", response_model=QueryResponse)
async def query_docs(req: QueryRequest):
    """
    RAG (extractive) endpoint:
      1) Vector-search top-K chunks
      2) Build a compact context string
      3) Use a local extractive QA model to pull the best span
    """
    # 1) Retrieve top-K chunks + scores
    raw_hits = search(req.query, top_k=req.top_k)

    # Build metadata list for the response
    sources = []
    context_pieces = []
    for meta, score in raw_hits:
        sources.append({
            "text":     meta["text"],
            "source":   meta["source"],
            "page":     meta["page"],
            "chunk_id": meta["chunk_id"],
            "score":    score
        })
        # Keep context tight (shorter is better for extractive QA)
        context_pieces.append(meta["text"])
    
    # Only keep the top-1 hit for QA + response
    sources = sources[:1]
    context = context_pieces[0] if context_pieces else ""

    # 2) Guard: no context found
    if not context:
        return QueryResponse(answer="I don’t know.", sources=sources)

    # 3) Run extractive QA locally (free)
    try:
        qa_res = answer_with_qa(req.query, context)
        # qa_res: {'answer': str, 'score': float, 'start': int, 'end': int}
        answer_text = qa_res.get("answer", "").strip()
        conf = float(qa_res.get("score", 0.0))

        # Find which source chunk contains the answer (simple substring match)
        which = None
        for s in sources:
            idx = s["text"].find(answer_text)
            if idx != -1:
                which = {
                    "source": s["source"],
                    "page": s["page"],
                    "chunk_id": s["chunk_id"],
                    "start": idx,
                    "end": idx + len(answer_text)
                }
                break

        return QueryResponse(
            answer=answer_text or "I don’t know.",
            sources=sources,
            confidence=conf,
            citation=which
        )
    except Exception as e:
        # Fallback so your API returns a helpful message instead of 500
        return QueryResponse(answer=f"QA error: {e}", sources=sources)



@app.get("/stats")
async def stats():
    return {
        "vector_count": embeddings.index.ntotal,      # total vectors in FAISS
        "metadata_count": len(embeddings.METADATA)    # should match vector_count
    }

