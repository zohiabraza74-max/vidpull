const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helper: extract video ID ──
function extractId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = String(url).match(p);
    if (m) return m[1];
  }
  return null;
}

// ── GET /api/info?url=... ──
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const videoId = extractId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const details = info.videoDetails;

    // Build thumbnail list (highest quality first)
    const thumbnails = details.thumbnails || [];
    const thumbUrl = thumbnails.length
      ? thumbnails[thumbnails.length - 1].url
      : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // Available video+audio formats
    const videoFormats = ytdl.filterFormats(info.formats, 'videoandaudio')
      .map(f => ({
        itag: f.itag,
        quality: f.qualityLabel || f.quality,
        container: f.container,
        mimeType: f.mimeType,
        contentLength: f.contentLength,
      }))
      .filter(f => f.quality);

    // Audio-only formats
    const audioFormats = ytdl.filterFormats(info.formats, 'audioonly')
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
      .slice(0, 3)
      .map(f => ({
        itag: f.itag,
        bitrate: f.audioBitrate,
        container: f.container,
      }));

    res.json({
      videoId,
      title: details.title,
      channel: details.author?.name || 'YouTube',
      duration: details.lengthSeconds,
      views: details.viewCount,
      thumbnail: thumbUrl,
      videoFormats,
      audioFormats,
    });
  } catch (err) {
    console.error('[info error]', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch video info' });
  }
});

// ── GET /api/thumbnail?id=... ── (proxy thumbnail to avoid CORS)
app.get('/api/thumbnail', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('No ID');

  const urls = [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];

  let idx = 0;
  function tryNext() {
    if (idx >= urls.length) {
      res.status(404).send('Thumbnail not found');
      return;
    }
    const url = urls[idx++];
    https.get(url, (imgRes) => {
      if (imgRes.statusCode === 200) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        imgRes.pipe(res);
      } else {
        tryNext();
      }
    }).on('error', tryNext);
  }
  tryNext();
});

// ── GET /api/download?id=...&itag=...&type=video|audio ──
app.get('/api/download', async (req, res) => {
  const { id, itag, type } = req.query;
  if (!id) return res.status(400).send('No video ID');

  try {
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`);
    const details = info.videoDetails;
    const safeTitle = details.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);

    let options = {};
    let filename = '';

    if (type === 'audio') {
      options = { filter: 'audioonly', quality: 'highestaudio' };
      filename = `${safeTitle}.mp3`;
      res.setHeader('Content-Type', 'audio/mpeg');
    } else {
      if (itag) {
        options = { filter: f => f.itag === parseInt(itag) };
      } else {
        options = { filter: 'videoandaudio', quality: 'highest' };
      }
      filename = `${safeTitle}.mp4`;
      res.setHeader('Content-Type', 'video/mp4');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = ytdl(`https://www.youtube.com/watch?v=${id}`, options);
    stream.on('error', err => {
      console.error('[download error]', err.message);
      if (!res.headersSent) res.status(500).send('Download failed');
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[download error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── GET /api/thumbnail-download?id=... ── (force-download thumbnail)
app.get('/api/thumbnail-download', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).send('No ID');

  const urls = [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];

  let idx = 0;
  function tryNext() {
    if (idx >= urls.length) { res.status(404).send('Not found'); return; }
    const url = urls[idx++];
    https.get(url, imgRes => {
      if (imgRes.statusCode === 200) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', `attachment; filename="thumbnail_${id}.jpg"`);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        imgRes.pipe(res);
      } else { tryNext(); }
    }).on('error', tryNext);
  }
  tryNext();
});

app.listen(PORT, () => {
  console.log(`✅ VidPull server running at http://localhost:${PORT}`);
});
