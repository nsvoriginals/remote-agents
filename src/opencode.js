import { BASE_URL, HEADERS, POLL_MS, IDLE_TIMEOUT_MS, MAX_TOTAL_MS, NO_REPLY_MS, AUTO_APPROVE, CONTAINER_NAME } from "../config.js";
import * as sessions from "./sessions.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function oc(pathname, { method = "GET", body, signal } = {}) {
  const res = await fetch(BASE_URL + pathname, {
    method,
    signal: signal ?? AbortSignal.timeout(15000),
    headers: { ...HEADERS, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`OpenCode ${method} ${pathname} -> ${res.status}`);
    err.status = res.status;
    err.body = await res.text().catch(() => "");
    throw err;
  }
  return res;
}

export async function isHealthy() {
  try {
    const res = await fetch(`${BASE_URL}/global/health`, { headers: HEADERS, signal: AbortSignal.timeout(2000) });
    return !!(await res.json()).healthy;
  } catch { return false; }
}

export async function waitForHealth(timeoutSec = 120) {
  for (let i = 0; i < timeoutSec; i++) {
    if (await isHealthy()) { console.log(`[health] OpenCode up after ${i + 1}s`); return; }
    await sleep(1000);
  }
  throw new Error(`OpenCode health check timed out after ${timeoutSec}s`);
}

export async function getOrCreateSession(key, title) {
  const existing = sessions.get(key);
  if (existing) {
    try { await oc(`/session/${existing.id}`); return existing.id; }
    catch (e) { if (e.status !== 404) throw e; }
  }
  const data = await (await oc("/session", { method: "POST", body: { title } })).json();
  sessions.set(key, { id: data.id, createdAt: Date.now() });
  console.log("[session] created", data.id, "for", key);
  return data.id;
}

export async function listMessages(sessionId) {
  const data = await (await oc(`/session/${sessionId}/message`)).json();
  return Array.isArray(data) ? data : [];
}

async function approvePendingPermissions(sessionId) {
  let list;
  try {
    const res = await fetch(`${BASE_URL}/permission`, { headers: HEADERS, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    list = await res.json();
  } catch { return []; }
  if (!Array.isArray(list)) return [];

  const approved = [];
  for (const p of list) {
    if (p.sessionID && p.sessionID !== sessionId) continue;
    const post = (url, body) => fetch(`${BASE_URL}${url}`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => ({ ok: false }));

    let r = await post(`/permission/${p.id}/reply`, { reply: "always" });
    if (!r.ok) r = await post(`/session/${sessionId}/permissions/${p.id}`, { response: "always" });
    if (r.ok) approved.push(p.permission || p.type || p.title || "action");
  }
  return approved;
}

function toolLabel(part) {
  const title = part.state?.title || part.state?.input?.command || part.state?.input?.filePath || "";
  const label = title ? `${part.tool}: ${String(title).split("\n")[0]}` : part.tool;
  return label.length > 70 ? label.slice(0, 67) + "…" : label;
}

function describeError(err) {
  if (!err) return "Unknown error";
  return err.data?.message || err.message || err.name || JSON.stringify(err).slice(0, 300);
}

export class AgentError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

export async function runPrompt(sessionId, text, onProgress) {
  const baseline = new Set((await listMessages(sessionId)).map((m) => m.info?.id));

  const sendRes = await fetch(`${BASE_URL}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!sendRes.ok) {
    const err = new Error(`prompt_async failed: ${sendRes.status}`);
    err.status = sendRes.status;
    throw err;
  }

  const startedAt = Date.now();
  let lastActivity = startedAt;
  let lastSig = "";
  let note = "";
  const toolsUsed = new Set();

  while (true) {
    const now = Date.now();
    const elapsedMs = now - startedAt;

    if (elapsedMs > MAX_TOTAL_MS) throw new AgentError(
      `Stopped after ${Math.round(MAX_TOTAL_MS / 60000)} minutes.`,
      "Task ran longer than the hard limit. Split it into smaller steps."
    );
    if (now - lastActivity > IDLE_TIMEOUT_MS) throw new AgentError(
      `No progress for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s.`,
      `Check \`docker logs ${CONTAINER_NAME}\`.`
    );

    await sleep(POLL_MS);

    if (AUTO_APPROVE) {
      const approved = await approvePendingPermissions(sessionId);
      if (approved.length) {
        note = `🔓 auto-approved: ${approved.join(", ")}`;
        lastActivity = Date.now();
      }
    }

    let messages;
    try { messages = await listMessages(sessionId); }
    catch (e) { if (e.status === 404) throw e; continue; }

    const fresh = messages.filter((m) => m.info?.role === "assistant" && !baseline.has(m.info.id));

    if (fresh.length === 0) {
      if (Date.now() - startedAt > NO_REPLY_MS) throw new AgentError(
        "The agent never started replying.",
        `Check \`docker logs ${CONTAINER_NAME}\` and your model/API key.`
      );
      onProgress({ text: "", status: "💭 thinking", note, elapsedMs });
      continue;
    }

    const errored = fresh.find((m) => m.info?.error);
    if (errored) {
      const msg = describeError(errored.info.error);
      const hint = /auth|api.?key|credential|401|403/i.test(msg)
        ? `Looks like an API key problem. Set a valid ANTHROPIC_API_KEY, then \`docker rm -f ${CONTAINER_NAME}\`.`
        : undefined;
      throw new AgentError(msg, hint);
    }

    const texts = [];
    let running = null;
    const sigParts = [];
    for (const m of fresh) {
      for (const p of m.parts || []) {
        if (p.type === "text" && p.text) { texts.push(p.text); sigParts.push(`t${p.text.length}`); }
        else if (p.type === "tool") {
          toolsUsed.add(p.tool);
          sigParts.push(`${p.tool}:${p.state?.status}`);
          if (p.state?.status === "running" || p.state?.status === "pending") running = p;
        }
      }
    }
    const combined = texts.join("\n\n").trim();
    const status = running ? `🔧 ${toolLabel(running)}` : combined ? "✍️ writing" : "💭 thinking";

    const sig = sigParts.join("|");
    if (sig !== lastSig) { lastSig = sig; lastActivity = Date.now(); }

    onProgress({ text: combined, status, note, elapsedMs });

    const last = fresh[fresh.length - 1];
    const finish = last.info?.finish;
    const done = !!last.info?.time?.completed && finish !== "tool-calls" && finish !== "unknown";
    if (done) return { text: combined, tools: [...toolsUsed], elapsedMs: Date.now() - startedAt };
  }
}