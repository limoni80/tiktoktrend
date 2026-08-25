import type { TikTokVideo } from './types';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export const sampleVideos: TikTokVideo[] = [
  {
    id: '748219301', url: 'https://www.tiktok.com/', caption: 'The 10 minute desk reset that changed how I work ✨',
    thumbnailUrl: 'https://images.unsplash.com/photo-1497215728101-856f4ea42174?auto=format&fit=crop&w=720&q=80',
    publishedAt: hoursAgo(2.4), durationSeconds: 27, views: 842300, likes: 113400, comments: 3280, shares: 18400, saves: 29200,
    creator: { username: 'studio.aria', displayName: 'Aria Studio', profileUrl: 'https://www.tiktok.com/@studio.aria', avatarUrl: null, followers: 18400, following: 216, totalLikes: 3400000, country: 'US', verified: false },
    hashtags: ['desksetup', 'productivity', 'reset'], soundName: 'original sound', soundAuthor: 'studio.aria', soundId: 'sound-912', collectedAt: new Date().toISOString(), viewsPerHour: 35100, likesPerHour: 4725, source: 'Demo dataset',
  },
  {
    id: '748219302', url: 'https://www.tiktok.com/', caption: 'POV: your coffee shop has a secret menu ☕',
    thumbnailUrl: 'https://images.unsplash.com/photo-1445116572660-236099ec97a0?auto=format&fit=crop&w=720&q=80',
    publishedAt: hoursAgo(5.8), durationSeconds: 19, views: 391200, likes: 62900, comments: 2130, shares: 9700, saves: 14100,
    creator: { username: 'dailybrew', displayName: 'Daily Brew', profileUrl: 'https://www.tiktok.com/@dailybrew', avatarUrl: null, followers: 9200, following: 108, totalLikes: 1800000, country: 'MA', verified: false },
    hashtags: ['coffeetok', 'hiddenmenu', 'morocco'], soundName: 'Sunset Lover - Remix', soundAuthor: 'Petit Biscuit', soundId: 'sound-884', collectedAt: new Date().toISOString(), viewsPerHour: 19300, likesPerHour: 2210, source: 'Demo dataset',
  },
  {
    id: '748219303', url: 'https://www.tiktok.com/', caption: 'I tried the viral one-pan pasta so you do not have to',
    thumbnailUrl: 'https://images.unsplash.com/photo-1556761223-4c4282c73f77?auto=format&fit=crop&w=720&q=80',
    publishedAt: hoursAgo(17), durationSeconds: 42, views: 1200000, likes: 97800, comments: 8900, shares: 22100, saves: 47600,
    creator: { username: 'nora.cooks', displayName: 'Nora Cooks', profileUrl: 'https://www.tiktok.com/@nora.cooks', avatarUrl: null, followers: 128000, following: 340, totalLikes: 8900000, country: 'FR', verified: true },
    hashtags: ['foodtok', 'easyrecipe', 'pasta'], soundName: 'Taste', soundAuthor: 'Original audio', soundId: 'sound-776', collectedAt: new Date().toISOString(), viewsPerHour: 8800, likesPerHour: 720, source: 'Demo dataset',
  },
  {
    id: '748219304', url: 'https://www.tiktok.com/', caption: 'Three transitions you can film with just your phone',
    thumbnailUrl: 'https://images.unsplash.com/photo-1536240478700-b869070f9279?auto=format&fit=crop&w=720&q=80',
    publishedAt: hoursAgo(31), durationSeconds: 33, views: 226700, likes: 31100, comments: 914, shares: 6100, saves: null,
    creator: { username: 'cutwithsam', displayName: 'Sam / Video Tips', profileUrl: 'https://www.tiktok.com/@cutwithsam', avatarUrl: null, followers: 4700, following: 612, totalLikes: 720000, country: 'GB', verified: false },
    hashtags: ['capcut', 'filmmaking', 'tutorial'], soundName: 'original sound', soundAuthor: 'cutwithsam', soundId: null, collectedAt: new Date().toISOString(), viewsPerHour: 2100, likesPerHour: 240, source: 'Demo dataset',
  },
  {
    id: '748219305', url: 'https://www.tiktok.com/', caption: 'What nobody tells you about running your first 5K',
    thumbnailUrl: 'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?auto=format&fit=crop&w=720&q=80',
    publishedAt: hoursAgo(73), durationSeconds: 51, views: 98400, likes: 8900, comments: 430, shares: 1200, saves: 3300,
    creator: { username: 'runwithilyas', displayName: 'Ilyas Runs', profileUrl: 'https://www.tiktok.com/@runwithilyas', avatarUrl: null, followers: 3100, following: 244, totalLikes: 208000, country: 'MA', verified: false },
    hashtags: ['runningtips', '5k', 'beginner'], soundName: null, soundAuthor: null, soundId: null, collectedAt: new Date().toISOString(), viewsPerHour: 490, likesPerHour: 38, source: 'Demo dataset',
  },
  {
    id: '748219306', url: 'https://www.tiktok.com/', caption: 'A quiet morning in Marrakech',
    thumbnailUrl: 'https://images.unsplash.com/photo-1597212618440-806262de4f6b?auto=format&fit=crop&w=720&q=80',
    publishedAt: hoursAgo(8.2), durationSeconds: 24, views: 612000, likes: 120400, comments: 1700, shares: 13800, saves: 35700,
    creator: { username: 'slowmorocco', displayName: 'Slow Morocco', profileUrl: 'https://www.tiktok.com/@slowmorocco', avatarUrl: null, followers: 27800, following: 93, totalLikes: 4600000, country: 'MA', verified: false },
    hashtags: ['marrakech', 'morocco', 'slowtravel'], soundName: 'Birds of a Feather', soundAuthor: 'Billie Eilish', soundId: 'sound-443', collectedAt: new Date().toISOString(), viewsPerHour: 24800, likesPerHour: 4310, source: 'Demo dataset',
  },
];
