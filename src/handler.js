import { ensureReady } from "./docker.js";
import { isHealthy, getOrCreateSession, runPrompt } from "./opencode.js";
import * as sessions from "./sessions.js";
import { slackPost, slackUpdate, react } from "./slack-client.js";
import { msgWorking, msgFinal, msgError, msgInfo, chunkText } from "./slack-format.js";
import { UPDATE_INTERVAL_MS } from "../config.js";

const fmtSecs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function makeHandler(botUserId) {
  const seen = new Map();
  const queues = new Map();

  function alreadySeen(id) {
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    if (seen.size > 1000) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
    }
    return false;
  }

  function enqueue(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  }

  function handle(event, client) {
    try {
      if (event.bot_id || event.user === botUserId) return;
      if (event.subtype && event.subtype !== "file_share") return;
      if (!event.text) return;
      if (alreadySeen(`${event.channel}:${event.ts}`)) return;

      const isDM = event.channel_type === "im";
      const threadTs = event.thread_ts || event.ts;
      const key = isDM ? event.channel : `${event.channel}:${threadTs}`;
      const mentioned = event.text.includes(`<@${botUserId}>`);
      if (!isDM && !mentioned && !sessions.get(key)) return;

      const text = event.text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
      if (!text) return;

      const replyThread = isDM ? undefined : threadTs;
      react(client, event.channel, event.ts, "eyes");

      enqueue(key, () => processMessage({ key, text, channel: event.channel, thread_ts: replyThread, eventTs: event.ts, client }))
        .catch((e) => console.error("[handle] unexpected:", e));
    } catch (e) {
      console.error("[handle] error:", e);
    }
  }

  async function processMessage({ key, text, channel, thread_ts, eventTs, client }) {
    if (/^(reset|\/reset|new session)$/i.test(text)) {
      sessions.del(key);
      await slackPost(client, channel, thread_ts, msgInfo("🔄 Session reset. Your next message starts fresh."));
      await react(client, channel, eventTs, "eyes", true);
      await react(client, channel, eventTs, "white_check_mark");
      return;
    }

    const healthy = await isHealthy();
    const placeholder = await slackPost(client, channel, thread_ts,
      msgInfo(healthy ? "💭 Thinking…" : "🤖 Waking up the agent (one-time boot, can take a minute)…"));
    const update = (msg) => slackUpdate(client, channel, placeholder.ts, msg);

    try {
      if (!healthy) await ensureReady();
      const sessionId = await getOrCreateSession(key, `slack ${key}`);

      let lastUpdate = 0;
      let lastBody = "";
      let pending = Promise.resolve();
      const onProgress = (p) => {
        const now = Date.now();
        if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
        const msg = msgWorking(p);
        if (msg.text === lastBody && !p.status) return;
        lastUpdate = now;
        lastBody = msg.text;
        pending = pending.then(() => update(msg)).catch(() => {});
      };

      let result;
      try { result = await runPrompt(sessionId, text, onProgress); }
      catch (e) {
        if (e.status === 404) {
          sessions.del(key);
          const newId = await getOrCreateSession(key, `slack ${key}`);
          result = await runPrompt(newId, text, onProgress);
        } else throw e;
      }

      await pending;

      const footer = `✅ Done in ${fmtSecs(result.elapsedMs)}` + (result.tools.length ? `  ·  🔧 ${result.tools.join(", ")}` : "");
      const chunks = chunkText(result.text || "Done — the agent finished without any text reply.");
      await update(msgFinal(chunks[0], chunks.length === 1 ? footer : undefined));
      for (let i = 1; i < chunks.length; i++) {
        await slackPost(client, channel, thread_ts, msgFinal(chunks[i], i === chunks.length - 1 ? footer : undefined));
      }

      await react(client, channel, eventTs, "eyes", true);
      await react(client, channel, eventTs, "white_check_mark");
    } catch (e) {
      console.error("[process] error:", e);
      await update(msgError(e.message, e.hint)).catch(() => {});
      await react(client, channel, eventTs, "eyes", true);
      await react(client, channel, eventTs, "x");
    }
  }

  return handle;
}