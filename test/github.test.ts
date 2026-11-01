import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, ConflictError, githubAppStore } from "../src/github";
import { serializeSettings, type Settings } from "../src/settings";

// GitHub App keys download as PKCS#1 PEM.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const settings: Settings = {
  model: "gpt-6.1-sol",
  effort: "",
  noFilter: false,
  exclude: [],
  maxTokensBudget: 0,
  timeoutMinutes: 0,
};

const config = {
  clientId: "Iv1.test",
  installationId: "42",
  privateKey,
  owner: "Timpan4",
  repo: "ocr-review",
  path: "settings.json",
  branch: "main",
};

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("GitHub App", () => {
  test("signs an RS256 JWT within GitHub's time rules", () => {
    const now = Date.UTC(2026, 10, 1, 12);
    const [header, payload, signature] = appJwt("Iv1.test", privateKey, now).split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload!)).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 600, iss: "Iv1.test" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  function fakeGitHub(putStatus: number, file = serializeSettings(settings)) {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" }, { status: 201 });
      if (method === "GET") return Response.json({ sha: "blob1", content: Buffer.from(file).toString("base64") });
      if (putStatus !== 200) return Response.json({ message: "conflict" }, { status: putStatus });
      return Response.json({ commit: { sha: "c".repeat(40), html_url: "https://github.com/x" } });
    }) as typeof fetch;
    return { calls, store: githubAppStore(config, fetchImpl) };
  }

  test("reads settings.json from the branch", async () => {
    const { calls, store } = fakeGitHub(200);
    expect(await store.read()).toEqual({ settings, problem: null, sha: "blob1" });
    expect(calls[1]?.url).toBe("https://api.github.com/repos/Timpan4/ocr-review/contents/settings.json?ref=main");
  });

  test("reports an invalid committed file instead of failing", async () => {
    const { store } = fakeGitHub(200, '{"model":"x"}');
    const file = await store.read();
    expect(file.settings).toBeNull();
    expect(file.problem).toContain("missing");
  });

  test("commits to the branch against the expected blob", async () => {
    const { calls, store } = fakeGitHub(200);
    const next = { ...settings, effort: "high" as const };
    const commit = await store.write(next, "blob1", "chore(settings): update effort");
    expect(commit.sha).toBe("c".repeat(40));
    const put = calls.find((call) => call.method === "PUT")?.body as Record<string, string>;
    expect(put.sha).toBe("blob1");
    expect(put.branch).toBe("main");
    expect(Buffer.from(put.content!, "base64").toString("utf8")).toBe(serializeSettings(next));
  });

  test("turns GitHub's 409 into a ConflictError", async () => {
    const { store } = fakeGitHub(409);
    await expect(store.write(settings, "stale", "m")).rejects.toBeInstanceOf(ConflictError);
  });
});
