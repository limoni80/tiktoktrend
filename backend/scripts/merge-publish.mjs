/**
 * Merge one or many collector artifacts into the latest data branch checkout.
 *
 * Collection jobs run in parallel, but this merge runs in a short serialized
 * publish job. Only files that a collector actually refreshed are replaced;
 * carried files never overwrite a newer result from another concurrent run.
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const [incomingRoot = 'incoming', targetRoot = 'data-worktree'] = process.argv.slice(2);
const readJson = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
};
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const exists = async (path) => stat(path).then(() => true).catch(() => false);
const timestamp = (entry) => Date.parse(entry?.updatedAt ?? entry?.lastSuccessAt ?? 0) || 0;
const entryKey = (entry) => entry.kind === 'feed' ? 'feed' : `search:${entry.slug ?? entry.keyword ?? entry.file}`;

async function findIndexes(root) {
  const found = [];
  const walk = async (directory) => {
    for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.name === 'index.json') found.push(path);
    }
  };
  await walk(root);
  return found;
}

const currentIndexPath = join(targetRoot, 'index.json');
const currentIndex = await readJson(currentIndexPath, { entries: [], keywords: [] });
const merged = new Map((currentIndex.entries ?? []).map((entry) => [entryKey(entry), entry]));
let newestMeta = currentIndex;
let copied = 0;

for (const indexPath of await findIndexes(incomingRoot)) {
  const incoming = await readJson(indexPath, { entries: [] });
  if (Date.parse(incoming.generatedAt ?? 0) > Date.parse(newestMeta.generatedAt ?? 0)) newestMeta = incoming;
  const artifactRoot = dirname(indexPath);

  for (const entry of incoming.entries ?? []) {
    const key = entryKey(entry);
    const current = merged.get(key);
    const source = join(artifactRoot, entry.file);
    const destination = join(targetRoot, entry.file);
    const sourceExists = await exists(source);
    const shouldReplace = entry.status !== 'carried'
      && sourceExists
      && (!current || timestamp(entry) >= timestamp(current));
    const shouldSeed = !current && sourceExists;
    if (!shouldReplace && !shouldSeed) continue;
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    merged.set(key, entry);
    copied += 1;
  }
}

const entries = [...merged.values()].sort((a, b) => timestamp(b) - timestamp(a));
const generatedAt = new Date().toISOString();
const index = {
  generatedAt,
  startedAt: newestMeta.startedAt ?? generatedAt,
  repo: newestMeta.repo ?? currentIndex.repo ?? null,
  runUrl: newestMeta.runUrl ?? null,
  entries,
  keywords: entries
    .filter((entry) => entry.kind === 'search')
    .map(({ keyword, slug, status, count, updatedAt, emptyStreak }) => ({
      keyword, slug, status, count, updatedAt,
      ...(Number(emptyStreak) > 0 ? { emptyStreak: Number(emptyStreak) } : {}),
    })),
};
await writeJson(currentIndexPath, index);

// One compact, real-data-only index lets a brand-new search show useful
// matching videos immediately while its exact TikTok collection runs.
const videos = new Map();
for (const entry of entries.filter((item) => item.kind === 'search' && item.count > 0)) {
  const payload = await readJson(join(targetRoot, entry.file));
  for (const video of payload?.videos ?? []) {
    const existing = videos.get(video.id);
    const terms = new Set([...(existing?.indexedKeywords ?? []), entry.keyword].filter(Boolean));
    videos.set(video.id, { ...(existing ?? video), indexedKeywords: [...terms] });
  }
}
const aggregate = [...videos.values()]
  .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
  .slice(0, 2_500);
await writeJson(join(targetRoot, 'search-index.json'), {
  videos: aggregate,
  scanned: aggregate.length,
  hasMore: false,
  source: 'Fresh TikTok dataset index',
  keyword: null,
  fetchedAt: generatedAt,
});

console.log(`Merged ${copied} refreshed dataset file(s); catalogue=${index.keywords.length}; instant-index=${aggregate.length}.`);
console.log(`Target: ${relative(process.cwd(), targetRoot) || targetRoot}`);
