import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-wire-"));

const { wireConfigFile, unwireConfigFile, buildPrevMap, journalStale, parseConfigText, stripJsonComments } = await import("../src/wire");

const BASE = "http://127.0.0.1:8788";

test("wire + unwire round-trip preserves unrelated config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openselect-wire-"));
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "opencode-go/glm-5.2",
        providers: { other: { models: { x: { settings: { baseURL: "http://keep.me" } } } } },
      },
      null,
      2,
    ),
  );

  const res = await wireConfigFile({ path, baseURL: BASE, modelIds: ["glm-5.2", "grok-4.7"] });
  expect(res.changed).toBe(2);
  expect(res.backup).toBeTruthy();

  const doc = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(doc.providers["opencode-go"].models["glm-5.2"].settings.baseURL).toBe(BASE);
  expect(doc.providers["opencode-go"].models["grok-4.7"].settings.baseURL).toBe(BASE);
  expect(doc.providers.other.models.x.settings.baseURL).toBe("http://keep.me");
  expect(doc.model).toBe("opencode-go/glm-5.2");

  // idempotent
  const res2 = await wireConfigFile({ path, baseURL: BASE, modelIds: ["glm-5.2", "grok-4.7"] });
  expect(res2.changed).toBe(0);

  const un = await unwireConfigFile({ path, baseURL: BASE });
  expect(un.removed).toBe(2);

  const doc2 = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(doc2.providers?.["opencode-go"]).toBeUndefined();
  expect(doc2.providers.other.models.x.settings.baseURL).toBe("http://keep.me");
});

test("unwire only removes our baseURL, keeps foreign overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openselect-wire-"));
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "opencode-go": {
          models: {
            "glm-5.2": { settings: { baseURL: BASE } },
            "grok-4.7": { settings: { baseURL: "http://someone.else" } },
          },
        },
      },
    }),
  );
  const un = await unwireConfigFile({ path, baseURL: BASE });
  expect(un.removed).toBe(1);
  const doc = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(doc.providers["opencode-go"].models["grok-4.7"].settings.baseURL).toBe("http://someone.else");
  expect(doc.providers["opencode-go"].models["glm-5.2"]).toBeUndefined();
});

test("jsonc comments and trailing commas are tolerated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openselect-wire-"));
  const path = join(dir, "opencode.jsonc");
  writeFileSync(
    path,
    `{
  // 注释
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/glm-5.2", /* block */
  "providers": {},
}
`,
  );
  const doc = parseConfigText(readFileSync(path, "utf8")) as any;
  expect(doc.model).toBe("opencode-go/glm-5.2");
  const res = await wireConfigFile({ path, baseURL: BASE, modelIds: ["glm-5.2"] });
  expect(res.changed).toBe(1);
  // rewritten as strict JSON but content preserved
  const after = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(after.providers["opencode-go"].models["glm-5.2"].settings.baseURL).toBe(BASE);
});

test("stripJsonComments does not touch string contents", () => {
  const text = '{"url":"http://x//y","s":"a, } b"}';
  const out = stripJsonComments(text);
  expect(JSON.parse(out).url).toBe("http://x//y");
  expect(JSON.parse(out).s).toBe("a, } b");
});

test("unwire restores pre-wire baseURL from journal (reversible)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openselect-wire-"));
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "opencode-go": {
          models: {
            "glm-5.2": { settings: { baseURL: "https://orig.example/v1" } },
            "grok-4.7": {},
          },
        },
      },
    }),
  );
  const res = await wireConfigFile({ path, baseURL: BASE, modelIds: ["glm-5.2", "grok-4.7"] });
  expect(res.changed).toBe(2);
  expect(res.before["glm-5.2"]).toBe("https://orig.example/v1");
  expect(res.before["grok-4.7"]).toBeUndefined();

  const prev = buildPrevMap(res.before, null, BASE);
  expect(prev).toEqual({ "glm-5.2": "https://orig.example/v1", "grok-4.7": null });

  const un = await unwireConfigFile({ path, baseURL: BASE, prev });
  expect(un.removed).toBe(2);
  expect(un.restored).toBe(1);
  const doc = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(doc.providers["opencode-go"].models["glm-5.2"].settings.baseURL).toBe("https://orig.example/v1");
  expect(doc.providers["opencode-go"].models["grok-4.7"]).toBeUndefined();
});

test("unwire leaves manually modified entries untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openselect-wire-"));
  const path = join(dir, "opencode.json");
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "opencode-go": {
          models: { "glm-5.2": { settings: { baseURL: "https://orig.example/v1" } }, "grok-4.7": {} },
        },
      },
    }),
  );
  const res = await wireConfigFile({ path, baseURL: BASE, modelIds: ["glm-5.2", "grok-4.7"] });
  const prev = buildPrevMap(res.before, null, BASE);

  // user edits one model after wiring
  const doc = JSON.parse(readFileSync(path, "utf8")) as any;
  doc.providers["opencode-go"].models["glm-5.2"].settings.baseURL = "https://user.example";
  writeFileSync(path, JSON.stringify(doc, null, 2));

  const un = await unwireConfigFile({ path, baseURL: BASE, prev });
  expect(un.removed).toBe(1);
  expect(un.restored).toBe(0);
  const after = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(after.providers["opencode-go"].models["glm-5.2"].settings.baseURL).toBe("https://user.example");
  expect(after.providers["opencode-go"].models["grok-4.7"]).toBeUndefined();
});

test("buildPrevMap keeps original value across idempotent re-wire", () => {
  const prior = {
    baseURL: BASE,
    configPath: "/tmp/x.json",
    models: ["glm-5.2"],
    wiredAt: 1,
    prev: { "glm-5.2": "https://orig.example/v1" },
  };
  expect(buildPrevMap({ "glm-5.2": BASE }, prior, BASE)).toEqual({ "glm-5.2": "https://orig.example/v1" });
  expect(buildPrevMap({ "grok-4.7": undefined }, prior, BASE)).toEqual({ "grok-4.7": null });
});

test("buildPrevMap recognizes an older proxy URL (A→B migration) and old-schema journals", () => {
  const A = "http://127.0.0.1:8788";
  const B = "http://127.0.0.1:9999";
  const prior = {
    baseURL: A,
    configPath: "/tmp/x.json",
    models: ["glm-5.2"],
    wiredAt: 1,
    prev: { "glm-5.2": "https://orig.example/v1" },
  };
  // current value is the old proxy URL → keep the true original, not the old proxy URL
  expect(buildPrevMap({ "glm-5.2": A }, prior, B)).toEqual({ "glm-5.2": "https://orig.example/v1" });
  // genuine third-party value still wins
  expect(buildPrevMap({ "glm-5.2": "https://user.example" }, prior, B)).toEqual({ "glm-5.2": "https://user.example" });

  // pre-`prev` journal: original unknown → null (legacy delete-on-unwire behavior)
  const oldSchema = { baseURL: A, configPath: "/tmp/x.json", models: ["glm-5.2"], wiredAt: 1 };
  expect(buildPrevMap({ "glm-5.2": A }, oldSchema, A)).toEqual({ "glm-5.2": null });
});

test("journalStale detects old schema, new models and proxy URL changes", () => {
  expect(journalStale(null, ["glm-5.2"], BASE)).toBe(true);
  const oldSchema = { baseURL: BASE, configPath: "/tmp/x.json", models: ["glm-5.2"], wiredAt: 1 };
  expect(journalStale(oldSchema, ["glm-5.2"], BASE)).toBe(true);
  const full = { ...oldSchema, prev: { "glm-5.2": null } };
  expect(journalStale(full, ["glm-5.2"], BASE)).toBe(false);
  expect(journalStale(full, ["glm-5.2", "grok-4.7"], BASE)).toBe(true);
  expect(journalStale(full, ["glm-5.2"], "http://127.0.0.1:9999")).toBe(true);
});

test("A→B proxy migration: second wire keeps the true original and unwire B restores it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openselect-wire-"));
  const path = join(dir, "opencode.json");
  const A = "http://127.0.0.1:8788";
  const B = "http://127.0.0.1:9999";
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        "opencode-go": { models: { "glm-5.2": { settings: { baseURL: "https://orig.example/v1" } } } },
      },
    }),
  );

  const resA = await wireConfigFile({ path, baseURL: A, modelIds: ["glm-5.2"] });
  const prior = {
    baseURL: A,
    configPath: path,
    models: ["glm-5.2"],
    wiredAt: 1,
    prev: buildPrevMap(resA.before, null, A),
  };
  expect(prior.prev["glm-5.2"]).toBe("https://orig.example/v1");

  const resB = await wireConfigFile({ path, baseURL: B, modelIds: ["glm-5.2"] });
  expect(resB.before["glm-5.2"]).toBe(A);
  const newPrev = buildPrevMap(resB.before, prior, B);
  expect(newPrev["glm-5.2"]).toBe("https://orig.example/v1");

  const un = await unwireConfigFile({ path, baseURL: B, prev: newPrev });
  expect(un.removed).toBe(1);
  expect(un.restored).toBe(1);
  const doc = JSON.parse(readFileSync(path, "utf8")) as any;
  expect(doc.providers["opencode-go"].models["glm-5.2"].settings.baseURL).toBe("https://orig.example/v1");
});
