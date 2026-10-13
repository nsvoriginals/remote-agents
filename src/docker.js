import Docker from "dockerode";
import { mkdirSync } from "fs";
import { IMAGE, CONTAINER_NAME, PORT, ANTHROPIC_API_KEY, WORKSPACE_DIR } from "../config.js";
import { isHealthy, waitForHealth } from "./opencode.js";

const docker = new Docker();
mkdirSync(WORKSPACE_DIR, { recursive: true });

async function imageExists() {
  try { await docker.getImage(IMAGE).inspect(); return true; } catch { return false; }
}

function pullImage() {
  return new Promise((resolve, reject) => {
    docker.pull(IMAGE, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve()));
    });
  });
}

async function bootContainer() {
  let container = docker.getContainer(CONTAINER_NAME);
  let info = null;
  try { info = await container.inspect(); }
  catch (e) { if (e.statusCode !== 404) throw e; }

  if (!info) {
    if (!(await imageExists())) {
      console.log("[docker] pulling image...");
      await pullImage();
    }
    console.log("[docker] creating container...");
    container = await docker.createContainer({
      name: CONTAINER_NAME,
      Image: IMAGE,
      Env: [`ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`, `OPENCODE_PORT=${PORT}`],
      ExposedPorts: { [`${PORT}/tcp`]: {} },
      WorkingDir: "/workspace",
      HostConfig: {
        Binds: [`${WORKSPACE_DIR}:/workspace`],
        PortBindings: { [`${PORT}/tcp`]: [{ HostPort: String(PORT) }] },
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    await container.start();
  } else if (!info.State.Running) {
    console.log("[docker] starting existing container...");
    await container.start();
  }

  await waitForHealth();
}

let bootPromise = null;
export async function ensureReady() {
  if (await isHealthy()) return;
  bootPromise ??= bootContainer().finally(() => (bootPromise = null));
  await bootPromise;
}