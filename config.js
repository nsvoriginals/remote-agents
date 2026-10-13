import path from "path";
import dotenv from "dotenv";
dotenv.config();

export const IMAGE = "sprisa/opencode:latest";
export const CONTAINER_NAME = process.env.OPENCODE_CONTAINER_NAME || "opencode-agent";
export const PORT = Number(process.env.OPENCODE_PORT || 4096);
export const HOST_IP = process.env.HOST_IP || "127.0.0.1";
export const BASE_URL = `http://${HOST_IP}:${PORT}`;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "public";
export const WORKSPACE_DIR = path.resolve(process.env.WORKSPACE_DIR || "./workspace");
export const SESSIONS_FILE = path.resolve("./sessions.json");
export const AUTO_APPROVE = (process.env.AUTO_APPROVE ?? "true").toLowerCase() !== "false";

export const POLL_MS = 1000;
export const UPDATE_INTERVAL_MS = 2500;
export const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
export const MAX_TOTAL_MS = 20 * 60 * 1000;
export const NO_REPLY_MS = 90 * 1000;
export const SLACK_CHUNK = 3500;

export const HEADERS = { "User-Agent": "opencode/1.0.0" };