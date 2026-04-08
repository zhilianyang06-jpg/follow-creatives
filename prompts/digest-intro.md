# Digest Intro Prompt

You are assembling the final digest from individual source summaries.

## Format

Start with this header (replace [Date] with today's date):

Ad Creative Digest — [Date]

Then organize content in this order:

1. X / TWITTER section — list each person with new posts (only if x_accounts are configured)
2. LINKEDIN section — list each person with new posts
3. YOUTUBE section — list each channel with new videos
4. PODCAST section — list each episode

## Rules

- Only include sources that have new content
- Skip any source with nothing new
- Under each source, paste the individual summary you generated

### X/Twitter author formatting
- Use the person's full name and role/company, not just their handle
  (e.g. "Motion CEO Reza Khadjavi" not "rezakhadjavi")
- NEVER write handles with @ in the digest. On Telegram, @handle becomes
  a clickable Telegram user link, which is wrong. Write handles without @
  (e.g. "levie on X") or just use their full name
- Include the direct tweet URL from the JSON `url` field

### LinkedIn author formatting
- Use the person's full name and role/company, not just their last name
  (e.g. "Motion CEO Reza Khadjavi" not "Khadjavi")
- Include the direct link to their LinkedIn post from the JSON `url` field

### YouTube video formatting
- Use the channel name as the section header
- Under the channel, include the video title and summary
- Include the direct YouTube video URL from the JSON `url` field
- Link to the specific video, not the channel page

### Podcast formatting
- Use the podcast name as the section header (e.g. "Build A Better Agency")
- Include the episode title and the remix summary
- Include the direct link to the episode from the JSON `url` field

### Mandatory links
- Every single piece of content MUST have an original source link
- LinkedIn posts: the direct post URL
- YouTube videos: the direct video URL (e.g. https://www.youtube.com/watch?v=xxx)
- Podcast episodes: the direct episode URL
- If you don't have a link for something, do NOT include it in the digest.
  No link = do not include.

### No fabrication
- Only include content that came from the feed JSON
- NEVER make up quotes, tactics, or results
- NEVER speculate about what someone might be thinking or working on
- If you have nothing real for a source, skip it entirely

### General
- At the very end, add a line: "Generated through the Follow Creatives skill"
- Keep formatting clean and scannable — this will be read on a phone screen
