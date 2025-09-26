import { useEffect, useMemo, useRef, useState } from "react";

const MAX_MB = 25;
const BYTES = (mb) => mb * 1024 * 1024;

function Highlight({ text, match }) {
  if (!match) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(match.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  const before = text.slice(0, idx);
  const mid = text.slice(idx, idx + match.length);
  const after = text.slice(idx + match.length);
  return (
    <span>
      {before}
      <mark style={{ background: "#fff59d" }}>{mid}</mark>
      {after}
    </span>
  );
}

export default function App() {
  const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

  const [file, setFile] = useState(null);
  const [query, setQuery] = useState("");

  const [uploadStatus, setUploadStatus] = useState(null); // {type:'ok'|'err', msg:string}
  const [queryStatus, setQueryStatus] = useState(null);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [loadingQuery, setLoadingQuery] = useState(false);

  const [answer, setAnswer] = useState("");
  const [confidence, setConfidence] = useState(null);
  const [sources, setSources] = useState([]); // we keep top-1 on backend
  const topSource = sources?.[0];

  const abortRef = useRef(null);

  useEffect(() => {
    // simple ping to show if backend is reachable
    (async () => {
      try {
        const r = await fetch(`${API_URL}/health`);
        if (!r.ok) throw new Error(`Health check failed: ${r.status}`);
      } catch (e) {
        setUploadStatus({ type: "err", msg: `Backend not reachable at ${API_URL}. Is it running?` });
      }
    })();
  }, [API_URL]);

  const resetQueryResults = () => {
    setAnswer("");
    setConfidence(null);
    setSources([]);
    setQueryStatus(null);
  };

  async function handleUpload(e) {
    e.preventDefault();
    setUploadStatus(null);
    resetQueryResults();

    if (!file) {
      setUploadStatus({ type: "err", msg: "Please choose a PDF to upload." });
      return;
    }
    if (file.type !== "application/pdf") {
      setUploadStatus({ type: "err", msg: "Only PDF files are accepted." });
      return;
    }
    if (file.size > BYTES(MAX_MB)) {
      setUploadStatus({ type: "err", msg: `File too large (> ${MAX_MB} MB).` });
      return;
    }

    setLoadingUpload(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API_URL}/upload-pdf`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // backend may return {error, detail} or {detail}
        const msg =
          data?.error ? `${data.error}: ${data.detail || ""}` :
          data?.detail || `Upload failed (${res.status})`;
        setUploadStatus({ type: "err", msg });
      } else {
        setUploadStatus({
          type: "ok",
          msg: `Uploaded ${data.filename}. Created ${data.num_chunks} chunk(s).`,
        });
      }
    } catch (err) {
      setUploadStatus({ type: "err", msg: `Network error: ${err.message}` });
    } finally {
      setLoadingUpload(false);
    }
  }

  async function handleQuery(e) {
    e.preventDefault();
    setQueryStatus(null);
    setAnswer("");
    setConfidence(null);
    setSources([]);

    if (!query.trim()) {
      setQueryStatus({ type: "err", msg: "Type a question first." });
      return;
    }

    setLoadingQuery(true);

    // Optional timeout
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: 3 }),
        signal: controller.signal,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          data?.error ? `${data.error}: ${data.detail || ""}` :
          data?.detail || `Query failed (${res.status})`;
        setQueryStatus({ type: "err", msg });
        return;
      }

      setAnswer(data.answer || "");
      setConfidence(typeof data.confidence === "number" ? data.confidence : null);
      setSources(Array.isArray(data.sources) ? data.sources : []);
      if (!data.answer) {
        setQueryStatus({ type: "err", msg: "No answer returned." });
      }
    } catch (err) {
      if (err.name === "AbortError") {
        setQueryStatus({ type: "err", msg: "Request timed out." });
      } else {
        setQueryStatus({ type: "err", msg: `Network error: ${err.message}` });
      }
    } finally {
      clearTimeout(timeout);
      setLoadingQuery(false);
      abortRef.current = null;
    }
  }

  const shortSourceText = useMemo(() => {
    if (!topSource?.text) return "";
    // clamp long chunks for display
    return topSource.text.length > 600
      ? topSource.text.slice(0, 600) + "…"
      : topSource.text;
  }, [topSource]);

  return (
    <div style={{ padding: "2rem", fontFamily: "Inter, system-ui, sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: "1rem" }}>AI Document Analyzer</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        Backend: <code>{API_URL}</code>
      </p>

      {/* Upload */}
      <section style={{ padding: "1rem", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Upload PDF</h2>
        <form onSubmit={handleUpload}>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <button type="submit" disabled={loadingUpload} style={{ marginLeft: 8 }}>
            {loadingUpload ? "Uploading…" : "Upload"}
          </button>
        </form>

        {uploadStatus && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: uploadStatus.type === "ok" ? "#ecfdf5" : "#fef2f2",
              color: uploadStatus.type === "ok" ? "#065f46" : "#991b1b",
              border: `1px solid ${uploadStatus.type === "ok" ? "#10b981" : "#f87171"}`,
            }}
          >
            {uploadStatus.msg}
          </div>
        )}
      </section>

      {/* Query */}
      <section style={{ padding: "1rem", border: "1px solid #e5e7eb", borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Ask a Question</h2>
        <form onSubmit={handleQuery}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g., What animal jumps over the lazy dog?"
            style={{ width: 420, padding: 8 }}
          />
          <button type="submit" disabled={loadingQuery} style={{ marginLeft: 8 }}>
            {loadingQuery ? "Searching…" : "Ask"}
          </button>
        </form>

        {queryStatus && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: queryStatus.type === "ok" ? "#ecfdf5" : "#fef2f2",
              color: queryStatus.type === "ok" ? "#065f46" : "#991b1b",
              border: `1px solid ${queryStatus.type === "ok" ? "#10b981" : "#f87171"}`,
            }}
          >
            {queryStatus.msg}
          </div>
        )}

        {/* Results */}
        {(answer || topSource) && (
          <div style={{ marginTop: 16 }}>
            <h3>Answer</h3>
            <p style={{ fontSize: 18, marginTop: 6 }}>{answer || "—"}</p>
            {typeof confidence === "number" && (
              <p style={{ color: "#6b7280", marginTop: -6 }}>confidence: {confidence.toFixed(3)}</p>
            )}

            {topSource && (
              <>
                <h3 style={{ marginTop: 20 }}>Source</h3>
                <p style={{ margin: "4px 0", color: "#374151" }}>
                  <strong>{topSource.source}</strong> — page {topSource.page}, chunk {topSource.chunk_id}
                </p>
                <div
                  style={{
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    padding: 12,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  <Highlight text={shortSourceText} match={answer} />
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
