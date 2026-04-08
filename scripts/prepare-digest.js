#!/usr/bin/env node

// ============================================================================
// Follow Creatives — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (LinkedIn posts, YouTube videos, podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.follow-creatives');
const CONFIG_PATH = join(USER_DIR, 'config.json');

// IMPORTANT: Replace YOUR_GITHUB_USERNAME with your actual GitHub username
// after pushing this repo to GitHub.
const REPO_BASE = 'https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/follow-creatives/main';
const FEED_X_URL        = `${REPO_BASE}/feed-x.json`;
const FEED_LINKEDIN_URL = `${REPO_BASE}/feed-linkedin.json`;
const FEED_YOUTUBE_URL  = `${REPO_BASE}/feed-youtube.json`;
const FEED_PODCASTS_URL = `${REPO_BASE}/feed-podcasts.json`;

const PROMPTS_BASE = `${REPO_BASE}/prompts`;
const PROMPT_FILES = [
  'summarize-tweets.md',
  'summarize-linkedin.md',
  'summarize-youtube.md',
  'summarize-podcast.md',
  'digest-intro.md',
  'translate.md'
];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all feeds in parallel
  const [feedX, feedLinkedIn, feedYouTube, feedPodcasts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_LINKEDIN_URL),
    fetchJSON(FEED_YOUTUBE_URL),
    fetchJSON(FEED_PODCASTS_URL)
  ]);

  if (!feedX)        errors.push('Could not fetch X/Twitter feed');
  if (!feedLinkedIn) errors.push('Could not fetch LinkedIn feed');
  if (!feedYouTube)  errors.push('Could not fetch YouTube feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output blob
  const xAccounts        = feedX?.x              || [];
  const linkedinProfiles = feedLinkedIn?.linkedin || [];
  const youtubeChannels  = feedYouTube?.youtube   || [];
  const podcasts         = feedPodcasts?.podcasts  || [];

  const totalTweets  = xAccounts.reduce((sum, a) => sum + (a.tweets?.length || 0), 0);
  const totalPosts   = linkedinProfiles.reduce((sum, p) => sum + (p.posts?.length || 0), 0);
  const totalVideos  = youtubeChannels.reduce((sum, c) => sum + (c.videos?.length || 0), 0);

  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    x:        xAccounts,
    linkedin: linkedinProfiles,
    youtube:  youtubeChannels,
    podcasts,

    stats: {
      xBuilders:        xAccounts.length,
      totalTweets,
      linkedinProfiles: linkedinProfiles.length,
      totalPosts,
      youtubeChannels:  youtubeChannels.length,
      totalVideos,
      podcastEpisodes:  podcasts.length,
      feedGeneratedAt:  feedX?.generatedAt || feedLinkedIn?.generatedAt || feedYouTube?.generatedAt || null
    },

    prompts,

    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('prepare-digest failed:', err.message);
  process.exit(1);
});
