import { readFileSync, writeFileSync, renameSync } from "fs";
import { SESSIONS_FILE } from "../config.js";

let sessions = {};
try {
  sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
} catch {}

export function get(key) {
  return sessions[key];
}

export function set(key, value) {
  sessions[key] = value;
  save();
}

export function del(key) {
  delete sessions[key];
  save();
}

export function all() {
  return sessions;
}

function save() {
  const tmp = `${SESSIONS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  renameSync(tmp, SESSIONS_FILE);
}