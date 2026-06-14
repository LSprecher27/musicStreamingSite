const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mm = require('music-metadata');
const ffmpegPath = require('ffmpeg-static');
const MusicTempo = require('music-tempo');
const Pitchfinder = require('pitchfinder');

const app = express();
const PORT = process.env.PORT || 4545;
const MUSIC_DIR = path.join(__dirname, 'music');

async function decodeAudioFileToFloat32(filePath, maxDurationSeconds = 30) {
    return new Promise((resolve, reject) => {
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', filePath,
            '-t', String(maxDurationSeconds),
            '-ac', '1',
            '-ar', '44100',
            '-f', 'f32le',
            '-'
        ];

        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let stderr = '';
        let killed = false;

        // Set a hard timeout to kill the process if it hangs
        const killTimeout = setTimeout(() => {
            killed = true;
            ffmpeg.kill('SIGTERM');
        }, 30000);

        ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
        ffmpeg.stderr.on('data', chunk => stderr += chunk.toString());

        ffmpeg.on('error', (err) => {
            clearTimeout(killTimeout);
            reject(err);
        });

        ffmpeg.on('close', code => {
            clearTimeout(killTimeout);
            if (killed) {
                return reject(new Error('FFmpeg process timed out'));
            }
            if (code !== 0) {
                return reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
            }
            const buffer = Buffer.concat(chunks);
            const validLength = buffer.length - (buffer.length % 4);
            const floatBuffer = new Float32Array(buffer.buffer, buffer.byteOffset, validLength / 4);
            resolve(floatBuffer);
        });
    });
}

function estimateTempo(audioBuffer) {
    if (!audioBuffer || audioBuffer.length < 4096) return null;
    try {
        const tempoResult = new MusicTempo(audioBuffer);
        const tempo = tempoResult.tempo;
        if (!Number.isFinite(tempo) || tempo <= 30 || tempo >= 250) {
            return null;
        }
        return Math.round(tempo);
    } catch (e) {
        return null;
    }
}

function estimateKey(audioBuffer, sampleRate = 44100) {
    if (!audioBuffer || audioBuffer.length < 8192) return null;

    const detector = Pitchfinder.YIN({ sampleRate, threshold: 0.2, probabilityThreshold: 0.1 });
    const frameSize = 4096;
    const hopSize = 2048;
    const noteCounts = Array(12).fill(0);

    for (let offset = 0; offset + frameSize <= audioBuffer.length; offset += hopSize) {
        const frame = audioBuffer.subarray(offset, offset + frameSize);
        let energy = 0;
        for (let i = 0; i < frame.length; i++) {
            energy += frame[i] * frame[i];
        }
        energy /= frame.length;
        if (energy < 1e-6) continue;

        const freq = detector(frame);
        if (!freq || freq <= 0) continue;

        const midi = 69 + 12 * Math.log2(freq / 440);
        let noteIndex = Math.round(midi) % 12;
        if (noteIndex < 0) noteIndex += 12;
        noteCounts[noteIndex] += 1;
    }

    const totalPitches = noteCounts.reduce((total, count) => total + count, 0);
    if (totalPitches === 0) return null;

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const majorScale = [0, 2, 4, 5, 7, 9, 11];
    const minorScale = [0, 2, 3, 5, 7, 8, 10];
    let bestKey = null;
    let bestScore = -Infinity;

    for (let tonic = 0; tonic < 12; tonic++) {
        const majorScore = majorScale.reduce((score, interval) => score + (noteCounts[(tonic + interval) % 12] || 0), 0);
        const minorScore = minorScale.reduce((score, interval) => score + (noteCounts[(tonic + interval) % 12] || 0), 0);

        if (majorScore > bestScore) {
            bestScore = majorScore;
            bestKey = `${noteNames[tonic]} major`;
        }
        if (minorScore > bestScore) {
            bestScore = minorScore;
            bestKey = `${noteNames[tonic]} minor`;
        }
    }

    return bestKey;
}

async function analyzeTrackAudio(filePath) {
    try {
        // Add a timeout to prevent hanging on problematic files
        const analysisPromise = decodeAudioFileToFloat32(filePath, 30);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Audio analysis timeout')), 30000)
        );
        
        const audioBuffer = await Promise.race([analysisPromise, timeoutPromise]);
        return {
            bpm: estimateTempo(audioBuffer),
            key: estimateKey(audioBuffer)
        };
    } catch (err) {
        console.warn(`Audio analysis failed for ${filePath}:`, err.message);
        return { bpm: null, key: null };
    }
}

// Ensure music directory exists
if (!fs.existsSync(MUSIC_DIR)) {
    fs.mkdirSync(MUSIC_DIR);
}

// Middleware for better mobile/PWA support and background audio playback
app.use((req, res, next) => {
    // Allow background audio playback on mobile
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // Support for Media Session API
    res.setHeader('Permissions-Policy', 'autoplay=*, media-session=*');
    next();
});

// Serve static assets
app.use(express.static(__dirname));
app.use('/music', express.static(MUSIC_DIR));

// Memory cache for tracks
let trackCache = [];
let audioAnalysisInProgress = {};

async function getTracks() {
    if (trackCache.length === 0) {
        await scanMusicDirectory();
    }
    return trackCache;
}

// Helper to scan directory and extract metadata quickly (without audio analysis)
async function scanMusicDirectory() {
    try {
        const files = fs.readdirSync(MUSIC_DIR).filter(file => file.endsWith('.mp3'));
        const tracks = [];

        for (let i = 0; i < files.length; i++) {
            const filename = files[i];
            const filePath = path.join(MUSIC_DIR, filename);

            // Extract title and artist from filename (format: "Artist - Title.mp3")
            let title = filename.replace(/\.mp3$/i, '');
            let artist = 'Unknown Artist';
            
            const dashIndex = title.indexOf(' - ');
            if (dashIndex > 0) {
                artist = title.substring(0, dashIndex).trim();
                title = title.substring(dashIndex + 3).trim();
            }

            const track = {
                id: i,
                filename: filename,
                title: title,
                artist: artist,
                album: 'Unknown Album',
                bpm: null,
                key: null
            };

            tracks.push(track);
            
            // Trigger background metadata and audio analysis (non-blocking)
            enrichTrackInBackground(filePath, i);
        }
        trackCache = tracks;
    } catch (error) {
        console.error("Directory scan error:", error);
    }
}

// Background enrichment: parse metadata and audio analysis without blocking
async function enrichTrackInBackground(filePath, trackId) {
    if (audioAnalysisInProgress[trackId]) return;
    audioAnalysisInProgress[trackId] = true;

    try {
        // Try to get metadata
        try {
            const metadata = await Promise.race([
                mm.parseFile(filePath),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Metadata timeout')), 5000))
            ]);

            if (trackCache[trackId] && metadata.common) {
                if (metadata.common.title) trackCache[trackId].title = metadata.common.title;
                if (metadata.common.artist) trackCache[trackId].artist = metadata.common.artist;
                if (metadata.common.album) trackCache[trackId].album = metadata.common.album;
            }
        } catch (err) {
            // Metadata parsing failed or timed out, continue with audio analysis anyway
        }

        // Try audio analysis
        const analysis = await analyzeTrackAudio(filePath);
        if (trackCache[trackId]) {
            trackCache[trackId].bpm = analysis.bpm;
            trackCache[trackId].key = analysis.key;
            console.log(`Analyzed ${path.basename(filePath)}: BPM=${analysis.bpm}, Key=${analysis.key}`);
        }
    } catch (err) {
        console.warn(`Background enrichment failed for track ${trackId}:`, err.message);
    } finally {
        audioAnalysisInProgress[trackId] = false;
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

    // Fallback placeholder image if no art is found
    res.redirect('https://placehold.co/500x500/282828/aaaaaa?text=No+Art');
});

const server = app.listen(PORT, () => {
    console.log(`Streaming server running beautifully at http://localhost:${PORT}`);
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Set PORT to another value or stop the process using that port.`);
        process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
});