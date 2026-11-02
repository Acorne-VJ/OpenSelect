/**
 * 测试统一预加载（bunfig.toml: [test] preload）。
 *
 * 目的：bun 的测试文件在**同一进程**内共享模块注册表，而 src/config.ts 在 import 时就捕获了
 * HOME（进而决定 ~/.openselect 下的 config/台账路径）。若某个测试文件没有设置 HOME，
 * 就会直接落到**生产** ~/.openselect（EVT-20261020-005 曾真实发生测试写生产台账）。
 *
 * 这里在所有测试文件之前把 HOME 指向一个临时目录作为兜底：各测试文件仍可在自己的文件头
 * 覆盖 HOME（保持既有的按文件隔离习惯），未设置 HOME 的文件则落到这个临时目录，
 * 从而保证测试**永远不会**写到生产 ~/.openselect，且与文件执行顺序无关。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-test-home-"));
