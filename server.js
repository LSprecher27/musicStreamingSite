const express = require('express');
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 4545;
const MUSIC_DIR = path.join(__dirname, 'music');

async function parseTrackMetadata(filePath, timeoutMs = 5000) {
    try {
        const metadata = await Promise.race([
            mm.parseFile(filePath),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Metadata timeout')), timeoutMs))
        ]);
        return metadata;
    } catch (err) {
        return null;
    }
}

// Ensure music directory exists
if (!fs.existsSync(MUSIC_DIR)) {
    fs.mkdirSync(MUSIC_DIR);
}

// Middleware for better mobile/PWA support and background audio playback
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Permissions-Policy', 'autoplay=*, media-session=*');
    next();
});

// Serve static assets
app.use(express.static(__dirname));
app.use('/music', express.static(MUSIC_DIR));

// Memory cache for tracks
let trackCache = [];

async function getTracks() {
    if (trackCache.length === 0) {
        await scanMusicDirectory();
    }
    return trackCache;
}

// Helper to scan directory and extract metadata quickly
async function scanMusicDirectory() {
    try {
        const files = fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith('.mp3'));
        const tracks = [];

        for (let i = 0; i < files.length; i++) {
            const filename = files[i];
            const filePath = path.join(MUSIC_DIR, filename);

            let title = filename.replace(/\.mp3$/i, '');
            let artist = 'Unknown Artist';
            let album = 'Unknown Album';

            const dashIndex = title.indexOf(' - ');
            if (dashIndex > 0) {
                artist = title.substring(0, dashIndex).trim();
                title = title.substring(dashIndex + 3).trim();
            }

            const metadata = await parseTrackMetadata(filePath);
            if (metadata && metadata.common) {
                if (metadata.common.title) title = metadata.common.title;
                if (metadata.common.artist) artist = metadata.common.artist;
                if (metadata.common.album) album = metadata.common.album;
            }

            const track = {
                id: i,
                filename: filename,
                title: title,
                artist: artist,
                album: album,
                bpm: null,
                key: null
            };

            tracks.push(track);
        }
        trackCache = tracks;
    } catch (error) {
        console.error("Directory scan error:", error);
    }
}

// API endpoint to fetch playlist data
app.get('/api/playlist', async (req, res) => {
    const tracks = await getTracks();
    res.json(tracks);
});

// Stream audio file route
app.get('/stream-music', async (req, res) => {
    const id = parseInt(req.query.id, 10);
    const tracks = await getTracks();
    const track = tracks.find(t => t.id === id);

    if (!track) {
        return res.status(404).send('Track not found');
    }

    const filePath = path.join(MUSIC_DIR, track.filename);
    res.sendFile(filePath);
});

// Fetch album artwork route
app.get('/album-art', async (req, res) => {
    const id = parseInt(req.query.id, 10);
    const tracks = await getTracks();
    const track = tracks.find(t => t.id === id);

    if (!track) {
        return res.status(404).send('Not found');
    }

    try {
        const filePath = path.join(MUSIC_DIR, track.filename);
        const metadata = await mm.parseFile(filePath);
        const picture = metadata.common.picture && metadata.common.picture[0];

        if (picture) {
            res.contentType(picture.format);
            return res.send(picture.data);
        }
    } catch (e) {
        console.error('Artwork parse error:', e.message);
    }

    res.redirect('https://placehold.co/500x500/282828/aaaaaa?text=No+Art');
});

const server = app.listen(PORT, () => {
    console.log(`Streaming server running beautifully at http://localhost:${PORT}`);
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
});