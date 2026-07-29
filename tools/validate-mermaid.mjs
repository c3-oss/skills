#!/usr/bin/env node
// Validate the syntax of every ```mermaid fenced block in the given markdown
// files (or all tracked *.md when no args) with mermaid v11's parser under a
// jsdom DOM shim. Browser-free: no Chromium, no mmdc. Exits 1 on any error.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";

// mermaid v11 reads window/document/DOMParser at import and during parse, so the
// shim must exist before the dynamic import below.
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLAnchorElement = dom.window.HTMLAnchorElement;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.navigator ??= dom.window.navigator;

const { default: mermaid } = await import("mermaid");
mermaid.initialize({ startOnLoad: false, logLevel: "fatal", securityLevel: "strict" });

function targetFiles() {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;

// Returns [{ startLine, code }] where startLine is the 1-based line of the first
// content line after the opening ```mermaid fence.
function extractMermaidBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (open) {
      const isClose = m && m[2][0] === open.marker && m[2].length >= open.len && m[3] === "";
      if (isClose) {
        if (open.lang === "mermaid") blocks.push({ startLine: open.startLine, code: open.buf.join("\n") });
        open = null;
        continue;
      }
      open.buf.push(lines[i]);
      continue;
    }
    if (m) open = { marker: m[2][0], len: m[2].length, lang: m[3].toLowerCase(), startLine: i + 2, buf: [] };
  }
  if (open && open.lang === "mermaid" && open.buf.length) {
    blocks.push({ startLine: open.startLine, code: open.buf.join("\n") });
  }
  return blocks;
}

let fileCount = 0;
let blockCount = 0;
const errors = [];

for (const file of targetFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    errors.push({ file, line: 0, message: `cannot read file: ${e.message}` });
    continue;
  }
  const blocks = extractMermaidBlocks(text);
  if (blocks.length === 0) continue;
  fileCount++;
  for (const { startLine, code } of blocks) {
    if (code.trim() === "") continue;
    blockCount++;
    try {
      await mermaid.parse(code);
    } catch (e) {
      const message = (e && (e.message || e.str)) || String(e);
      errors.push({ file, line: startLine, message: message.trim() });
    }
  }
}

if (errors.length) {
  console.error("Mermaid validation failed:\n");
  for (const { file, line, message } of errors) {
    console.error(`${file}:${line}`);
    console.error(`  ${message.replace(/\n/g, "\n  ")}\n`);
  }
}
console.error(
  `mermaid: ${fileCount} file(s) with diagrams, ${blockCount} block(s) checked, ${errors.length} error(s).`,
);
process.exit(errors.length ? 1 : 0);
