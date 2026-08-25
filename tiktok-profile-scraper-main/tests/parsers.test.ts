import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTikTokVideo, parseAbbreviatedNumber, parseTikTokHtml, parseTikTokOEmbed, parseTikTokPayload } from '../src/parsers.js';

test('parseAbbreviatedNumber handles compact metrics', () => {
    assert.equal(parseAbbreviatedNumber('1.2B'), 1_200_000_000);
    assert.equal(parseAbbreviatedNumber('25K'), 25_000);
});

test('parseTikTokPayload maps a public profile', () => {
    const result = parseTikTokPayload({ '__DEFAULT_SCOPE__': { 'webapp.user-detail': { userInfo: {
        user: { uniqueId: 'demo', nickname: 'Demo', signature: 'Bio', verified: true },
        stats: { followerCount: '12K', followingCount: 5, heartCount: '2M', videoCount: 20 },
    } } } }, 'demo');
    assert.equal(result?.profile.followersCount, 12_000);
    assert.equal(result?.profile.verifiedBadge, true);
});

test('mapTikTokVideo maps metrics and tags', () => {
    const video = mapTikTokVideo({ id: '99', desc: '#build with @demo', stats: { playCount: 500 } }, 'demo');
    assert.equal(video?.viewsCount, 500);
    assert.deepEqual(video?.hashtags, ['build']);
});

test('parseTikTokHtml rejects challenge pages', () => {
    assert.equal(parseTikTokHtml('<html>verify</html>', 'demo'), null);
});

test('parseTikTokHtml supports SIGI_STATE profile payloads', () => {
    const payload = {
        UserModule: {
            users: { '123': { id: '123', uniqueId: 'demo', nickname: 'Demo', signature: 'Bio' } },
            stats: { '123': { followerCount: 42, followingCount: 3, heartCount: 500, videoCount: 8 } },
        },
    };
    const html = `<script id="SIGI_STATE" type="application/json">${JSON.stringify(payload)}</script>`;
    const result = parseTikTokHtml(html, 'demo');
    assert.equal(result?.profile.followersCount, 42);
    assert.equal(result?.profile.totalVideosCount, 8);
});

test('parseTikTokOEmbed maps an official public creator profile response', () => {
    const result = parseTikTokOEmbed({
        version: '1.0',
        type: 'rich',
        title: "Scout, Suki & Stella's Creator Profile",
        author_url: 'https://www.tiktok.com/@scout2015',
        author_name: 'Scout, Suki & Stella',
        provider_name: 'TikTok',
        html: '<blockquote data-unique-id="scout2015"></blockquote>',
    }, 'scout2015');
    assert.equal(result?.profile.username, 'scout2015');
    assert.equal(result?.profile.displayName, 'Scout, Suki & Stella');
    assert.equal(result?.profile.followersCount, null);
});

test('parseTikTokOEmbed rejects mismatched profiles', () => {
    assert.equal(parseTikTokOEmbed({
        type: 'rich',
        author_url: 'https://www.tiktok.com/@different',
        provider_name: 'TikTok',
    }, 'requested'), null);
});
