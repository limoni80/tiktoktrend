/**
 * Build the GitHub Actions matrix for TikTok collection.
 *
 * An on-demand run contains one keyword. A scheduled run refreshes the most
 * useful configured/recent keywords in parallel. The output is deliberately
 * plain JSON so GitHub can feed it directly to strategy.matrix.keyword.
 */
import { appendFile, readFile } from 'node:fs/promises';

const repo = process.env.GITHUB_REPOSITORY ?? 'limoni80/tiktoktrend';
const branch = process.env.DATA_BRANCH ?? 'data';
const extra = String(process.env.EXTRA_KEYWORD ?? '').trim().slice(0, 80);
const maxKeywords = Math.min(100, Math.max(1, Number(process.env.MAX_KEYWORDS ?? 60)));
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keyword';

const settings = JSON.parse(await readFile('data/keywords.json', 'utf8'));
let remembered = [];
if (!extra) {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/index.json`, {
      headers: { 'user-agent': 'tiktoktrend-plan' },
    });
    if (response.ok) {
      const index = await response.json();
      remembered = (index?.keywords ?? [])
        .filter((entry) => entry?.keyword)
        .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))
        .map((entry) => String(entry.keyword).trim());
    }
  } catch { /* a first run simply uses configured keywords */ }
}

const candidates = extra
  ? [extra]
  : [...(settings.keywords ?? []).map(String), ...remembered];
const seen = new Set();
const keywords = [];
for (const candidate of candidates) {
  const keyword = candidate.trim().slice(0, 80);
  const key = slugify(keyword);
  if (!keyword || seen.has(key)) continue;
  seen.add(key);
  keywords.push(keyword);
  if (keywords.length >= maxKeywords) break;
}

if (!keywords.length) throw new Error('No keywords are configured for collection.');
const value = JSON.stringify(keywords);
console.log(`Collection matrix (${keywords.length}): ${keywords.join(' | ')}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `keywords=${value}\n`, 'utf8');
else console.log(value);
