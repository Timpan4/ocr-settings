import { describe, expect, test } from "bun:test";
import { ConflictError, type SettingsFile, type SettingsStore } from "../src/github";
import { createHandler } from "../src/server";
import type { Settings } from "../src/settings";

const ORIGIN = "https://ocr.timpan.dev";
const SHA = "a".repeat(40);
const COMMIT = "c".repeat(40);

const current: Settings = {
  model: "gpt-6.1-sol",
  effort: "",
  noFilter: false,
  exclude: [],
  maxTokensBudget: 0,
  timeoutMinutes: 0,
};

function fakeStore(file: Partial<SettingsFile> = {}, onWrite?: () => never) {
  const writes: { settings: Settings; sha: string; message: string }[] = [];
  const store: SettingsStore = {
    read: async () => ({ settings: current, problem: null, sha: SHA, ...file }),
    write: async (settings, sha, message) => {
      onWrite?.();
      writes.push({ settings, sha, message });
      return { sha: COMMIT, url: `https://github.com/Timpan4/ocr-review/commit/${COMMIT}` };
    },
  };
  return { store, writes };
}

function form(fields: Record<string, string>, origin = ORIGIN, path = "/settings/") {
  return new Request(`http://127.0.0.1:8080${path}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-Email": "tim@example.com" },
    body: new URLSearchParams(fields),
  });
}

const valid = { sha: SHA, model: "gpt-6.1-sol", effort: "high", exclude: "dist/**\n\n *.lock \n", maxTokensBudget: "500000", timeoutMinutes: "30" };

function handler(store: SettingsStore) {
  return createHandler({ store, publicOrigin: ORIGIN, repoLabel: "Timpan4/ocr-review" });
}

describe("settings page", () => {
  test("shows the committed values with or without the /settings prefix", async () => {
    const { store } = fakeStore({ settings: { ...current, exclude: ["<script>"] } });
    for (const path of ["/settings/", "/"]) {
      const response = await handler(store)(new Request(`http://127.0.0.1:8080${path}`));
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('value="gpt-6.1-sol"');
      expect(body).toContain("&lt;script&gt;");
      expect(body).not.toContain("<script>");
    }
  });

  test("saving commits only the changed keys and names the signed-in user", async () => {
    const { store, writes } = fakeStore();
    const response = await handler(store)(form(valid));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/settings/?saved=${COMMIT}`);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sha).toBe(SHA);
    expect(writes[0]?.settings).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
      noFilter: false,
      exclude: ["dist/**", "*.lock"],
      maxTokensBudget: 500000,
      timeoutMinutes: 30,
    });
    expect(writes[0]?.message).toStartWith("chore(settings): update effort, exclude, maxTokensBudget, timeoutMinutes");
    expect(writes[0]?.message).toContain("Saved by tim@example.com");
  });

  test("an unchanged form commits nothing", async () => {
    const { store, writes } = fakeStore();
    const response = await handler(store)(form({ sha: SHA, model: "gpt-6.1-sol", effort: "", exclude: "", maxTokensBudget: "0", timeoutMinutes: "0" }));
    expect(response.headers.get("location")).toBe(`${ORIGIN}/settings/?unchanged=1`);
    expect(writes).toHaveLength(0);
  });

  test("refuses a cross-origin or origin-less POST", async () => {
    const { store, writes } = fakeStore();
    expect((await handler(store)(form(valid, "https://evil.example"))).status).toBe(403);
    const noOrigin = new Request("http://127.0.0.1:8080/settings/", { method: "POST", body: new URLSearchParams(valid) });
    expect((await handler(store)(noOrigin)).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  test("rejects invalid values without committing", async () => {
    const { store, writes } = fakeStore();
    for (const bad of [
      { ...valid, model: "$(id)" },
      { ...valid, effort: "max" },
      { ...valid, exclude: "a,b" },
      { ...valid, exclude: "src/**\u0000--no-filter" },
      { ...valid, maxTokensBudget: "-1" },
      { ...valid, timeoutMinutes: "1.5" },
      { ...valid, timeoutMinutes: "61" },
    ]) {
      const response = await handler(store)(form(bad));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Not saved:");
    }
    expect(writes).toHaveLength(0);
  });

  test("refuses to overwrite a newer commit", async () => {
    const { store, writes } = fakeStore({ sha: "b".repeat(40) });
    const response = await handler(store)(form(valid));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("changed on GitHub");
    expect(writes).toHaveLength(0);
  });

  test("reports a conflict that GitHub detects during the write", async () => {
    const { store } = fakeStore({}, () => {
      throw new ConflictError("settings.json changed on GitHub after this page was loaded.");
    });
    const response = await handler(store)(form(valid));
    expect(response.status).toBe(409);
  });

  test("an invalid committed file still renders, with defaults to save over it", async () => {
    const { store } = fakeStore({ settings: null, problem: "settings.json has an unknown key: modle." });
    const body = await (await handler(store)(new Request("http://127.0.0.1:8080/settings/"))).text();
    expect(body).toContain("The committed settings.json is invalid");
    expect(body).toContain('value="gpt-6.1-sol"');
  });

  test("ignores a malformed saved commit id", async () => {
    const { store } = fakeStore();
    const body = await (await handler(store)(new Request(`http://127.0.0.1:8080/settings/?saved="><b>x`))).text();
    expect(body).not.toContain("Saved as");
    expect(body).not.toContain("<b>x");
  });
});
