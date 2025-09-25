import { useState } from "react";

function App() {
  const [file, setFile] = useState(null);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState([]);

  const API_URL = "http://127.0.0.1:8000";

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_URL}/upload-pdf`, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    alert(`Uploaded ${data.filename}, created ${data.num_chunks} chunks.`);
  }

  async function handleQuery(e) {
    e.preventDefault();
    if (!query) return;

    const res = await fetch(`${API_URL}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: 3 }),
    });

    const data = await res.json();
    setAnswer(data.answer);
    setSources(data.sources || []);
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>AI Document Analyzer</h1>

      {/* Upload */}
      <form onSubmit={handleUpload} style={{ marginBottom: "1rem" }}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files[0])}
        />
        <button type="submit">Upload PDF</button>
      </form>

      {/* Query */}
      <form onSubmit={handleQuery}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask a question..."
          style={{ width: "300px" }}
        />
        <button type="submit">Ask</button>
      </form>

      {/* Results */}
      {answer && (
        <div style={{ marginTop: "2rem" }}>
          <h2>Answer</h2>
          <p>{answer}</p>

          <h3>Sources</h3>
          <ul>
            {sources.map((s, i) => (
              <li key={i}>
                <strong>{s.source}</strong>, page {s.page} —{" "}
                <em>{s.text.substring(0, 80)}...</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default App;
