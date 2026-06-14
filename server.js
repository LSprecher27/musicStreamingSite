const express = require('express');
const fs = require('fs');
const path = require('path');
const mm = require('music-metadata');

const app = express();
const PORT = 4545;
const MUSIC_DIR = path.join(__dirname, 'music');

// Ensure music directory exists
if (!fs.existsSync(MUSIC_DIR)) {
    fs.mkdirSync(MUSIC_DIR);
}

// Serve static assets
app.use(express.static(__dirname));
app.use('/music', express.static(MUSIC_DIR));

// Memory cache for tracks
let trackCache = [];

// Helper to scan directory and extract tags
async function scanMusicDirectory() {
    try {
        const files = fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith('.mp3'));
        const tracks = [];

        for (let i = 0; i < files.length; i++) {
            const filename = files[i];
            const filePath = path.join(MUSIC_DIR, filename);
            
            try {
                const metadata = await mm.parseFile(filePath);
                
                tracks.push({
                    id: i,
                    filename: filename,
                    title: metadata.common.title || filename.replace('.mp3', ''),
                    artist: metadata.common.artist || 'Unknown Artist',
                    album: metadata.common.album || 'Unknown Album'
                });
            } catch (err) {
                // Fallback for files with broken/missing tags
                tracks.push({
                    id: i,
                    filename: filename,
                    title: filename.replace('.mp3', ''),
                    artist: 'Unknown Artist',
                    album: 'Unknown Album'
                });
            }
        }
        trackCache = tracks;
    } catch (error) {
        console.error("Directory scan error:", error);
    }
}

// API endpoint to fetch playlist data
app.get('/api/playlist', async (req, res) => {
    await scanMusicDirectory();
    res.json(trackCache);
});

// Stream audio file route
app.get('/stream-music', (req, res) => {
    const id = parseInt(req.query.id);
    const track = trackCache.find(t => t.id === id);
    if (!track) return res.status(404).send('Track not found');

    const filePath = path.join(MUSIC_DIR, track.filename);
    res.sendFile(filePath);
});

// Fetch album artwork route
app.get('/album-art', async (req, res) => {
    const id = parseInt(req.query.id);
    const track = trackCache.find(t => t.id === id);
    if (!track) return res.status(404).send('Not found');

    try {
        const filePath = path.join(MUSIC_DIR, track.filename);
        const metadata = await mm.parseFile(filePath);
        const picture = metadata.common.picture && metadata.common.picture[0];

        if (picture) {
            res.contentType(picture.format);
            return res.send(picture.data);
        }
    } catch (e) {}

    // Fallback placeholder image if no art is found
    res.redirect('https://placehold.co/500x500/282828/aaaaaa?text=No+Art');
});

app.listen(PORT, () => {
    console.log(`Streaming server running beautifully at http://localhost:${PORT}`);
});