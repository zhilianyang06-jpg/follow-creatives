#!/usr/bin/env node

// ============================================================================
// Follow Creatives — Generate Digest
// ============================================================================
// Runs in GitHub Actions on a weekly schedule.
// Reads the latest feed JSON files, calls Claude API to generate a digest,
// then posts the result as a new ClickUp Doc.
//
// Required env vars (set as GitHub Secrets):
//   ANTHROPIC_API_KEY     — Claude API key
//   CLICKUP_API_TOKEN     — ClickUp personal token (starts with pk_)
//   CLICKUP_WORKSPACE_ID  — Numeric workspace/team ID from ClickUp URL
//   CLICKUP_PARENT_ID     — Space or Folder ID where docs will be created
//   CLICKUP_PARENT_TYPE   — 4 for Space, 6 for Folder (default: 4)
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const REPO_ROOT = join(SCRIPT_DIR, '..');

// -- File helpers ------------------------------------------------------------

async function readFeedFile(filename) {
  const path = join(REPO_ROOT, filename);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function readPromptFile(filename) {
  const path = join(REPO_ROOT, 'prompts', filename);
  if (!existsSync(path)) return '';
  return readFile(path, 'utf-8');
}

// -- Claude API --------------------------------------------------------------

async function generateDigest(feedData, prompts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const system = [
    'You are an ad creative and performance marketing curator.',
    '',
    '== DIGEST FORMAT ==',
    prompts.digest_intro,
    '',
    '== LINKEDIN SUMMARIZATION RULES ==',
    prompts.summarize_linkedin,
    '',
    '== YOUTUBE SUMMARIZATION RULES ==',
    prompts.summarize_youtube,
    '',
    '== PODCAST SUMMARIZATION RULES ==',
    prompts.summarize_podcast,
  ].join('\n');

  const userContent = [
    'Generate a complete digest from the feed data below.',
    'Follow all formatting and summarization rules exactly.',
    'Only include content that has actual posts, videos, or episodes.',
    'Every item MUST include its source URL.',
    '',
    'FEED DATA:',
    JSON.stringify(feedData, null, 2),
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error (${res.status}): ${err}`);
  }

  const result = await res.json();
  return result.content[0].text;
}

// -- ClickUp Docs API (v3) ---------------------------------------------------

async function postToClickUp(digestText, docName) {
  const apiToken  = process.env.CLICKUP_API_TOKEN;
  const workspaceId = process.env.CLICKUP_WORKSPACE_ID;
  const parentId  = process.env.CLICKUP_PARENT_ID;
  const parentType = parseInt(process.env.CLICKUP_PARENT_TYPE || '4');

  if (!apiToken)    throw new Error('CLICKUP_API_TOKEN not set');
  if (!workspaceId) throw new Error('CLICKUP_WORKSPACE_ID not set');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': apiToken,
  };

  // Step 1: Create the doc
  const docBody = { name: docName };
  if (parentId) docBody.parent = { id: parentId, type: parentType };

  const createRes = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs`,
    { method: 'POST', headers, body: JSON.stringify(docBody) }
  );

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`ClickUp create doc error (${createRes.status}): ${err}`);
  }

  const doc = await createRes.json();
  const docId = doc.id;
  console.log(`Created ClickUp doc: ${docId}`);

  // Step 2: Create a page with the digest content
  const pageRes = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: docName,
        content: digestText,
        content_format: 'text/md',
      }),
    }
  );

  if (!pageRes.ok) {
    const err = await pageRes.text();
    throw new Error(`ClickUp create page error (${pageRes.status}): ${err}`);
  }

  const page = await pageRes.json();
  console.log(`Created ClickUp page: ${page.id}`);
  return { docId, pageId: page.id };
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log('Reading feed files...');

  const [feedLinkedIn, feedYouTube, feedPodcasts, feedX] = await Promise.all([
    readFeedFile('feed-linkedin.json'),
    readFeedFile('feed-youtube.json'),
    readFeedFile('feed-podcasts.json'),
    readFeedFile('feed-x.json'),
  ]);

  const linkedin  = feedLinkedIn?.linkedin  || [];
  const youtube   = feedYouTube?.youtube    || [];
  const podcasts  = feedPodcasts?.podcasts  || [];
  const x         = feedX?.x               || [];

  const totalPosts    = linkedin.reduce((sum, p) => sum + (p.posts?.length   || 0), 0);
  const totalVideos   = youtube.reduce((sum, c)  => sum + (c.videos?.length  || 0), 0);
  const totalEpisodes = podcasts.length;
  const totalTweets   = x.reduce((sum, a)        => sum + (a.tweets?.length  || 0), 0);

  console.log(`Content: ${totalPosts} posts, ${totalVideos} videos, ${totalEpisodes} episodes, ${totalTweets} tweets`);

  if (totalPosts + totalVideos + totalEpisodes + totalTweets === 0) {
    console.log('No content in feeds — skipping digest generation.');
    return;
  }

  // Load prompts
  const [digestIntro, summarizeLinkedIn, summarizeYoutube, summarizePodcast] = await Promise.all([
    readPromptFile('digest-intro.md'),
    readPromptFile('summarize-linkedin.md'),
    readPromptFile('summarize-youtube.md'),
    readPromptFile('summarize-podcast.md'),
  ]);

  const prompts = { digest_intro: digestIntro, summarize_linkedin: summarizeLinkedIn, summarize_youtube: summarizeYoutube, summarize_podcast: summarizePodcast };
  const feedData = { linkedin, youtube, podcasts, x };

  console.log('Calling Claude API to generate digest...');
  const digest = await generateDigest(feedData, prompts);
  console.log('Digest generated.');

  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const docName = `Ad Creative Digest — ${dateStr}`;

  console.log(`Posting to ClickUp as "${docName}"...`);
  await postToClickUp(digest, docName);
  console.log('Done.');
}

main().catch(err => {
  console.error('generate-digest failed:', err.message);
  process.exit(1);
});
