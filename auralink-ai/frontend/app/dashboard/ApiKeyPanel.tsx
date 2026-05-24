"use client";

/**
 * API Key management panel for the dashboard.
 * Lets users generate permanent `syn_live_` keys for use with the MCP server.
 */
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@clerk/nextjs";

const CLERK_JWT_TEMPLATE = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE?.trim();
const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://synclyst.app";

async function getAuthToken(
  getToken: ReturnType<typeof useAuth>["getToken"]
): Promise<string | null> {
  if (!getToken) return null;
  if (CLERK_JWT_TEMPLATE) {
    try {
      const t = await getToken({ template: CLERK_JWT_TEMPLATE });
      if (t) return t;
    } catch {}
  }
  return getToken();
}

interface ApiKeyMeta {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export default function ApiKeyPanel() {
  const { getToken } = useAuth();
  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [label, setLabel] = useState("MCP key");

  const fetchKeys = useCallback(async () => {
    try {
      const token = await getAuthToken(getToken);
      const r = await fetch(`${API_URL}/api/v1/api-keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setKeys(await r.json());
    } catch {}
    setLoading(false);
  }, [getToken]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const createKey = async () => {
    setCreating(true);
    setError(null);
    setNewKey(null);
    try {
      const token = await getAuthToken(getToken);
      const r = await fetch(`${API_URL}/api/v1/api-keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "Unknown error" }));
        setError(err.detail || "Failed to create key");
        return;
      }
      const data = await r.json();
      setNewKey(data.key);
      await fetchKeys();
    } catch (e) {
      setError("Network error — try again");
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (id: string) => {
    if (!confirm("Revoke this key? Any MCP config using it will stop working.")) return;
    setRevoking(id);
    try {
      const token = await getAuthToken(getToken);
      await fetch(`${API_URL}/api/v1/api-keys/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchKeys();
    } catch {}
    setRevoking(null);
  };

  const copyKey = () => {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  };

  return (
    <section
      className="glass-card"
      style={{ padding: "1.5rem", gridColumn: "1 / -1" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h3 className="section-label" style={{ marginBottom: 0 }}>Claude MCP — API Keys</h3>
        <span style={{
          fontSize: "0.65rem", fontWeight: 700, background: "#7c3aed",
          color: "#fff", padding: "0.1rem 0.45rem", borderRadius: "999px", letterSpacing: "0.05em",
        }}>NEW</span>
      </div>
      <p style={{ color: "var(--muted)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        Generate a permanent API key to use Synclyst with Claude Desktop or any MCP client.
        Keys don't expire — paste one into your <code style={{ background: "var(--surface)", padding: "0.1em 0.35em", borderRadius: 4, fontSize: "0.8em" }}>claude_desktop_config.json</code>.
      </p>

      {/* New key reveal */}
      {newKey && (
        <div style={{
          background: "#052e16", border: "1px solid #16a34a", borderRadius: 10,
          padding: "1rem 1.25rem", marginBottom: "1.25rem",
        }}>
          <p style={{ color: "#4ade80", fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            🔑 Your new API key — copy it now, it won't be shown again
          </p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <code style={{
              flex: 1, wordBreak: "break-all", fontSize: "0.8rem",
              color: "#86efac", background: "#14532d",
              padding: "0.5rem 0.75rem", borderRadius: 6,
            }}>{newKey}</code>
            <button
              type="button"
              onClick={copyKey}
              style={{
                background: copied ? "#16a34a" : "#22c55e",
                color: "#fff", border: "none", borderRadius: 7,
                padding: "0.45rem 0.85rem", fontWeight: 700, cursor: "pointer",
                whiteSpace: "nowrap", fontSize: "0.8125rem",
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p style={{ color: "#86efac", fontSize: "0.75rem", marginTop: "0.75rem" }}>
            Add to <strong>claude_desktop_config.json</strong>:
            <br />
            <code style={{ color: "#bbf7d0", fontSize: "0.75rem" }}>
              {`"SYNCLYST_API_KEY": "${newKey}"`}
            </code>
          </p>
        </div>
      )}

      {/* Create form */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginBottom: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label style={{ fontSize: "0.75rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
            Key label (optional)
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            placeholder="MCP key"
            style={{
              width: "100%", padding: "0.45rem 0.75rem", border: "1px solid var(--border)",
              borderRadius: 8, background: "var(--surface)", color: "var(--text)",
              fontSize: "0.875rem", boxSizing: "border-box",
            }}
          />
        </div>
        <button
          type="button"
          onClick={createKey}
          disabled={creating}
          className="glass-cta"
          style={{
            padding: "0.5rem 1.15rem", borderRadius: 8, fontWeight: 700,
            cursor: creating ? "not-allowed" : "pointer",
            color: "#fff", whiteSpace: "nowrap", fontSize: "0.875rem",
          }}
        >
          {creating ? "Creating…" : "Generate API key"}
        </button>
      </div>

      {error && (
        <p style={{ color: "#f87171", fontSize: "0.8125rem", marginBottom: "0.75rem" }}>⚠ {error}</p>
      )}

      {/* Key list */}
      {loading ? (
        <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Loading…</p>
      ) : keys.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
          No API keys yet. Generate one above to connect Claude Desktop.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: "flex", alignItems: "center", gap: "0.75rem",
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 9, padding: "0.65rem 1rem",
              }}
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{k.label}</span>
                <span style={{ color: "var(--muted)", fontSize: "0.75rem", marginLeft: "0.75rem" }}>
                  Created {formatDate(k.created_at)}
                  {k.last_used_at && ` · Last used ${formatDate(k.last_used_at)}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => revokeKey(k.id)}
                disabled={revoking === k.id}
                style={{
                  background: "transparent", border: "1px solid #ef4444",
                  color: "#ef4444", borderRadius: 7, padding: "0.3rem 0.65rem",
                  cursor: revoking === k.id ? "not-allowed" : "pointer",
                  fontSize: "0.75rem", fontWeight: 600,
                }}
              >
                {revoking === k.id ? "Revoking…" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Quick setup guide */}
      <details style={{ marginTop: "1.25rem" }}>
        <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "0.8125rem", fontWeight: 600, userSelect: "none" }}>
          How to set up Claude Desktop →
        </summary>
        <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p style={{ color: "var(--muted)", fontSize: "0.8125rem", lineHeight: 1.6 }}>
            1. Generate a key above and copy it.<br />
            2. Open <strong>Claude Desktop → Settings → Developer → Edit Config</strong>.<br />
            3. Add the block below (or update the key if you already have Synclyst installed):
          </p>
          <pre style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 8, padding: "0.75rem 1rem", fontSize: "0.75rem",
            color: "var(--text)", overflowX: "auto", lineHeight: 1.6,
          }}>{`{
  "mcpServers": {
    "synclyst": {
      "command": "npx",
      "args": ["-y", "synclyst-mcp"],
      "env": {
        "SYNCLYST_API_URL": "https://synclyst.app",
        "SYNCLYST_API_KEY": "syn_live_YOUR_KEY_HERE"
      }
    }
  }
}`}</pre>
          <p style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
            4. Save the file and restart Claude Desktop. You'll see Synclyst tools (🔌) in the bottom left.
          </p>
        </div>
      </details>
    </section>
  );
}
