import { readFileSync } from "node:fs";
import { githubAppStore } from "./github";
import { createHandler } from "./server";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

const [owner, repo] = required("SETTINGS_REPO").split("/");
if (!owner || !repo) throw new Error("SETTINGS_REPO must look like owner/repo.");

const handler = createHandler({
  publicOrigin: required("PUBLIC_ORIGIN"),
  repoLabel: `${owner}/${repo}`,
  store: githubAppStore({
    clientId: required("GITHUB_APP_CLIENT_ID"),
    installationId: required("GITHUB_APP_INSTALLATION_ID"),
    privateKey: readFileSync(required("GITHUB_APP_PRIVATE_KEY_FILE"), "utf8"),
    owner,
    repo,
    path: process.env.SETTINGS_PATH ?? "settings.json",
    branch: process.env.SETTINGS_BRANCH ?? "main",
  }),
});

// Listens on loopback by default: oauth2-proxy in the same pod is the only caller,
// and it supplies the signed-in user's headers.
const server = Bun.serve({
  hostname: process.env.LISTEN_HOST ?? "127.0.0.1",
  port: Number(process.env.LISTEN_PORT ?? "8080"),
  fetch: async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      console.error(error);
      return new Response("Internal error. See the ocr-settings container log.", { status: 500 });
    }
  },
});
console.log(`ocr-settings listening on ${server.url}`);

// As PID 1 in a container, the process gets no default SIGTERM handling.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
