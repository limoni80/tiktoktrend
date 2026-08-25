// End-to-end production check. Run against a RUNNING backend:
//   node scripts/verify.mjs [baseUrl] [keyword]
// Exits non-zero if the API is unhealthy, returns HTML, or returns data that
// does not look like real TikTok data.
const base = (process.argv[2] ?? process.env.VERIFY_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const keyword = process.argv[3] ?? 'dog';
let failures = 0;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const getJson = async (path) => {
  const response = await fetch(`${base}${path}`);
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!contentType.includes('application/json')) {
    throw new Error(`non-JSON response (${contentType || 'no content-type'}): ${text.slice(0, 80)}`);
  }
  return { response, body: JSON.parse(text) };
};

try {
  const health = await getJson('/api/health');
  check('GET /api/health returns JSON', health.response.ok && health.body.status === 'ok', JSON.stringify(health.body.status));
  check('backend does not use a persistent browser profile', health.body.persistentProfile === false);

  const unknown = await getJson('/api/does-not-exist');
  check('unknown /api route returns JSON 404 (never HTML)', unknown.response.status === 404 && Boolean(unknown.body.error));

  console.log(`\nRunning a real TikTok search for "${keyword}" — this can take up to a minute…`);
  const search = await getJson(`/api/fetch-tiktok?q=${encodeURIComponent(keyword)}&count=10`);
  const videos = search.body.videos ?? [];
  const backendError = search.body.error;
  check(
    'search returned videos',
    videos.length > 0,
    backendError ? `backend said ${backendError.code}: ${backendError.message}` : `${videos.length} videos`,
  );

  if (videos.length) {
    const sample = videos[0];
    check('video URL points at tiktok.com', /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/.test(sample.url), sample.url);
    check('numeric TikTok id', /^\d{15,}$/.test(String(sample.id)), String(sample.id));
    check('creator username present', Boolean(sample.creator?.username), sample.creator?.username ?? 'missing');

    const withMetric = (key, get) => videos.filter((video) => get(video) != null).length;
    const rows = [
      ['views', (v) => v.views], ['likes', (v) => v.likes], ['comments', (v) => v.comments],
      ['shares', (v) => v.shares], ['saves', (v) => v.saves],
      ['creator followers', (v) => v.creator?.followers], ['publishedAt', (v) => v.publishedAt],
      ['playable videoFileUrl', (v) => v.videoFileUrl],
    ];
    console.log('\nMetric coverage across the returned videos:');
    for (const [name, get] of rows) {
      const count = withMetric(name, get);
      console.log(`  ${name.padEnd(22)} ${count}/${videos.length}`);
      if (['views', 'likes', 'comments'].includes(name)) check(`${name} present on every video`, count === videos.length, `${count}/${videos.length}`);
    }
    const totalViews = videos.reduce((sum, video) => sum + (video.views ?? 0), 0);
    check('view counts are non-zero (not placeholders)', totalViews > 0, `${totalViews} total views`);
  }
} catch (error) {
  check('verification run completed', false, error instanceof Error ? error.message : String(error));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
