/**
 * Build the GitHub Actions matrix for TikTok collection.
 *
 * An on-demand run contains one keyword. A scheduled run refreshes the most
 * stalest useful keywords in parallel. Repeated empty keywords cool down so
 * they do not consume a runner every 30 minutes; an explicit user search
 * always bypasses that cooldown. The output is deliberately
 * plain JSON so GitHub can feed it directly to strategy.matrix.keyword.
 */
import { appendFile, readFile } from 'node:fs/promises';

const repo = process.env.GITHUB_REPOSITORY ?? 'limoni80/tiktoktrend';
const branch = process.env.DATA_BRANCH ?? 'data';
const extra = String(process.env.EXTRA_KEYWORD ?? '').trim().slice(0, 80);
const maxKeywords = Math.min(100, Math.max(1, Number(process.env.MAX_KEYWORDS ?? 60)));
const emptyRetryMs = Math.max(30 * 60_000, Number(process.env.EMPTY_RETRY_MS ?? 6 * 60 * 60_000));
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keyword';

const settings = JSON.parse(await readFile('data/keywords.json', 'utf8'));
let remembered = [];
const indexed = new Map();
if (!extra) {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/index.json`, {
      headers: { 'user-agent': 'tiktoktrend-plan' },
    });
    if (response.ok) {
      const index = await response.json();
      remembered = (index?.keywords ?? []).filter((entry) => entry?.keyword);
      for (const entry of remembered) indexed.set(slugify(String(entry.keyword)), entry);
    }
  } catch { /* a first run simply uses configured keywords */ }
}

const candidates = extra
  ? [extra]
  : [...(settings.keywords ?? []).map(String), ...remembered.map((entry) => String(entry.keyword))];
const seen = new Set();
const planned = [];
const deferred = [];
let coolingDown = 0;
for (const candidate of candidates) {
  const keyword = candidate.trim().slice(0, 80);
  const key = slugify(keyword);
  if (!keyword || seen.has(key)) continue;
  seen.add(key);
  const entry = indexed.get(key);
  const updatedAt = Date.parse(entry?.updatedAt ?? '') || 0;
  const emptyStreak = Number(entry?.emptyStreak ?? 0);
  const emptyIsCoolingDown = emptyStreak >= 2 && updatedAt > 0 && Date.now() - updatedAt < emptyRetryMs;
  if (emptyIsCoolingDown) {
    coolingDown += 1;
    deferred.push({ keyword, updatedAt });
    continue;
  }
  planned.push({ keyword, updatedAt });
}

// GitHub starts matrix jobs in this order. Refresh never-collected and oldest
// datasets first so a large catalogue cannot starve its stalest entries.
planned.sort((a, b) => a.updatedAt - b.updatedAt);
// Keep the workflow healthy even if the whole catalogue is temporarily in
// empty cooldown. One oldest retry is cheaper than failing the matrix plan.
if (!planned.length && deferred.length) {
  deferred.sort((a, b) => a.updatedAt - b.updatedAt);
  planned.push(deferred[0]);
  coolingDown -= 1;
}
const keywords = planned.slice(0, maxKeywords).map((entry) => entry.keyword);

if (!keywords.length) throw new Error('No keywords are configured for collection.');
const value = JSON.stringify(keywords);
console.log(`Collection matrix (${keywords.length}): ${keywords.join(' | ')}`);
if (coolingDown) console.log(`Skipped ${coolingDown} repeatedly empty keyword(s) until their six-hour retry window.`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `keywords=${value}\n`, 'utf8');
else console.log(value);
