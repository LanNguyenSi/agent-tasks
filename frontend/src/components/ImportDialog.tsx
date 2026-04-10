"use client";

import { useCallback, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { autoDetectColumns, mapRows, getMappingCompleteness, type ColumnMapping, type ImportableTask } from "../lib/import-mapping";
import Modal from "./ui/Modal";
import { Button } from "./ui/Button";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  apiBase: string;
  onImported: () => void;
}

type Step = "upload" | "mapping" | "preview" | "importing" | "done";

export default function ImportDialog({ open, onClose, projectId, apiBase, onImported }: ImportDialogProps) {
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [tasks, setTasks] = useState<ImportableTask[]>([]);
  const [result, setResult] = useState<{ created: number; skipped: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const reset = useCallback(() => {
    setStep("upload");
    setHeaders([]);
    setRows([]);
    setMapping(null);
    setTasks([]);
    setResult(null);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const processFile = useCallback((file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

        if (jsonData.length < 2) {
          setError("File has no data rows.");
          return;
        }

        const h = (jsonData[0] as string[]).map((v) => String(v ?? ""));
        const r = jsonData.slice(1).filter((row) => (row as unknown[]).some((cell) => cell != null && cell !== ""));

        setHeaders(h);
        setRows(r);

        const detected = autoDetectColumns(h);
        setMapping(detected);
        setStep("mapping");
      } catch (err) {
        setError(`Failed to parse file: ${(err as Error).message}`);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  const completeness = useMemo(() => mapping ? getMappingCompleteness(mapping) : null, [mapping]);

  const handlePreview = useCallback(() => {
    if (!mapping) return;
    const mapped = mapRows(rows, mapping);
    setTasks(mapped);
    setStep("preview");
  }, [mapping, rows]);

  const handleImport = useCallback(async () => {
    setStep("importing");
    setError(null);

    try {
      let totalCreated = 0;
      let totalSkipped = 0;
      let totalFailed = 0;

      for (let i = 0; i < tasks.length; i += 200) {
        const batch = tasks.slice(i, i + 200);
        const res = await fetch(`${apiBase}/api/projects/${projectId}/tasks/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ tasks: batch }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`API error ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = await res.json();
        totalCreated += data.created;
        totalSkipped += data.skipped;
        totalFailed += data.failed;
      }

      setResult({ created: totalCreated, skipped: totalSkipped, failed: totalFailed });
      setStep("done");
      onImported();
    } catch (err) {
      setError((err as Error).message);
      setStep("preview");
    }
  }, [tasks, apiBase, projectId, onImported]);

  const updateMapping = useCallback((field: keyof ColumnMapping, value: number | null) => {
    setMapping((prev) => prev ? { ...prev, [field]: value } : prev);
  }, []);

  return (
    <Modal open={open} title="Import Tasks" onClose={handleClose}>
      {error && (
        <div style={{ background: "color-mix(in srgb, var(--danger) 15%, transparent)", border: "1px solid var(--danger)", borderRadius: "var(--radius-base)", padding: "0.5rem 0.75rem", marginBottom: "0.75rem", color: "var(--danger)", fontSize: "var(--text-sm)" }}>
          {error}
        </div>
      )}

      {/* Step 1: Upload */}
      {step === "upload" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragOver ? "var(--primary)" : "var(--border)"}`,
            borderRadius: "var(--radius-base)",
            padding: "2rem",
            textAlign: "center",
            cursor: "pointer",
            transition: "border-color 0.15s",
          }}
          onClick={() => document.getElementById("import-file-input")?.click()}
        >
          <p style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "0.5rem" }}>
            Drop .xlsx or .csv file here
          </p>
          <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            or click to browse
          </p>
          <input
            id="import-file-input"
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
        </div>
      )}

      {/* Step 2: Column Mapping */}
      {step === "mapping" && mapping && (
        <div>
          <p style={{ marginBottom: "0.75rem", color: "var(--muted)", fontSize: "var(--text-sm)" }}>
            Found {rows.length} rows and {headers.length} columns. Verify the column mapping:
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "0.4rem", marginBottom: "1rem" }}>
            {(Object.keys(mapping) as (keyof ColumnMapping)[]).map((field) => (
              <label key={field} style={{ display: "contents" }}>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, padding: "0.3rem 0", color: field === "title" ? "var(--text)" : "var(--muted)" }}>
                  {field}{field === "title" ? " *" : ""}
                </span>
                <select
                  value={mapping[field] ?? ""}
                  onChange={(e) => updateMapping(field, e.target.value === "" ? null : Number(e.target.value))}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-base)",
                    padding: "0.3rem 0.5rem",
                    color: "var(--text)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  <option value="">-- not mapped --</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {completeness && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.75rem" }}>
              {completeness.mapped.length} fields mapped
              {completeness.unmapped.length > 0 && ` (unmapped: ${completeness.unmapped.join(", ")})`}
            </p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={reset}>Back</Button>
            <Button onClick={handlePreview} disabled={mapping.title === null}>
              Preview
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Preview */}
      {step === "preview" && (
        <div>
          <p style={{ marginBottom: "0.75rem", fontSize: "var(--text-sm)", color: "var(--muted)" }}>
            {tasks.length} tasks ready to import:
          </p>
          <div style={{ maxHeight: "300px", overflow: "auto", marginBottom: "1rem", border: "1px solid var(--border)", borderRadius: "var(--radius-base)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-xs)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--surface)" }}>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Ref</th>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Title</th>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Priority</th>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Status</th>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Labels</th>
                </tr>
              </thead>
              <tbody>
                {tasks.slice(0, 50).map((t, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "0.3rem 0.5rem", fontFamily: "monospace", color: "var(--primary)" }}>{t.externalRef || "-"}</td>
                    <td style={{ padding: "0.3rem 0.5rem", maxWidth: "250px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</td>
                    <td style={{ padding: "0.3rem 0.5rem" }}>{t.priority}</td>
                    <td style={{ padding: "0.3rem 0.5rem" }}>{t.status}</td>
                    <td style={{ padding: "0.3rem 0.5rem" }}>{t.labels.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tasks.length > 50 && (
              <p style={{ padding: "0.4rem 0.5rem", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                ... and {tasks.length - 50} more
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <Button variant="ghost" onClick={() => setStep("mapping")}>Back</Button>
            <Button onClick={handleImport}>
              Import {tasks.length} tasks
            </Button>
          </div>
        </div>
      )}

      {/* Step 4: Importing */}
      {step === "importing" && (
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <p style={{ fontSize: "var(--text-md)" }}>Importing {tasks.length} tasks...</p>
        </div>
      )}

      {/* Step 5: Done */}
      {step === "done" && result && (
        <div style={{ textAlign: "center", padding: "1.5rem" }}>
          <p style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "0.75rem" }}>Import Complete</p>
          <div style={{ display: "flex", justifyContent: "center", gap: "2rem", marginBottom: "1rem" }}>
            <div>
              <p style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--primary)" }}>{result.created}</p>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Created</p>
            </div>
            <div>
              <p style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--muted)" }}>{result.skipped}</p>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Skipped</p>
            </div>
            {result.failed > 0 && (
              <div>
                <p style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--danger)" }}>{result.failed}</p>
                <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>Failed</p>
              </div>
            )}
          </div>
          <Button onClick={handleClose}>Close</Button>
        </div>
      )}
    </Modal>
  );
}
