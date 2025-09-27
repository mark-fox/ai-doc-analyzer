import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

// Tell pdf.js to use the bundled worker
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

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
      <mark className="hl">{mid}</mark>
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
  const [sources, setSources] = useState([]);
  const topSource = sources?.[0];
  const otherSources = sources?.slice(1) ?? [];

  const [showMoreSources, setShowMoreSources] = useState(false);
  const abortRef = useRef(null);

  const [dragActive, setDragActive] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const fileInputRef = useRef(null);

  const [stats, setStats] = useState({ vector_count: 0, metadata_count: 0 });
  const indexReady = stats.vector_count > 0 && stats.metadata_count > 0;

  const [clearing, setClearing] = useState(false);

  const [pageCount, setPageCount] = useState(null);

  const [sourcesList, setSourcesList] = useState([]);
  const [sourceFilter, setSourceFilter] = useState("");

  const [monospace, setMonospace] = useState(false);

  const prettyBytes = (n) => {
    if (!Number.isFinite(n)) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_URL}/health`);
        if (!r.ok) throw new Error();
        await fetchStats(); // get initial index counts
        await fetchSources();
      } catch {
        setUploadStatus({
          type: "err",
          msg: `Backend not reachable at ${API_URL}. Is it running?`,
        });
      }
    })();
  }, [API_URL]);

  const resetQueryResults = () => {
    setAnswer("");
    setConfidence(null);
    setSources([]);
    setQueryStatus(null);
    setShowMoreSources(false);
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
      // const { ok, data, status } = await uploadWithProgress(formData);
      const { ok, data, status } = await fallbackUpload(formData);

      if (!ok) {
        const msg = data?.error
          ? `${data.error}${data.detail ? `: ${data.detail}` : ""}`
          : data?.detail || `Upload failed (${status || "unknown"})`;
        setUploadStatus({ type: "err", msg });
      } else {
        setUploadStatus({
          type: "ok",
          msg: `Uploaded ${data.filename}. Created ${data.num_chunks} chunk(s).`,
        });
        // refresh stats so Ask enables
        await fetchStats();
        await fetchSources();
      }
    } catch (err) {
      setUploadStatus({ type: "err", msg: `Upload crashed: ${err.message}` });
    } finally {
      setLoadingUpload(false);
      // Let the bar rest at 100% briefly if it reached it; then clear
      setTimeout(() => setUploadPct(0), 600);
    }
  }

  async function handleQuery(e) {
    e.preventDefault();
    setQueryStatus(null);
    setAnswer("");
    setConfidence(null);
    setSources([]);
    setShowMoreSources(false);

    if (!query.trim()) {
      setQueryStatus({ type: "err", msg: "Type a question first." });
      return;
    }

    setLoadingQuery(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          top_k: 3,
          source_filter: sourceFilter || null,
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error
          ? `${data.error}: ${data.detail || ""}`
          : data?.detail || `Query failed (${res.status})`;
        setQueryStatus({ type: "err", msg });
        return;
      }
      setAnswer(data.answer || "");
      setConfidence(
        typeof data.confidence === "number" ? data.confidence : null
      );
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
    return topSource.text.length > 600
      ? topSource.text.slice(0, 600) + "…"
      : topSource.text;
  }, [topSource]);

  async function uploadWithProgress(formData) {
    setUploadPct(0);

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/upload-pdf`);
      xhr.responseType = "text"; // we’ll parse manually for resilience
      xhr.timeout = 30000; // 30s hard timeout

      // Progress
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.max(
            0,
            Math.min(100, Math.round((e.loaded / e.total) * 100))
          );
          setUploadPct(pct);
        }
      };

      // Settle on readyState change (covers some edge cases where onload doesn’t fire)
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        settleFromXhr();
      };

      xhr.onload = settleFromXhr;
      xhr.onerror = () =>
        resolve({
          ok: false,
          status: xhr.status || 0,
          data: { detail: "Network error" },
        });
      xhr.ontimeout = () =>
        resolve({
          ok: false,
          status: 0,
          data: { detail: "Upload timed out after 30s" },
        });
      xhr.onabort = () =>
        resolve({ ok: false, status: 0, data: { detail: "Upload aborted" } });

      function settleFromXhr() {
        let data = {};
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          // keep data = {}
        }
        const ok = xhr.status >= 200 && xhr.status < 300;
        resolve({ ok, status: xhr.status, data });
      }

      try {
        xhr.send(formData);
      } catch {
        resolve({
          ok: false,
          status: 0,
          data: { detail: "Failed to send request" },
        });
      }
    });
  }

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }
  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }
  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      setFile(f);
      analyzePdf(f);
    }
  }

  async function fetchStats() {
    try {
      const r = await fetch(`${API_URL}/stats`);
      const j = await r.json();
      setStats({
        vector_count: Number(j.vector_count || 0),
        metadata_count: Number(j.metadata_count || 0),
      });
    } catch {
      setStats({ vector_count: 0, metadata_count: 0 });
    }
  }

  async function handleClearIndex() {
    if (!confirm("Clear all embeddings and metadata? This cannot be undone."))
      return;
    setClearing(true);
    try {
      const headers = { "Content-Type": "application/json" };
      const admin = import.meta.env.VITE_ADMIN_TOKEN;
      if (admin) headers["X-Admin-Token"] = admin;

      const res = await fetch(`${API_URL}/admin/clear-index`, {
        method: "POST",
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          data?.detail || data?.error || `Clear failed (${res.status})`;
        setUploadStatus({ type: "err", msg });
        return;
      }
      // reset UI
      setUploadStatus({ type: "ok", msg: "Index cleared." });
      setAnswer("");
      setConfidence(null);
      setSources([]);
      setQuery("");
      await fetchStats(); // refresh counts to 0
      await fetchSources();
    } catch (e) {
      setUploadStatus({ type: "err", msg: `Network error: ${e.message}` });
    } finally {
      setClearing(false);
    }
  }

  async function analyzePdf(f) {
    setPageCount(null);
    if (!f || f.type !== "application/pdf") return;
    try {
      const buf = await f.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: buf });
      const pdf = await loadingTask.promise;
      setPageCount(pdf.numPages);
    } catch (e) {
      console.warn("PDF analyze failed:", e);
      // Couldn’t parse; just leave pageCount null
      setPageCount(null);
    }
  }

  async function fallbackUpload(formData) {
    try {
      const res = await fetch(`${API_URL}/upload-pdf`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        data: { detail: `Network error: ${e.message}` },
      };
    }
  }

  async function fetchSources() {
    try {
      const r = await fetch(`${API_URL}/sources`);
      const j = await r.json();
      setSourcesList(Array.isArray(j) ? j : []);
    } catch {}
  }

  return (
    <div
      style={{
        padding: "2rem",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <h1 style={{ marginBottom: "1rem" }}>AI Document Analyzer</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Backend: <code>{API_URL}</code>
      </p>

      {/* Upload */}
      <section className="panel" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Upload PDF</h2>
        <form onSubmit={handleUpload}>
          <div
            className={`dropzone ${dragActive ? "active" : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                fileInputRef.current?.click();
            }}
          >
            <p style={{ margin: 0 }}>
              {file ? (
                <>
                  Selected: <strong>{file.name}</strong>{" "}
                  <span style={{ color: "var(--muted)" }}>
                    ({prettyBytes(file.size)}
                    {typeof pageCount === "number"
                      ? `, ${pageCount} page${pageCount !== 1 ? "s" : ""}`
                      : ""}
                    )
                  </span>
                </>
              ) : (
                <>
                  Drag & drop a PDF here, or <u>click to choose</u>
                </>
              )}
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const f = e.target.files?.[0] || null;
                setFile(f);
                analyzePdf(f);
              }}
              style={{ display: "none" }}
            />
            {uploadPct > 0 && (
              <div className="progressbar">
                <span style={{ width: `${uploadPct}%` }} />
              </div>
            )}
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              type="submit"
              className="btn"
              disabled={loadingUpload || !file}
            >
              {loadingUpload ? "Uploading…" : "Upload"}
            </button>
          </div>
        </form>

        {uploadStatus && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: uploadStatus.type === "ok" ? "#ecfdf5" : "#fef2f2",
              color: uploadStatus.type === "ok" ? "#065f46" : "#991b1b",
              border: `1px solid ${
                uploadStatus.type === "ok" ? "#10b981" : "#f87171"
              }`,
            }}
          >
            {uploadStatus.msg}
          </div>
        )}
      </section>

      {/* Query */}
      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Ask a Question</h2>
        <p
          style={{
            margin: "6px 0",
            color: "var(--muted)",
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span>
            Index: {stats.vector_count} vectors / {stats.metadata_count} chunks
          </span>
          <button
            type="button"
            className="btn"
            onClick={handleClearIndex}
            disabled={
              clearing ||
              (stats.vector_count === 0 && stats.metadata_count === 0)
            }
            title="Remove all embeddings and metadata"
          >
            {clearing ? "Clearing…" : "Clear index"}
          </button>
        </p>

        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="btn"
            style={{ padding: 8 }}
            title="Filter by file"
          >
            <option value="">All files</option>
            {sourcesList.map((s) => (
              <option key={s.source} value={s.source}>
                {s.source} ({s.count})
              </option>
            ))}
          </select>
        </div>

        <form onSubmit={handleQuery}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g., What animal jumps over the lazy dog?"
            style={{ width: 420, padding: 8 }}
          />
          <button
            type="submit"
            className="btn"
            disabled={loadingQuery || !indexReady || !query.trim()}
            style={{ marginLeft: 8 }}
            title={!indexReady ? "Upload a PDF first" : ""}
          >
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
              border: `1px solid ${
                queryStatus.type === "ok" ? "#10b981" : "#f87171"
              }`,
            }}
          >
            {queryStatus.msg}
          </div>
        )}

        {(answer || topSource) && (
          <div style={{ marginTop: 16 }}>
            <h3>Answer</h3>
            <p style={{ fontSize: 18, marginTop: 6 }}>{answer || "—"}</p>
            {typeof confidence === "number" && (
              <p style={{ color: "var(--muted)", marginTop: -6 }}>
                confidence: {confidence.toFixed(3)}
              </p>
            )}

            {topSource && (
              <>
                <div className="badges">
                  <span className="badge file">
                    <span className="dot" />
                    {topSource.source}
                  </span>
                  <span className="badge page">
                    <span className="dot" />
                    page {topSource.page}
                  </span>
                  <span className="badge chunk">
                    <span className="dot" />
                    chunk {topSource.chunk_id}
                  </span>
                  {"score" in topSource &&
                    typeof topSource.score === "number" && (
                      <span className="badge score">
                        <span className="dot" />
                        score {topSource.score.toFixed(3)}
                      </span>
                    )}
                </div>
                <div className="sectionbar">
                  <h3>Source</h3>
                  <label style={{ fontSize: 14, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={monospace}
                      onChange={(e) => setMonospace(e.target.checked)}
                      style={{ marginRight: 6 }}
                    />
                    Monospace
                  </label>
                </div>

                <div className={`snippet ${monospace ? "mono" : ""}`}>
                  <Highlight text={shortSourceText} match={answer || query} />
                </div>
              </>
            )}

            {otherSources.length > 0 && (
              <div className="other-sources-wrap" style={{ marginTop: 12 }}>
                <div className="sectionbar" style={{ marginTop: 0 }}>
                  <h3>Other sources</h3>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setShowMoreSources((v) => !v)}
                  >
                    {showMoreSources ? "Hide" : "Show"} {otherSources.length}{" "}
                    more source{otherSources.length > 1 ? "s" : ""}
                  </button>
                </div>

                {showMoreSources && (
                  <ul>
                    {otherSources.map((s, i) => (
                      <li key={i} style={{ marginBottom: 10 }}>
                        <div className="badges" style={{ marginBottom: 6 }}>
                          <span className="badge file">
                            <span className="dot" />
                            {s.source}
                          </span>
                          <span className="badge page">
                            <span className="dot" />
                            page {s.page}
                          </span>
                          <span className="badge chunk">
                            <span className="dot" />
                            chunk {s.chunk_id}
                          </span>
                          {"score" in s && typeof s.score === "number" && (
                            <span className="badge score">
                              <span className="dot" />
                              score {s.score.toFixed(3)}
                            </span>
                          )}
                        </div>
                        <div className={`snippet ${monospace ? "mono" : ""}`}>
                          <Highlight
                            text={
                              s.text.length > 300
                                ? s.text.slice(0, 300) + "…"
                                : s.text
                            }
                            match={answer || query}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
