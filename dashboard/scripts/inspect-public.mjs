const url = process.argv[2] ?? 'https://www.tiktok.com/explore';
const response = await fetch(url, {
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
  },
});
const html = await response.text();
const marker = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
const markerIndex = html.indexOf(marker);
if (markerIndex < 0) {
  console.log(JSON.stringify({ url, status: response.status, htmlLength: html.length, payload: false }, null, 2));
  process.exit(0);
}
const start = html.indexOf('>', markerIndex) + 1;
const end = html.indexOf('</script>', start);
const payload = JSON.parse(html.slice(start, end));
const serialized = JSON.stringify(payload);
console.log(JSON.stringify({
  url,
  status: response.status,
  htmlLength: html.length,
  payload: true,
  topKeys: Object.keys(payload),
  scopeKeys: Object.keys(payload.__DEFAULT_SCOPE__ ?? {}),
  itemStructOccurrences: serialized.split('itemStruct').length - 1,
  itemListOccurrences: serialized.split('itemList').length - 1,
  playCountOccurrences: serialized.split('playCount').length - 1,
}, null, 2));
