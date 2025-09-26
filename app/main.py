import os
import shutil
import app.embeddings as embeddings
import openai
import logging
from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from app.models import UploadResponse, QueryRequest, QueryResponse, ErrorResponse
from app.utils import extract_pdf_chunks
from app.embeddings import embed_and_store, load_index_and_metadata, save_index_and_metadata, search
from app.qa import answer_with_qa
from typing import List

openai.api_key = os.getenv("OPENAI_API_KEY")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger("ai-doc-analyzer")

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

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.warning("Validation error: %s", exc)
    return JSONResponse(
        status_code=422,
        content=ErrorResponse(error="validation_error", detail=str(exc)).model_dump(),
    )

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error")
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(error="internal_error", detail="An unexpected error occurred.").model_dump(),
    )

@app.post("/upload-pdf", response_model=UploadResponse, responses={400: {"model": ErrorResponse}, 413: {"model": ErrorResponse}, 500: {"model": ErrorResponse}})
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    # quick size check if possible (some clients send no content-length)
    try:
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
        file.file.seek(0)
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty file.")
        if size > MAX_UPLOAD_BYTES:
            return JSONResponse(
                status_code=413,
                content=ErrorResponse(error="file_too_large", detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024*1024)} MB").model_dump(),
            )
    except Exception:
        # if seeking fails, just proceed; extraction will handle errors
        pass

    temp_path = os.path.join(UPLOAD_DIR, file.filename)
    try:
        with open(temp_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        logger.exception("Failed to write upload")
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {e}")

    # Extract & chunk with metadata
    try:
        items = extract_pdf_chunks(temp_path, source=file.filename, max_chars=800)
    except Exception as e:
        os.remove(temp_path)
        logger.exception("PDF extraction failed")
        raise HTTPException(status_code=400, detail=f"Failed to read PDF: {e}")

    if not items:
        os.remove(temp_path)
        return JSONResponse(
            status_code=200,
            content=UploadResponse(filename=file.filename, num_chunks=0, message="No text found in PDF.").model_dump(),
        )

    # Embed & store
    try:
        embed_and_store(items)
    except Exception as e:
        logger.exception("Embedding error")
        os.remove(temp_path)
        raise HTTPException(status_code=500, detail=f"Embedding error: {e}")

    os.remove(temp_path)
    return UploadResponse(filename=file.filename, num_chunks=len(items), message="PDF processed and embeddings stored with metadata.")


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
    # Empty index guard
    if len(embeddings.METADATA) == 0 or embeddings.index.ntotal == 0:
        return JSONResponse(
            status_code=200,
            content={"results": [], "message": "Index is empty. Upload a PDF first."}
        )

    raw_results = search(query, top_k=top_k)
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

@app.post("/query", response_model=QueryResponse, responses={200: {"model": QueryResponse}, 400: {"model": ErrorResponse}})
async def query_docs(req: QueryRequest):
    # Empty index guard
    if len(embeddings.METADATA) == 0 or embeddings.index.ntotal == 0:
        return JSONResponse(
            status_code=400,
            content=ErrorResponse(error="empty_index", detail="No documents indexed. Upload a PDF first.").model_dump()
        )

    raw_hits = search(req.query, top_k=req.top_k)

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
        context_pieces.append(meta["text"])

    # Top-1 context strategy
    if not context_pieces:
        return QueryResponse(answer="I don’t know.", sources=[])
    context = context_pieces[0]
    sources = sources[:1]

    try:
        qa_res = answer_with_qa(req.query, context)
        answer_text = (qa_res.get("answer") or "").strip()
        conf = float(qa_res.get("score", 0.0))
    except Exception as e:
        logger.exception("QA pipeline error")
        return QueryResponse(answer=f"QA error: {e}", sources=sources)

    # Optional: confidence gate
    if not answer_text:
        answer_text = "I don’t know."

    # (Optional) find citation offsets
    which = None
    idx = sources[0]["text"].find(answer_text) if sources else -1
    if idx != -1 and sources:
        which = {
            "source": sources[0]["source"],
            "page": sources[0]["page"],
            "chunk_id": sources[0]["chunk_id"],
            "start": idx,
            "end": idx + len(answer_text),
        }

    return QueryResponse(answer=answer_text, sources=sources, confidence=conf, citation=which)



@app.get("/stats")
async def stats():
    try:
        return {
            "vector_count": embeddings.index.ntotal,
            "metadata_count": len(embeddings.METADATA)
        }
    except Exception as e:
        logger.exception("Stats error")
        return {"vector_count": 0, "metadata_count": 0, "note": f"error: {e}"}

