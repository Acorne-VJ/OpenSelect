import { collectTimePricing } from "../src/time_pricing";

const result = await collectTimePricing();
console.log(JSON.stringify({ ok: result.ok, lastRun: result.lastRun, updated: result.updated, errors: result.errors }, null, 2));
if (!result.ok) process.exitCode = 1;
