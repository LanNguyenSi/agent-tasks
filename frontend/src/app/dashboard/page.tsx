"use client";

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  createdAt: string;
}

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Wave 2: fetch from real API with auth
    setLoading(false);
  }, []);

  return (
    <main style={{ padding: "2rem", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem" }}>Dashboard</h1>
        <a href="/" style={{ color: "var(--muted)", textDecoration: "none" }}>← Back</a>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "1rem",
        marginBottom: "2rem"
      }}>
        {["open", "in_progress", "review", "done"].map((status) => (
          <div key={status} style={{
            background: "var(--border)",
            borderRadius: "0.5rem",
            padding: "1rem",
          }}>
            <h3 style={{ textTransform: "capitalize", marginBottom: "0.5rem", color: "var(--muted)" }}>
              {status.replace("_", " ")}
            </h3>
            <p style={{ fontSize: "1.5rem", fontWeight: 600 }}>
              {tasks.filter((t) => t.status === status).length}
            </p>
          </div>
        ))}
      </div>

      {loading ? (
        <p style={{ color: "var(--muted)" }}>Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No tasks yet. Login with GitHub to get started.</p>
      ) : (
        <div>
          {tasks.map((task) => (
            <div key={task.id} style={{
              background: "var(--border)",
              borderRadius: "0.5rem",
              padding: "1rem",
              marginBottom: "0.5rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <span>{task.title}</span>
              <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>{task.status}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
