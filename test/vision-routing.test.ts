import { expect, test } from "bun:test";
import { join } from "node:path";

test("coding-auto announces image input and forwards an image to OpenCode Go", async () => {
  // Proxy tests alter process-global fetch and share the cached DB/catalog.
  // Keep this HTTP integration fixture in its own runtime, including its env.
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures/vision-routing.ts")], {
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
  } finally { clearTimeout(timer); child.kill(); }
});
