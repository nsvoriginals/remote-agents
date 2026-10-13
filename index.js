import pkg from "@slack/bolt";
const { App } = pkg;
import { ensureReady } from "./src/docker.js";
import { makeHandler } from "./src/handler.js";
import { AUTO_APPROVE } from "./config.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

let botUserId = null;
let handle;

app.event("app_mention", async ({ event, client }) => handle(event, client));
app.message(async ({ message, client }) => handle(message, client));

(async () => {
  await app.start();
  botUserId = (await app.client.auth.test()).user_id;
  handle = makeHandler(botUserId);
  console.log(`⚡ Slack bot running (bot user ${botUserId})`);
  console.log(`[config] auto-approve permissions: ${AUTO_APPROVE}`);

  ensureReady()
    .then(() => console.log("[docker] agent ready"))
    .catch((e) => console.error("[docker] warm-up failed:", e.message));
})();