#!/usr/bin/env node
/**
 * Render a Markdown doc to the repo's standalone HTML template (inline CSS,
 * serif ~44rem column, light/dark, print rules) — the same look used for
 * docs/superpowers/specs/2026-07-27-tokenops-design.html.
 *
 * Human-readable docs (README, specs, design memos) ship as both .md and
 * .html per repo convention. Markdown is for editing/diffing; this script
 * produces the HTML for reading.
 *
 * Uses the `marked` library directly (a repo devDependency — `pnpm install`
 * is all that's needed; nothing is fetched at generation time), and injects
 * GitHub-style heading `id`s so in-page anchors like `[Web](#web-appsweb)`
 * that work on GitHub's rendered README also resolve in the standalone HTML
 * (marked itself does not emit heading ids).
 *
 * Usage (from repo root, after `pnpm install`):
 *   node scripts/build-doc-html.mjs README.md README.html [title]
 *
 * If [title] is omitted, the title is taken from the rendered body's first <h1>.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const [, , inputPath, outputPath, titleArg] = process.argv;

if (!inputPath || !outputPath) {
  console.error(
    "Usage: node scripts/build-doc-html.mjs <markdown-in> <html-out> [title]",
  );
  process.exit(1);
}

const markdown = readFileSync(inputPath, "utf8");
const bodyRaw = marked.parse(markdown, { gfm: true }).trim();

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * GitHub's heading-anchor slug rules: lowercase, strip a fixed set of ASCII
 * punctuation (no hyphen inserted in its place), collapse whitespace to
 * hyphens, and de-duplicate repeats with a `-1`, `-2`, ... suffix — the same
 * rules GitHub applies when rendering README.md, so links like
 * `[Web](#web-appsweb)` resolve identically here and on GitHub.
 */
function githubSlug(text, seen) {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .replace(/\s+/g, "-");
  const count = seen.get(base);
  if (count === undefined) {
    seen.set(base, 0);
    return base;
  }
  const next = count + 1;
  seen.set(base, next);
  return `${base}-${next}`;
}

function addHeadingIds(html) {
  const seen = new Map();
  return html.replace(
    /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/g,
    (match, tag, attrs, inner) => {
      if (/\bid=/.test(attrs)) return match;
      const text = decodeEntities(stripTags(inner)).trim();
      if (!text) return match;
      const slug = githubSlug(text, seen);
      return `<${tag}${attrs} id="${slug}">${inner}</${tag}>`;
    },
  );
}

const body = addHeadingIds(bodyRaw);

function deriveTitle(html) {
  const match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (!match) return "TokenOps";
  return decodeEntities(stripTags(match[1])).trim();
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const title = titleArg ?? deriveTitle(body);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f7f5f0;
      --fg: #1a1a1a;
      --muted: #5c5c5c;
      --border: #d9d4c8;
      --accent: #0f6b5c;
      --code-bg: #eee9df;
      --card: #fffefb;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #141412;
        --fg: #eceae4;
        --muted: #a8a59c;
        --border: #2e2d28;
        --accent: #5dceb8;
        --code-bg: #22211c;
        --card: #1b1a16;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      line-height: 1.55;
      font-size: 1.05rem;
    }
    main {
      max-width: 44rem;
      margin: 0 auto;
      padding: 2.5rem 1.25rem 4rem;
    }
    h1, h2, h3 {
      font-family: "Segoe UI", system-ui, sans-serif;
      line-height: 1.25;
      font-weight: 650;
    }
    h1 { font-size: 1.9rem; margin-bottom: 0.25rem; }
    h2 {
      font-size: 1.25rem;
      margin-top: 2.25rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }
    h3 { font-size: 1.05rem; margin-top: 1.5rem; color: var(--accent); }
    p { margin: 0.75rem 0; }
    .meta { color: var(--muted); font-family: "Segoe UI", system-ui, sans-serif; font-size: 0.92rem; }
    a { color: var(--accent); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: "Segoe UI", system-ui, sans-serif;
      font-size: 0.92rem;
      margin: 1rem 0;
      background: var(--card);
    }
    th, td {
      border: 1px solid var(--border);
      padding: 0.45rem 0.6rem;
      text-align: left;
      vertical-align: top;
    }
    th { background: var(--code-bg); }
    code, pre {
      font-family: ui-monospace, "Cascadia Code", "Segoe UI Mono", monospace;
      font-size: 0.86rem;
    }
    code {
      background: var(--code-bg);
      padding: 0.1rem 0.35rem;
      border-radius: 3px;
    }
    pre {
      background: var(--code-bg);
      padding: 0.9rem 1rem;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid var(--border);
      line-height: 1.4;
    }
    pre code { background: none; padding: 0; }
    ul, ol { padding-left: 1.3rem; }
    li { margin: 0.3rem 0; }
    .arch {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      font-family: ui-monospace, monospace;
      font-size: 0.78rem;
      white-space: pre;
      overflow-x: auto;
      line-height: 1.35;
    }
    .check { list-style: none; padding-left: 0; }
    .check li::before { content: "☐ "; }
    @media print {
      body { background: white; color: black; }
      main { max-width: none; }
      h2 { break-after: avoid; }
      table, pre, .arch { break-inside: avoid; }
    }
  </style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

writeFileSync(outputPath, html, "utf8");
console.log(`Wrote ${outputPath} (title: "${title}")`);
