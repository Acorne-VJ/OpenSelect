import { expect, test } from 'bun:test';
import { Runtime } from '../src/state';
import { startDashboard } from '../src/dashboard';
import { loadCatalog } from '../src/catalog';
import type { Config } from '../src/types';

test('dashboard emits syntactically valid language switch and client scripts', async () => {
  const config: Config = {version:1, upstream:{base:'http://127.0.0.1:1'}, proxy:{host:'127.0.0.1',port:0}, dashboard:{host:'127.0.0.1',port:0}, policy:{switchAt:0.97,maxAttempts:4,cooldownFallbackSec:300,sessionTtlSec:7200}, monitor:{pollSec:45}, opencode:{autoActivate:false}, accounts:[]};
  const server = startDashboard(new Runtime(config, await loadCatalog()), {port:0});
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.server.port}/`)).text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
    expect(html).toContain('openselect.language');
    expect(html).toContain('languageSwitch');
  } finally { server.stop(); }
});
