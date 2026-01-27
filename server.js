require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const session = require('express-session');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const Sentry = require("@sentry/node");

// ================= SENTRY CONFIGURATION =================
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: 1.0,
    });
}

const app = express();

// ================= CONFIGURATION =================
const PORT = process.env.PORT || 3000;

// DOMAIN CONFIGURATION
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000'; 
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:3000';
const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3001'; // Default to local bot port

// Session Secret
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_to_a_random_long_string';

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ Could not connect to MongoDB', err));

// Twitch App Credentials
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = `${AUTH_URL}/auth/twitch/callback`;

// GiveawayBot.me Credentials
const GAWB_API_KEY = process.env.GAWB_API_KEY;
const GAWB_WEBHOOK_SECRET = process.env.GAWB_WEBHOOK_SECRET;

// Global Bot Config
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_TOKEN = process.env.BOT_OAUTH;

// ================= DATABASE MODEL =================
const settingsSchema = new mongoose.Schema({
    broadcasterId: { type: String, required: true, unique: true },
    broadcasterName: String,
    accessToken: String, 
    
    // Giveaway State
    is_looping: { type: Boolean, default: false },
    current_prize: String,
    current_command: String,
    current_duration: Number,
    current_message: String,
    active_giveaway_id: { type: String },

    weights: {
        broadcaster: { type: Number, default: 1 },
        moderator: { type: Number, default: 5 },
        vip: { type: Number, default: 1 },
        t3: { type: Number, default: 1 },
        t2: { type: Number, default: 1 },
        t1: { type: Number, default: 1 },
        follower: { type: Number, default: 1 },
        viewer: { type: Number, default: 1 }
    },
    avatarUrl: { type: String }
});

const UserSettings = mongoose.model('UserSettings', settingsSchema);

// ================= MIDDLEWARE =================
app.use(bodyParser.json());
app.use(express.static('public'));

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

function ensureAuthenticated(req, res, next) {
    if (req.session && req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/');
}

// ================= ROUTES: WEB INTERFACE =================

app.get('/', (req, res) => {
    if (req.session.isAuthenticated) return res.redirect('/dashboard');
    res.sendFile('index.html', { root: 'public' });
});

app.get('/dashboard', ensureAuthenticated, (req, res) => {
    res.sendFile('dashboard.html', { root: 'public' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ================= ROUTES: API CONTROLS =================

// 1. Save Weights
app.post('/api/settings/weights', ensureAuthenticated, async (req, res) => {
    const uid = req.session.broadcasterId;
    const name = req.session.broadcasterName;
    const newWeights = req.body;

    try {
        const settings = await UserSettings.findOneAndUpdate(
            { broadcasterId: uid }, 
            { broadcasterName: name, weights: newWeights }, 
            { upsert: true, new: true }
        );
        res.json({ success: true, weights: settings.weights });
    } catch (error) {
        console.error("DB Save Error:", error);
        res.status(500).json({ error: 'Failed to save' });
    }
});

// 2. Get Weights
app.get('/api/settings/weights', ensureAuthenticated, async (req, res) => {
    const uid = req.session.broadcasterId;
    try {
        const settings = await UserSettings.findOne({ broadcasterId: uid });
        if (settings) return res.json(settings.weights);
        return res.json({ broadcaster: 1000, moderator: 500, vip: 200, t3: 150, t2: 50, t1: 10, follower: 2, viewer: 1 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch' });
    }
});

// 3. Get User Info (Fixes "Loading...")
app.get('/api/me', ensureAuthenticated, (req, res) => {
    // If we have it in Session, return that
    if (req.session.broadcasterName) {
        return res.json({
            username: req.session.broadcasterName,
            broadcasterId: req.session.broadcasterId
        });
    }
});

// 4. Get User Avatar (Cached - First DB, then Twitch API)
app.get('/api/me/avatar', ensureAuthenticated, async (req, res) => {
    const broadcasterId = req.session.broadcasterId;

    try {
        // 1. Check DB First (Cached)
        const userRecord = await UserSettings.findOne({ broadcasterId: broadcasterId });
        if (userRecord && userRecord.avatarUrl) {
            return res.json({ avatarUrl: userRecord.avatarUrl });
        }

        // 2. Fetch from Twitch API (Cached fallback)
        const response = await fetch(`https://api.twitch.tv/helix/users?id=${broadcasterId}`, {
            headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${req.session.accessToken}` }
        });
        const data = await response.json();
        if (data.data && data.data.length > 0) {
            const avatarUrl = data.data[0].profile_image_url;
            
            // 3. Cache it in DB (Fast)
            await UserSettings.findOneAndUpdate(
                { broadcasterId: broadcasterId },
                { avatarUrl: avatarUrl },
                { upsert: true }
            );
            
            res.json({ avatarUrl: avatarUrl });
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (error) {
        console.error("Failed to fetch avatar", error);
        res.status(500).json({ error: 'Failed to fetch avatar' });
    }
});

// 5. Start Giveaway
app.post('/api/giveaway/start', ensureAuthenticated, async (req, res) => {
    const { command, duration, message, is_looping, prize } = req.body;
    const uid = req.session.broadcasterId;
    const channelName = req.session.broadcasterName;

    if (!command || !duration || !message) return res.status(400).json({ error: 'Missing fields' });

    try {
        // 1. Get User's Current Weights
        const dbUser = await UserSettings.findOne({ broadcasterId: uid });
        const weights = dbUser ? dbUser.weights : { broadcaster: 1000, moderator: 500, vip: 200, t3: 150, t2: 50, t1: 10, follower: 2, viewer: 1 };

        // 2. 🔥 FIX: Save the Loop State to DB so the webhook knows what to do
        await UserSettings.findOneAndUpdate(
            { broadcasterId: uid },
            { 
                is_looping: is_looping, // Remember this!
                current_prize: prize,
                current_command: command,
                current_duration: duration,
                current_message: message
            },
            { upsert: true }
        );

        // 3. Call BOT WORKER API
        let response;
        try {
            response = await fetch(`${BOT_API_URL}/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channel: channelName,
                    command: command,
                    duration: duration,
                    prize: prize,
                    is_looping: is_looping, // <--- Send this to the bot
                    webhook_url: `${AUTH_URL}/webhook`,
                    broadcaster_id: uid
                })
            });
        } catch (fetchError) {
            console.error("Bot Unreachable:", fetchError.message);
            return res.status(503).json({ error: "Bot Worker is offline. Please check bot server logs." });
        }

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to start');

        // 🔥 FIX: Save the active giveaway ID to the database
        // This links the server to the bot's timer
        if (data.id) {
            await UserSettings.findOneAndUpdate(
                { broadcasterId: uid },
                { active_giveaway_id: data.id },
                { upsert: true }
            );
        }

        res.json({ success: true, id: data.id, command, is_looping });
    } catch (error) {
        console.error("Start Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 6. End Giveaway
app.post('/api/giveaway/end', ensureAuthenticated, async (req, res) => {
    const { giveawayId } = req.body;
    const channelName = req.session.broadcasterName;
    
    try {
        // 1. Pass ID in URL, not Body, to match bot's route
        const response = await fetch(`${BOT_API_URL}/end/${giveawayId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: channelName })
        });
        
        if (!response.ok) throw new Error('Failed to end');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Get Active Giveaway Status
app.get('/api/giveaway/status', ensureAuthenticated, async (req, res) => {
    const uid = req.session.broadcasterId;
    try {
        const userRecord = await UserSettings.findOne({ broadcasterId: uid });
        
        // If there is an ID stored in the DB, return it. Otherwise, return null.
        if (userRecord && userRecord.active_giveaway_id) {
            return res.json({ activeId: userRecord.active_giveaway_id });
        }
        
        return res.json({ activeId: null });
    } catch (error) {
        console.error("Status Fetch Error:", error);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// 8. Stop Loop Route
app.post('/api/giveaway/stop-loop', ensureAuthenticated, async (req, res) => {
    const uid = req.session.broadcasterId;
    try {
        // Turn off the loop switch in the database
        await UserSettings.findOneAndUpdate(
            { broadcasterId: uid },
            { is_looping: false }
        );
        console.log(`[Server] Loop disabled for user ${uid}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Error stopping loop:", error);
        res.status(500).json({ error: 'Failed to stop loop' });
    }
});

// ================= ROUTES: AUTH =================

app.get('/auth/twitch', (req, res) => {
    // 🔥 FIX: Check if user came from a specific page (Referer)
    const referer = req.get('Referer');
    
    // Default to dashboard if no referer found, or if referer is external
    // We save this to req.session so we can use it after Twitch redirects back
    if (referer && referer.includes(process.env.SITE_URL || 'http://localhost:3000')) {
        req.session.returnTo = referer;
    } else {
        req.session.returnTo = `${SITE_URL}/dashboard`;
    }

    const scope = 'chat:edit';
    const state = crypto.randomBytes(16).toString('hex'); 
    req.session.state = state;
    
    const authUrl = `https://id.twitch.tv/oauth2/authorize` +
        `?client_id=${TWITCH_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}` +
        `&state=${state}`;
    
    res.redirect(authUrl);
});

app.get('/auth/twitch/callback', async (req, res) => {
    const { code, state } = req.query;
    
    if (state !== req.session.state) {
        console.warn('Invalid State detected. Expected:', req.session.state, 'Got:', state);
        return res.status(403).send('Invalid State');
    }

    try {
        // ... (Your existing token fetch logic stays here) ...
        const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'post',
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI
            })
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error) throw new Error(tokenData.error);

        const userResponse = await fetch('https://api.twitch.tv/helix/users', {
            headers: { 'Client-Id': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const userData = await userResponse.json();
        const broadcasterData = userData.data[0];

        req.session.broadcasterId = broadcasterData.id;
        req.session.broadcasterName = broadcasterData.login;
        req.session.isAuthenticated = true;

        await UserSettings.findOneAndUpdate(
            { broadcasterId: broadcasterData.id },
            { 
                broadcasterName: broadcasterData.login, 
                accessToken: tokenData.access_token, 
                avatarUrl: broadcasterData.profile_image_url 
            },
            { upsert: true }
        );

        // 🔥 FIX: Redirect to the saved URL, or default to Dashboard
        const destination = req.session.returnTo || `${SITE_URL}/dashboard`;
        
        // Clear the returnTo so it doesn't interfere next time
        delete req.session.returnTo;
        
        res.redirect(destination);

    } catch (error) {
        console.error('Auth Error:', error);
        res.redirect(`${SITE_URL}?login=failed`);
    }
});

// ================= WEBHOOK =================

app.post('/webhook', async (req, res) => {
    // Verify Signature
    const signature = req.headers['x-hub-signature'] || req.headers['x-gawb-signature'];
    if (signature && GAWB_WEBHOOK_SECRET) {
        const hmac = crypto.createHmac('sha256', GAWB_WEBHOOK_SECRET);
        const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');
        if (signature !== digest) return res.status(403).send('Invalid Signature');
    }

    const payload = req.body;
    if (payload.type === 'giveaway_ended') {
        await processGiveawayEnd(payload);
    }
    res.status(200).send('OK');
});

// ================= HELPERS FOR GIVEAWAY LOGIC =================

// 1. Calculate Weighted Winner
function calculateWeightedWinner(entries, weights) {
    if (!weights) weights = {};
    
    let pool = [];
    
    entries.forEach(entry => {
        // Default weight
        let multiplier = weights.viewer || 1;

        // Check Subscriber Tier (Takes precedence over badges in this logic)
        if (entry.sub_tier) {
            const tier = entry.sub_tier.toString();
            if (tier === '3000') multiplier = weights.t3 || 1;
            else if (tier === '2000') multiplier = weights.t2 || 1;
            else if (tier === '1000') multiplier = weights.t1 || 1;
        } 
        // Fallback to Badges if not a sub
        else if (entry.badges) {
            if (entry.badges.broadcaster) multiplier = weights.broadcaster || 1;
            else if (entry.badges.moderator) multiplier = weights.moderator || 1;
            else if (entry.badges.vip) multiplier = weights.vip || 1;
        }

        // Add the user to the pool 'multiplier' times
        for (let i = 0; i < multiplier; i++) {
            pool.push(entry.username);
        }
    });

    if (pool.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * pool.length);
    return pool[randomIndex];
}

// 2. Announce via Bot
async function announceWinner(broadcaster_id, message) {
    // Note: To send chat as the bot, we need the Bot's User ID.
    // Since we don't have it here, we can fetch it (slow) or just rely on the fallback.
    // Ideally, cache the Bot ID globally or in DB.
    
    console.log(`[Announce] Bot announcement skipped (Implementation needed for Bot ID lookup) or falling back.`);
    throw new Error("Bot ID not implemented, falling back to streamer");
    
    /*
    // If you implement getBotUserId(), uncomment this:
    const botUserId = await getBotUserId();
    await fetch(`https://api.twitch.tv/helix/chat/messages`, {
        method: 'POST',
        headers: {
            'Client-Id': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${BOT_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            broadcaster_id: broadcaster_id,
            sender_id: botUserId,
            message: message
        })
    });
    */
}

// 3. Announce via Streamer (Fallback)
async function announceViaStreamer(broadcaster_id, accessToken, message) {
    console.log(`[Announce Fallback] Sending as streamer: ${message}`);

    await fetch(`https://api.twitch.tv/helix/chat/messages`, {
        method: 'POST',
        headers: {
            'Client-Id': TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            broadcaster_id: broadcaster_id,
            sender_id: broadcaster_id,
            message: message
        })
    });
}

// ================= MAIN PROCESSOR =================

async function processGiveawayEnd(payload) {
    const { entries, broadcaster_id } = payload;
    
    if (!broadcaster_id) return console.log("User not found in DB for webhook");

    // 1. Fetch User Settings
    const userRecord = await UserSettings.findOne({ broadcasterId: broadcaster_id });
    if (!userRecord) return console.log("User not found in DB for webhook");

    // 2. LOGIC CHECK: Is this a looping giveaway?
    if (userRecord.is_looping) {
        console.log(`[Loop] Giveaway ended for ${broadcaster_id}. Restarting...`);
        
        // Start a new one using the saved settings
        try {
            const nextPrize = userRecord.current_prize || "Nothing";
            const nextCmd = userRecord.current_command || "!join";
            const nextDuration = userRecord.current_duration || 60;
            const nextMsg = userRecord.current_message || "Congrats {user}, you won!";

            await fetch(`${BOT_API_URL}/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channel: userRecord.broadcasterName,
                    command: nextCmd,
                    duration: nextDuration,
                    prize: nextPrize,
                    is_looping: true, // Keep the loop going
                    webhook_url: `${AUTH_URL}/webhook`,
                    broadcaster_id: broadcaster_id
                })
            });
            console.log("[Loop] New giveaway started successfully.");
        } catch (loopError) {
            console.error("[Loop] Failed to restart giveaway:", loopError.message);
        }

        // STOP HERE. Do not pick a winner for a loop, and DO NOT clear the ID
        // because a new one is taking its place immediately.
        return;
    }

    // 3. NORMAL GIVEAWAY END (Non-looping)
    
    // 🔥 FIX: Clear the active ID from DB
    // This tells the frontend poller that the giveaway is gone.
    await UserSettings.findOneAndUpdate(
        { broadcasterId: broadcaster_id },
        { active_giveaway_id: null }
    );

    // Pick Winner
    if (entries && entries.length > 0) {
        const winner = calculateWeightedWinner(entries, userRecord.weights);
        const msg = `🎉 Winner is @${winner}!`;
        
        try {
            await announceWinner(broadcaster_id, msg);
        } catch (botError) {
            console.warn("⚠️ Bot failed to announce. Falling back to Streamer account.", botError.message);
            await announceViaStreamer(broadcaster_id, userRecord.accessToken, msg);
        }
    }
}

// ================= GLOBAL ERROR HANDLING =================
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION:', reason);
    Sentry.captureException(reason); // Send to Sentry if available
});

process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
    Sentry.captureException(err);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Auth URL: ${AUTH_URL}`);
    console.log(`Site URL: ${SITE_URL}`);
    console.log(`Bot API: ${BOT_API_URL}`);
});