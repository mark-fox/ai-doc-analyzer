from pydantic import BaseModel
from typing import List, Dict, Any, Optional

class UploadResponse(BaseModel):
    filename: str
    num_chunks: int
    message: str

class QueryRequest(BaseModel):
    query: str
    top_k: int = 5
    source_filter: Optional[str] = None

class QueryResponse(BaseModel):
    answer: str
    sources: List[Dict[str, Any]]
    confidence: Optional[float] = None
    citation: Optional[Dict[str, Any]] = None

class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None
    