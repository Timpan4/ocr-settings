import { createSign } from "node:crypto";
import { parseSettings, serializeSettings, type Settings, SettingsError } from "./settings";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";

export interface SettingsFile {
  /** Parsed settings, or null when the committed file is invalid. */
  settings: Settings | null;
  /** Why the committed file is invalid, when settings is null. */
  problem: string | null;
  /** Blob SHA of the file, used to reject saves over a newer commit. */
  sha: string;
}

export interface SavedCommit {
  sha: string;
  url: string;
}

export interface SettingsStore {
  read(): Promise<SettingsFile>;
  write(settings: Settings, expectedSha: string, message: string): Promise<SavedCommit>;
}

/** The file changed on the branch after the page was loaded. */
export class ConflictError extends Error {}

export interface GitHubAppConfig {
  clientId: string;
  installationId: string;
  privateKey: string;
  owner: string;
  repo: string;
  path: string;
  branch: string;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/** App JWT per GitHub's rules: RS256, iat 60 s back for clock drift, exp at most 10 minutes ahead. */
export function appJwt(clientId: string, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 10 * 60, iss: clientId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

async function expectOk(response: Response, action: string): Promise<Response> {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub ${action} failed: ${response.status} ${detail}`);
  }
  return response;
}

export function githubAppStore(config: GitHubAppConfig, fetchImpl: typeof fetch = fetch): SettingsStore {
  const fileUrl = `${API}/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  const headers = (token: string) => ({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  });

  // A fresh installation token per request: the page is used rarely, and this
  // avoids caching a credential.
  async function installationToken(): Promise<string> {
    const response = await fetchImpl(`${API}/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      headers: headers(appJwt(config.clientId, config.privateKey)),
    });
    const body = (await (await expectOk(response, "installation token")).json()) as { token: string };
    return body.token;
  }

  return {
    async read() {
      const token = await installationToken();
      const response = await fetchImpl(`${fileUrl}?ref=${encodeURIComponent(config.branch)}`, {
        headers: headers(token),
      });
      const body = (await (await expectOk(response, "read settings.json")).json()) as {
        sha: string;
        content: string;
      };
      const text = Buffer.from(body.content, "base64").toString("utf8");
      try {
        return { settings: parseSettings(JSON.parse(text)), problem: null, sha: body.sha };
      } catch (error) {
        if (error instanceof SettingsError || error instanceof SyntaxError) {
          return { settings: null, problem: error.message, sha: body.sha };
        }
        throw error;
      }
    },

    async write(settings, expectedSha, message) {
      const token = await installationToken();
      const response = await fetchImpl(fileUrl, {
        method: "PUT",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: Buffer.from(serializeSettings(settings), "utf8").toString("base64"),
          sha: expectedSha,
          branch: config.branch,
        }),
      });
      if (response.status === 409) {
        throw new ConflictError("settings.json changed on GitHub after this page was loaded.");
      }
      const body = (await (await expectOk(response, "write settings.json")).json()) as {
        commit: { sha: string; html_url: string };
      };
      return { sha: body.commit.sha, url: body.commit.html_url };
    },
  };
}
