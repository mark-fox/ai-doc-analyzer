from transformers import pipeline

# Load once at import time (fast after the first run due to local caching)
# Model: small, free, extractive QA
_qa = pipeline("question-answering", model="deepset/roberta-base-squad2")

def answer_with_qa(question: str, context: str) -> dict:
    """
    Returns {'answer': str, 'score': float, 'start': int, 'end': int}
    """
    return _qa(question=question, context=context)
