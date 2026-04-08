#!/usr/bin/env node

// ============================================================================
// Follow Creatives — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (daily at 6am UTC) to fetch content and publish
// feed-x.json, feed-linkedin.json, feed-youtube.json, and feed-podcasts.json.
//
// Sources:
//   - X/Twitter posts: fetched via X API v2 (optional — only runs if x_accounts
//     are configured in default-sources.json and X_BEARER_TOKEN is set)
//   - LinkedIn posts: fetched via Apify (bebity~linkedin-posts-scraper actor)
//   - YouTube channels: fetched via channel RSS feeds; channel IDs resolved
//     via YouTube Data API v3 on first run and cached in state-feed.json
//   - Podcasts: fetched via RSS + pod2txt transcripts (same as follow-builders)
//
// Deduplication: tracks seen tweet IDs, post IDs, video IDs, and episode GUIDs
// in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--x-only | --linkedin-only | --youtube-only | --podcasts-only]
//
// Required env vars:
//   APIFY_API_TOKEN    — Apify token for LinkedIn scraping
//   YOUTUBE_API_KEY    — YouTube Data API v3 key (for resolving @handles to channel IDs)
//   POD2TXT_API_KEY    — pod2txt.vercel.app key for podcast transcripts
// Optional env vars:
//   X_BEARER_TOKEN     — X API v2 bearer token (only needed if x_accounts are configured)
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const POD2TXT_BASE = 'https://pod2txt.vercel.app/api';
const X_API_BASE   = 'https://api.x.com/2';
const YT_API_BASE  = 'https://www.googleapis.com/youtube/v3';

// Apify actor for LinkedIn posts. If this actor becomes unavailable,
// update to a working alternative from https://apify.com/store
const APIFY_ACTOR  = 'bebity~linkedin-posts-scraper';

const RSS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TWEET_LOOKBACK_HOURS    = 24;
const LINKEDIN_LOOKBACK_HOURS = 48;
const YOUTUBE_LOOKBACK_HOURS  = 72;  // YouTube creators post less frequently
const PODCAST_LOOKBACK_HOURS  = 336; // 14 days
const MAX_TWEETS_PER_USER     = 3;
const MAX_POSTS_PER_PROFILE   = 3;
const MAX_VIDEOS_PER_CHANNEL  = 2;

const SCRIPT_DIR  = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH  = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenPosts: {}, seenVideos: {}, seenEpisodes: {}, resolvedChannels: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    state.seenTweets       = state.seenTweets       || {};
    state.seenPosts        = state.seenPosts        || {};
    state.seenVideos       = state.seenVideos       || {};
    state.seenEpisodes     = state.seenEpisodes     || {};
    state.resolvedChannels = state.resolvedChannels || {};
    return state;
  } catch {
    return { seenTweets: {}, seenPosts: {}, seenVideos: {}, seenEpisodes: {}, resolvedChannels: {} };
  }
}

async function saveState(state) {
  // Prune entries older than 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets))   if (ts < cutoff) delete state.seenTweets[id];
  for (const [id, ts] of Object.entries(state.seenPosts))    if (ts < cutoff) delete state.seenPosts[id];
  for (const [id, ts] of Object.entries(state.seenVideos))   if (ts < cutoff) delete state.seenVideos[id];
  for (const [id, ts] of Object.entries(state.seenEpisodes)) if (ts < cutoff) delete state.seenEpisodes[id];
  // resolvedChannels: keep indefinitely (they don't change)
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- X/Twitter (API v2) ------------------------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  if (!xAccounts || xAccounts.length === 0) return [];
  console.error('Fetching X/Twitter content...');

  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup all user IDs (1 API call for up to 100 handles)
  const handles = xAccounts.map(a => a.handle);
  const userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );
      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
      if (data.errors) {
        for (const err of data.errors) errors.push(`X API: User not found: ${err.value || err.detail}`);
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user (exclude retweets/replies, dedup, cap at MAX_TWEETS_PER_USER)
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=5` +
        `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        if (res.status === 429) { errors.push('X API: Rate limited, skipping remaining accounts'); break; }
        errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const newTweets = [];
      for (const t of (data.data || [])) {
        if (state.seenTweets[t.id]) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;
        newTweets.push({
          id: t.id,
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0
        });
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name || userData.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- LinkedIn (Apify) --------------------------------------------------------

async function fetchLinkedInContent(profiles, apifyToken, state, errors) {
  console.error('Fetching LinkedIn posts via Apify...');

  // Filter profiles that have a valid LinkedIn URL
  const validProfiles = profiles.filter(p => p.linkedinUrl && !p.linkedinUrl.includes('REPLACE'));

  if (validProfiles.length === 0) {
    errors.push('LinkedIn: No valid LinkedIn URLs in config');
    return [];
  }

  const cutoff = new Date(Date.now() - LINKEDIN_LOOKBACK_HOURS * 60 * 60 * 1000);

  let items = [];
  try {
    // Run the Apify actor synchronously and get dataset items back directly.
    // Timeout is set to 300s to allow scraping all profiles.
    console.error(`  Calling Apify actor ${APIFY_ACTOR} for ${validProfiles.length} profiles...`);
    const res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${apifyToken}&timeout=300`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: validProfiles.map(p => ({ url: p.linkedinUrl })),
          maxPostCount: MAX_POSTS_PER_PROFILE + 2  // fetch a few extra for dedup
        }),
        signal: AbortSignal.timeout(330_000) // 5.5 min
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errors.push(`LinkedIn/Apify: HTTP ${res.status} — ${text.slice(0, 200)}`);
      return [];
    }

    items = await res.json();
    console.error(`  Apify returned ${items.length} post items`);
  } catch (err) {
    errors.push(`LinkedIn/Apify: ${err.message}`);
    return [];
  }

  // Group items by profile URL, filter by lookback and dedup
  const profileMap = {};
  for (const item of items) {
    // Normalise the profile URL key from the item
    const profileUrl = (item.authorProfileUrl || item.profileUrl || item.url || '').split('?')[0].replace(/\/$/, '');
    if (!profileUrl) continue;

    const postId  = item.id || item.postId || item.urn || item.postUrl || profileUrl + Date.now();
    const postedAt = item.postedAt || item.publishedAt || item.date || null;
    const postText = item.text || item.description || '';
    const postUrl  = item.postUrl || item.url || '';

    // Dedup check
    if (state.seenPosts[postId]) continue;

    // Lookback window
    if (postedAt && new Date(postedAt) < cutoff) continue;

    if (!profileMap[profileUrl]) profileMap[profileUrl] = [];
    if (profileMap[profileUrl].length < MAX_POSTS_PER_PROFILE) {
      profileMap[profileUrl].push({
        id:       postId,
        text:     postText,
        postedAt: postedAt,
        url:      postUrl,
        likes:    item.likesCount   || item.likes    || 0,
        comments: item.commentsCount || item.comments || 0
      });
      state.seenPosts[postId] = Date.now();
    }
  }

  // Match grouped posts back to source profile metadata
  const results = [];
  for (const profile of validProfiles) {
    const key = profile.linkedinUrl.split('?')[0].replace(/\/$/, '');
    const posts = profileMap[key] || [];
    if (posts.length === 0) {
      console.error(`  No new posts for ${profile.name}`);
      continue;
    }
    console.error(`  ${profile.name}: ${posts.length} new post(s)`);
    results.push({
      source:      'linkedin',
      name:        profile.name,
      role:        profile.role   || '',
      company:     profile.company || '',
      linkedinUrl: profile.linkedinUrl,
      posts
    });
  }

  return results;
}

// -- YouTube Channels --------------------------------------------------------

// Resolves a YouTube channel URL to a channel ID.
// Results are cached in state.resolvedChannels to avoid repeated API calls.
async function resolveChannelId(channel, apiKey, state) {
  const url = channel.url;

  // 1. Use channelId if already provided in config
  if (channel.channelId) return channel.channelId;

  // 2. Check cache
  const cacheKey = `channelId:${url}`;
  if (state.resolvedChannels[cacheKey]) return state.resolvedChannels[cacheKey];

  // 3. Extract directly from /channel/ID URLs
  const directMatch = url.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  if (directMatch) {
    const id = directMatch[1];
    state.resolvedChannels[cacheKey] = id;
    return id;
  }

  // 4. Need YouTube Data API for @handle and /c/ and /user/ URLs
  if (!apiKey) {
    console.error(`  Cannot resolve ${url} without YOUTUBE_API_KEY`);
    return null;
  }

  // Try @handle (e.g. https://www.youtube.com/@MotionCreativeAnalytics)
  const handleMatch = url.match(/youtube\.com\/@([^\/\?]+)/);
  if (handleMatch) {
    const handle = handleMatch[1];
    try {
      const res = await fetch(
        `${YT_API_BASE}/channels?forHandle=${handle}&part=id&key=${apiKey}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (res.ok) {
        const data = await res.json();
        const id = data.items?.[0]?.id;
        if (id) { state.resolvedChannels[cacheKey] = id; return id; }
      }
    } catch (err) {
      console.error(`  Handle resolve error for ${handle}: ${err.message}`);
    }
  }

  // Try forUsername (old-style /c/ and /user/ and bare username URLs)
  const usernameMatch = url.match(/youtube\.com\/(?:c\/|user\/)?([^\/\?@#]+)$/);
  if (usernameMatch) {
    const username = usernameMatch[1];
    try {
      const res = await fetch(
        `${YT_API_BASE}/channels?forUsername=${username}&part=id&key=${apiKey}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (res.ok) {
        const data = await res.json();
        const id = data.items?.[0]?.id;
        if (id) { state.resolvedChannels[cacheKey] = id; return id; }
      }
    } catch (err) {
      console.error(`  Username resolve error for ${username}: ${err.message}`);
    }
  }

  console.error(`  Could not resolve channel ID for: ${url}`);
  return null;
}

// Parses YouTube's Atom feed format (different from RSS — uses <entry> not <item>).
function parseYouTubeAtomFeed(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];

    const videoIdMatch   = block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    const titleMatch     = block.match(/<title>([\s\S]*?)<\/title>/);
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);
    const descMatch      = block.match(/<media:description>([\s\S]*?)<\/media:description>/);

    const videoId = videoIdMatch?.[1]?.trim();
    if (!videoId) continue;

    // Decode HTML entities in title
    const rawTitle = titleMatch?.[1]?.trim() || 'Untitled';
    const title = rawTitle.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    videos.push({
      id:          videoId,
      title,
      publishedAt: publishedMatch?.[1]?.trim() || null,
      description: (descMatch?.[1]?.trim() || '').slice(0, 500), // cap description length
      url:         `https://www.youtube.com/watch?v=${videoId}`
    });
  }
  return videos;
}

// Attempts to fetch auto-generated captions from a YouTube video.
// Returns transcript text if available, null otherwise.
async function fetchYouTubeTranscript(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': RSS_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract the player response JSON that contains caption track URLs
    const match = html.match(/"captions":\s*(\{"playerCaptionsTracklistRenderer":.+?\})\s*,\s*"videoDetails"/);
    if (!match) return null;

    const captionsObj = JSON.parse(match[1]);
    const tracks = captionsObj?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return null;

    // Prefer manual English captions over auto-generated
    const track = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
      || tracks.find(t => t.languageCode === 'en')
      || tracks[0];

    if (!track?.baseUrl) return null;

    const tRes = await fetch(`${track.baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(10_000) });
    if (!tRes.ok) return null;

    const tData = await tRes.json();
    const text = (tData.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text || null;
  } catch {
    return null;
  }
}

async function fetchYouTubeContent(channels, ytApiKey, state, errors) {
  console.error('Fetching YouTube channel content...');
  const cutoff = new Date(Date.now() - YOUTUBE_LOOKBACK_HOURS * 60 * 60 * 1000);
  const results = [];

  for (const channel of channels) {
    const channelId = await resolveChannelId(channel, ytApiKey, state);
    if (!channelId) {
      errors.push(`YouTube: Could not resolve channel ID for ${channel.name} (${channel.url})`);
      continue;
    }

    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    let allVideos = [];

    try {
      console.error(`  Fetching feed for ${channel.name} (${channelId})...`);
      const rssRes = await fetch(rssUrl, {
        headers: { 'User-Agent': RSS_USER_AGENT },
        signal: AbortSignal.timeout(20_000)
      });
      if (!rssRes.ok) {
        errors.push(`YouTube: Feed fetch failed for ${channel.name}: HTTP ${rssRes.status}`);
        continue;
      }
      const xml = await rssRes.text();
      allVideos  = parseYouTubeAtomFeed(xml);
      console.error(`  ${channel.name}: ${allVideos.length} videos in feed`);
    } catch (err) {
      errors.push(`YouTube: Error fetching ${channel.name}: ${err.message}`);
      continue;
    }

    // Filter by lookback and dedup, take the newest ones
    const newVideos = [];
    for (const video of allVideos) {
      if (state.seenVideos[video.id]) { console.error(`    Skipping "${video.title}" (already seen)`); continue; }
      if (video.publishedAt && new Date(video.publishedAt) < cutoff) continue;
      if (newVideos.length >= MAX_VIDEOS_PER_CHANNEL) break;

      // Try to fetch transcript
      console.error(`    Fetching transcript for "${video.title}"...`);
      const transcript = await fetchYouTubeTranscript(video.id);
      if (transcript) {
        console.error(`    Got transcript (${transcript.length} chars)`);
      } else {
        console.error(`    No transcript — will summarize from title + description`);
      }

      newVideos.push({ ...video, transcript: transcript || null });
      state.seenVideos[video.id] = Date.now();

      // Be polite between requests
      await new Promise(r => setTimeout(r, 1000));
    }

    if (newVideos.length === 0) {
      console.error(`  No new videos for ${channel.name}`);
      continue;
    }

    console.error(`  ${channel.name}: ${newVideos.length} new video(s)`);
    results.push({
      source:     'youtube',
      name:       channel.name,
      channelUrl: channel.url,
      channelId,
      videos:     newVideos
    });
  }

  return results;
}

// -- Podcast (RSS + pod2txt) -------------------------------------------------

function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const titleMatch   = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/);
    const guidMatch    = block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const linkMatch    = block.match(/<link>([\s\S]*?)<\/link>/);
    const guid = guidMatch?.[1]?.trim() || null;
    if (guid) {
      episodes.push({
        title:       titleMatch?.[1]?.trim() || 'Untitled',
        guid,
        publishedAt: pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null,
        link:        linkMatch?.[1]?.trim() || null
      });
    }
  }
  return episodes;
}

async function fetchPod2txtTranscript(rssUrl, guid, apiKey) {
  const maxAttempts = 5;
  const pollInterval = 30_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${POD2TXT_BASE}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedurl: rssUrl, guid, apikey: apiKey })
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.status === 'ready' && data.url) {
      const txtRes = await fetch(data.url);
      if (!txtRes.ok) return { error: `Transcript fetch failed: HTTP ${txtRes.status}` };
      return { transcript: await txtRes.text() };
    }
    if (data.status === 'processing') {
      console.error(`      pod2txt: processing (attempt ${attempt}/${maxAttempts})...`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }
    return { error: data.message || `Unexpected status: ${data.status}` };
  }
  return { error: 'Timed out' };
}

async function fetchPodcastContent(podcasts, pod2txtKey, state, errors) {
  console.error('Fetching podcast content...');
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    if (!podcast.rssUrl || podcast.rssUrl === 'REPLACE_WITH_RSS_URL') {
      errors.push(`Podcast: No RSS URL configured for "${podcast.name}" — update config/default-sources.json`);
      continue;
    }
    try {
      console.error(`  Fetching RSS for ${podcast.name}...`);
      const rssRes = await fetch(podcast.rssUrl, {
        headers: { 'User-Agent': RSS_USER_AGENT, 'Accept': 'application/rss+xml,*/*' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!rssRes.ok) {
        errors.push(`Podcast: RSS fetch failed for ${podcast.name}: HTTP ${rssRes.status}`);
        continue;
      }
      const episodes = parseRssFeed(await rssRes.text());
      console.error(`  ${podcast.name}: ${episodes.length} episodes`);
      for (const ep of episodes.slice(0, 3)) {
        if (state.seenEpisodes[ep.guid]) continue;
        allCandidates.push({ podcast, ...ep });
      }
    } catch (err) {
      errors.push(`Podcast: Error for ${podcast.name}: ${err.message}`);
    }
  }

  const withinWindow = allCandidates
    .filter(v => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => {
      if (a.publishedAt && b.publishedAt) return new Date(b.publishedAt) - new Date(a.publishedAt);
      return a.publishedAt ? -1 : 1;
    });

  for (const selected of withinWindow) {
    console.error(`  Fetching transcript for "${selected.title}"...`);
    const result = await fetchPod2txtTranscript(selected.podcast.rssUrl, selected.guid, pod2txtKey);
    state.seenEpisodes[selected.guid] = Date.now();
    if (result.error) {
      errors.push(`Podcast: Transcript error for "${selected.title}": ${result.error}`);
      continue;
    }
    if (!result.transcript) continue;
    console.error(`  Selected: "${selected.title}"`);
    return [{
      source:      'podcast',
      name:        selected.podcast.name,
      host:        selected.podcast.host || '',
      title:       selected.title,
      guid:        selected.guid,
      url:         selected.podcast.url,
      publishedAt: selected.publishedAt,
      transcript:  result.transcript
    }];
  }

  console.error('  No podcast episodes with transcripts available');
  return [];
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args          = process.argv.slice(2);
  const xOnly         = args.includes('--x-only');
  const linkedinOnly  = args.includes('--linkedin-only');
  const youtubeOnly   = args.includes('--youtube-only');
  const podcastsOnly  = args.includes('--podcasts-only');
  const anyOnly       = xOnly || linkedinOnly || youtubeOnly || podcastsOnly;

  const runX        = xOnly        || !anyOnly;
  const runLinkedIn = linkedinOnly || !anyOnly;
  const runYouTube  = youtubeOnly  || !anyOnly;
  const runPodcasts = podcastsOnly || !anyOnly;

  const xBearerToken = process.env.X_BEARER_TOKEN;
  const apifyToken   = process.env.APIFY_API_TOKEN;
  const ytApiKey     = process.env.YOUTUBE_API_KEY;
  const pod2txtKey   = process.env.POD2TXT_API_KEY;

  if (runLinkedIn && !apifyToken) {
    console.error('APIFY_API_TOKEN not set — cannot fetch LinkedIn content');
    if (linkedinOnly) process.exit(1);
  }
  if (runPodcasts && !pod2txtKey) {
    console.error('POD2TXT_API_KEY not set — cannot fetch podcast transcripts');
    if (podcastsOnly) process.exit(1);
  }
  if (!ytApiKey) {
    console.error('YOUTUBE_API_KEY not set — channel ID resolution via handle will be skipped. Channels with known channelId in config will still work.');
  }

  const sources = await loadSources();
  const state   = await loadState();
  const errors  = [];

  // X/Twitter — only runs if x_accounts are configured and X_BEARER_TOKEN is set
  if (runX && sources.x_accounts?.length > 0) {
    if (!xBearerToken) {
      console.error('X_BEARER_TOKEN not set — skipping X/Twitter fetch');
    } else {
      const xContent = await fetchXContent(sources.x_accounts, xBearerToken, state, errors);
      console.error(`X/Twitter: ${xContent.length} accounts with new tweets`);
      const feed = {
        generatedAt:   new Date().toISOString(),
        lookbackHours: TWEET_LOOKBACK_HOURS,
        x:             xContent,
        stats:         { xBuilders: xContent.length, totalTweets: xContent.reduce((s, a) => s + a.tweets.length, 0) },
        errors:        errors.filter(e => e.startsWith('X API')).length > 0 ? errors.filter(e => e.startsWith('X API')) : undefined
      };
      await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(feed, null, 2));
    }
  } else if (runX) {
    console.error('X/Twitter: no x_accounts configured in default-sources.json — skipping');
  }

  if (runLinkedIn && apifyToken) {
    const linkedinContent = await fetchLinkedInContent(sources.linkedin_profiles, apifyToken, state, errors);
    console.error(`LinkedIn: ${linkedinContent.length} profiles with new posts`);
    const feed = {
      generatedAt:    new Date().toISOString(),
      lookbackHours:  LINKEDIN_LOOKBACK_HOURS,
      linkedin:       linkedinContent,
      stats:          { profiles: linkedinContent.length, totalPosts: linkedinContent.reduce((s, p) => s + p.posts.length, 0) },
      errors:         errors.filter(e => e.startsWith('LinkedIn')).length > 0 ? errors.filter(e => e.startsWith('LinkedIn')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-linkedin.json'), JSON.stringify(feed, null, 2));
  }

  if (runYouTube) {
    const youtubeContent = await fetchYouTubeContent(sources.youtube_channels, ytApiKey, state, errors);
    console.error(`YouTube: ${youtubeContent.length} channels with new videos`);
    const feed = {
      generatedAt:   new Date().toISOString(),
      lookbackHours: YOUTUBE_LOOKBACK_HOURS,
      youtube:       youtubeContent,
      stats:         { channels: youtubeContent.length, totalVideos: youtubeContent.reduce((s, c) => s + c.videos.length, 0) },
      errors:        errors.filter(e => e.startsWith('YouTube')).length > 0 ? errors.filter(e => e.startsWith('YouTube')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-youtube.json'), JSON.stringify(feed, null, 2));
    // Save state after YouTube to persist resolved channel IDs
    await saveState(state);
  }

  if (runPodcasts && pod2txtKey) {
    const podcastContent = await fetchPodcastContent(sources.podcasts, pod2txtKey, state, errors);
    console.error(`Podcasts: ${podcastContent.length} new episode(s)`);
    const feed = {
      generatedAt:   new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts:      podcastContent,
      stats:         { podcastEpisodes: podcastContent.length },
      errors:        errors.filter(e => e.startsWith('Podcast')).length > 0 ? errors.filter(e => e.startsWith('Podcast')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(feed, null, 2));
  }

  await saveState(state);

  if (errors.length > 0) {
    console.error(`\nNon-fatal errors (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
