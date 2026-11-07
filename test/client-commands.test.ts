import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routesPage } from "../src/routes";

test("route page commands use coding-auto and the configured proxy port", () => {
  const elements = new Map<string, { textContent: string; innerHTML: string }>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "" });
      return elements.get(id)!;
    },
  };
  const page = routesPage();
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((source) => source.includes("function render(d)"))!;
  const functions = script.slice(0, script.indexOf('document.querySelectorAll("[data-copy-command]")'));
  const render = new Function("document", "osT", "osLang", functions + "; return render;")(
    document, (zh: string) => zh, "zh",
  );
  render({ now: Date.now(), timezone: "UTC", base: { usdPerMillion: 1 }, proxyPort: 18788,
    codingAutoOrder: ["opencode"], providers: [], candidates: [], plans: [], lastErrors: [] });

  const home = mkdtempSync(join(tmpdir(), "openselect-client-test-"));
  try {
    for (const [id, name, client] of [
      ["piCommand", "pi-auto", "pi"],
      ["opencodeCommand", "opencode-auto", "opencode"],
      ["hermesCommand", "hermes-auto", "hermes"],
    ]) {
      expect(page).toContain(`data-copy-command="${id}"`);
      const command = elements.get(id)!.textContent;
      const stub = `${client}() { printf '%s\\n' "$*" "\${PI_CODING_AGENT_DIR:-}" "\${OPENCODE_CONFIG_CONTENT:-}" "\${HERMES_HOME:-}"; }; `;
      const result = Bun.spawnSync(["bash", "-c", `${stub}${command}; ${name} --example`], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("coding-auto");
      expect(result.stdout.toString()).toContain("--example");
      if (client === "opencode") {
        const config = JSON.parse(result.stdout.toString().split("\n")[2]);
        expect(config.provider.openselect.options.baseURL).toBe("http://127.0.0.1:18788/v1");
        expect(config.provider.openselect.models["coding-auto"].modalities.input).toEqual(["text", "image"]);
        expect(config.provider.openselect.models["coding-auto"].limit).toEqual({context:1000000,output:32768});
        expect(config.provider.openselect.options.headers["x-openselect-context-window"]).toBe("1000000");
      }
    }
    const pi = JSON.parse(readFileSync(join(home, ".config/openselect/pi/models.json"), "utf8"));
    expect(pi.providers.openselect).toMatchObject({ baseUrl: "http://127.0.0.1:18788", api: "anthropic-messages", models: [{ id: "coding-auto", contextWindow: 1000000, maxTokens: 32768, input: ["text", "image"], reasoning: true, compat: { forceAdaptiveThinking: true, allowEmptySignature: true } }] });
    // Launching a saved alias must not restore an outdated model declaration.
    const piCommand = elements.get("piCommand")!.textContent;
    const retained = '{"custom":"preserved"}';
    const piLaunch = Bun.spawnSync(["bash", "-c",
      `pi() { :; }; ${piCommand}; printf '%s' '${retained}' > "$HOME/.config/openselect/pi/models.json"; pi-auto`], {
      env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    expect(piLaunch.exitCode).toBe(0);
    expect(readFileSync(join(home, ".config/openselect/pi/models.json"), "utf8")).toBe(retained);
    const hermes = JSON.parse(readFileSync(join(home, ".config/openselect/hermes/config.yaml"), "utf8"));
    expect(hermes.providers.openselect).toMatchObject({ api: "http://127.0.0.1:18788", transport: "anthropic_messages" });
    expect(hermes.model.supports_vision).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
