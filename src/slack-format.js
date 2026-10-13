import { SLACK_CHUNK } from "../config.js";

export function toSlack(md) {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((chunk, i) => i % 2 === 1 ? chunk : chunk
      .replace(/^#{1,6}\s+(.*)$/gm, "*$1*")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>"))
    .join("");
}

export function chunkText(text, size = SLACK_CHUNK) {
  const out = [];
  let rest = text;
  let reopen = false;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).trimStart();
    if (reopen) piece = "```\n" + piece;
    const open = (piece.match(/```/g) || []).length % 2 === 1;
    if (open) { piece += "\n```"; reopen = true; } else { reopen = false; }
    out.push(piece);
  }
  if (rest) out.push(reopen ? "```\n" + rest : rest);
  return out;
}

const fmtSecs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const ctx = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const md = (text) => ({ type: "markdown", text });

export function msgWorking({ text, status, note, elapsedMs }) {
  const body = text ? text.slice(-SLACK_CHUNK) : "";
  const footer = [status, note, `⏱ ${fmtSecs(elapsedMs ?? 0)}`].filter(Boolean).join("  ·  ");
  return { text: body ? toSlack(body) : "Working…", blocks: [...(body ? [md(body)] : []), ctx(footer)] };
}

export function msgFinal(chunk, footer) {
  return { text: toSlack(chunk), blocks: [md(chunk), ...(footer ? [ctx(footer)] : [])] };
}

export function msgError(message, hint) {
  const text = `❌ *Something went wrong*\n${message}`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      ...(hint ? [ctx(`💡 ${hint}`)] : []),
    ],
  };
}

export function msgInfo(text) {
  return { text, blocks: [ctx(text)] };
}