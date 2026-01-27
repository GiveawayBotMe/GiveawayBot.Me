require('dotenv').config();
const tmi = require('tmi.js');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');

// Storage for active giveaways
const giveawayTimers = new Map();
const giveawayEntries = new Map();

// ================= CONFIG =================
const PORT = process.env.PORT || 3001;
const BOT_USERNAME = process.env.BOT_USERNAME;
const BOT_OAUTH = process.env.BOT_OAUTH;

// ================= TWITCH CLIENT =================
const client = new tmi.Client({
    options: { debug: false },
    identity: {
        username: BOT_USERNAME,
        password: BOT_OAUTH
    },
    channels: [] 
});

client.connect().catch(console.error);

// Helpers for API Announcement
let cachedBotId = null;

async function getBotId() {
    if (cachedBotId) return cachedBotId;
    try {
        console.log("[Bot] Fetching Bot ID...");
        
        if (!process.env.TWITCH_CLIENT_ID) console.error("❌ Missing TWITCH_CLIENT_ID");
        if (!process.env.BOT_USERNAME) console.error("❌ Missing BOT_USERNAME");
        if (!process.env.BOT_OAUTH) console.error("❌ Missing BOT_OAUTH");
        
        const res = await fetch('https://api.twitch.tv/helix/users?login=' + process.env.BOT_USERNAME, {
            headers: { 
                'Client-Id': process.env.TWITCH_CLIENT_ID, 
                'Authorization': `Bearer ${process.env.BOT_OAUTH}` 
            }
        });
        
        const data = await res.json();
        console.log("[Bot] Twitch API Response:", data);

        if (data.data && data.data.length > 0) {
            cachedBotId = data.data[0].id;
            console.log(`[Bot] Found Bot ID: ${cachedBotId}`);
            return cachedBotId;
        } else {
            console.error("❌ Bot Username not found in Twitch API");
        }
    } catch (e) { 
        console.error("❌ Error fetching Bot ID:", e.message); 
    }
    return null;
}

// ================= HEALTH CHECKLIST =================

async function runHealthCheck() {
    console.log("\n================================================");
    console.log("       🤖️ GIVEAWAY BOT HEALTH CHECK");
    console.log("================================================\n");

    let allGood = true;

    console.log("1️⃣  Checking Environment Variables...");
    const requiredEnv = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'BOT_USERNAME', 'BOT_OAUTH'];
    requiredEnv.forEach(key => {
        if (process.env[key]) {
            console.log(`   ✅ ${key}: Loaded`);
        } else {
            console.log(`   ❌ ${key}: MISSING`);
            allGood = false;
        }
    });

    console.log("\n2️⃣  Checking Bot Token Validity...");
    if (process.env.BOT_USERNAME && process.env.BOT_OAUTH && process.env.TWITCH_CLIENT_ID) {
        try {
            const res = await fetch('https://api.twitch.tv/helix/users?login=' + process.env.BOT_USERNAME, {
                headers: { 
                    'Client-Id': process.env.TWITCH_CLIENT_ID, 
                    'Authorization': `Bearer ${process.env.BOT_OAUTH}` 
                }
            });
            if (res.status === 200) {
                const data = await res.json();
                if (data.data && data.data.length > 0) {
                    console.log(`   ✅ Token Valid. Account: @${data.data[0].display_name}`);
                    console.log(`   ✅ User ID: ${data.data[0].id}`);
                    cachedBotId = data.data[0].id;
                } else {
                    console.log(`   ❌ Token Valid, but Username '${process.env.BOT_USERNAME}' not found.`);
                    allGood = false;
                }
            } else {
                const errText = await res.text();
                console.log(`   ❌ Token Invalid. Twitch responded: ${res.status} ${errText}`);
                allGood = false;
            }
        } catch (e) {
            console.log(`   ❌ Network Error checking token: ${e.message}`);
            allGood = false;
        }
    } else {
        console.log("   ⏭️  Skipped (Missing Credentials)");
        allGood = false;
    }

    console.log("\n================================================");
    if (allGood) {
        console.log("       ✅ ALL CHECKS PASSED. BOT READY.");
        console.log("================================================\n");
    } else {
        console.log("       ❌ CHECKS FAILED. FIX ERRORS ABOVE.");
        console.log("================================================\n");
    }
}

runHealthCheck();

// ================= API SERVER =================
const app = express();
app.use(express.json());

// Store active giveaways in memory
let activeGiveaways = {}; 

app.post('/create', async (req, res) => {
    const { channel, command, duration, webhook_url, broadcaster_id, prize } = req.body;
    
    console.log(`[Bot Server] Starting giveaway in ${channel}`);

    try {
        await client.join(channel);
    } catch (e) {
        console.error("Failed to join channel", e);
        return res.status(500).json({ error: "Failed to join channel: " + e.message });
    }

    await new Promise(r => setTimeout(r, 2000));

    try {
        await new Promise((resolve) => {
            if (client.readyState() === 'OPEN') return resolve();
            client.once('connected', (address, port) => {
                console.log(`[Bot] Connected via address ${address}:${port}`);
                resolve();
            });
        });

        const botId = await getBotId();
        if (botId) {
            await fetch('https://api.twitch.tv/helix/chat/messages', {
                method: 'POST',
                headers: {
                    'Client-Id': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${process.env.BOT_OAUTH}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    broadcaster_id: broadcaster_id,
                    sender_id: botId,
                    message: `🎉 Giveaway for ${prize} started! Type ${command} to enter!`
                })
            });
            console.log("[Bot Server] Announced via API");
        } else {
            console.error("❌ Could not get Bot ID to announce");
        }
        
    } catch (sayError) {
        console.error("❌ Announcement failed:", sayError.message);
    }

    const entries = [];
    const giveawayId = Date.now().toString();
    
    // Store entries in the main map
    giveawayEntries.set(giveawayId, entries); 
    
    const listener = (target, context, msg, self) => {
        if (self || !msg.startsWith(command)) return;
        const username = context.username;
        
        if (!entries.find(e => e.username === username)) {
            entries.push({ 
                username: username, 
                badges: context.badges,
                sub_tier: context.subscriber 
            });
            console.log(`[Bot] Entry added: @${username}`);
        }
    };

    client.on('message', listener);

    const timer = setTimeout(async () => {
        stopGiveawayLogic(giveawayId, channel, listener, webhook_url, command, broadcaster_id);
    }, duration * 1000);

    giveawayTimers.set(giveawayId, timer);

    // === STATUS TIMER ===
    const statusInterval = setInterval(() => {
        if (giveawayEntries.has(giveawayId)) {
            const currentEntries = giveawayEntries.get(giveawayId);
            const count = currentEntries.length;
            
            if (count > 0) {
                const msg = `📢 There are currently ${count} entries! Type ${command} to join!`;
                console.log(`[Bot] Status update for ${giveawayId}: ${count} entries`);
                client.say(channel, msg);
            }
        } else {
            console.log(`[Bot] Giveaway ${giveawayId} ended naturally. Stopping status updates.`);
            clearInterval(statusInterval);
            giveawayTimers.delete(giveawayId + '_status');
        }
    }, 30000);

    giveawayTimers.set(giveawayId + '_status', statusInterval);
    
    // === 🔥 FIX: STORE THE LISTENER IN activeGiveaways ===
    // We need to store the listener, channel, webhook, etc., so we can stop it early later.
    activeGiveaways[giveawayId] = {
        listener: listener,
        channel: channel,
        webhook_url: webhook_url,
        command: command,
        broadcaster_id: broadcaster_id
    };
    
    res.json({ success: true, id: giveawayId });
});

// Helper: Logic to stop a giveaway
function stopGiveawayLogic(id, channel, listener, webhook_url, command, broadcaster_id) {
    console.log(`[Bot Server] Concluding giveaway ${id}`);
    
    // === 🔥 FIX: SAFETY CHECK FOR LISTENER ===
    // If listener is null (e.g. ending early without it passed), we can't remove it safely.
    if (listener && typeof listener === 'function') {
        client.removeListener('message', listener);
    }
    
    const entries = giveawayEntries.get(id);
    giveawayEntries.delete(id);
    
    const statusInterval = giveawayTimers.get(id + '_status');
    if (statusInterval) clearInterval(statusInterval);
    giveawayTimers.delete(id + '_status');
    
    console.log(`[Bot Server] Entries: ${entries ? entries.length : 0}`);

    if (entries && entries.length > 0) {
        const winner = entries[Math.floor(Math.random() * entries.length)];
        const winnerMsg = `🏆 Winner is @${winner.username}!`;
        
        console.log(`[Bot Server] Winner: ${winner.username}`);
        client.say(channel, winnerMsg);

        if (webhook_url && broadcaster_id) {
            fetch(webhook_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'giveaway_ended',
                    entries: entries,
                    broadcaster_id: broadcaster_id,
                    original_command: command
                })
            }).catch(e => console.error("[Bot Server] Webhook failed", e.message));
        }
    } else {
        console.log("[Bot Server] No entries.");
        client.say(channel, "No one entered the giveaway :(");
    }
}

// ================= GLOBAL ERROR HANDLING =================
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
});

// Route to End Giveaway Early
app.post('/end/:id', (req, res) => {
    const id = req.params.id;
    
    console.log(`[Bot Server] Request to end early: ${id}`);

    // === 🔥 FIX: RETRIEVE DATA FROM activeGiveaways ===
    const giveawayData = activeGiveaways[id];
    const timer = giveawayTimers.get(id);

    if (timer && giveawayData) {
        // 1. Stop the timer
        clearTimeout(timer);
        giveawayTimers.delete(id); // Clean up timer

        // 2. Extract data needed for stopGiveawayLogic
        const { channel, listener, webhook_url, command, broadcaster_id } = giveawayData;

        // 3. Trigger the winner logic (Pass the ACTUAL listener now)
        stopGiveawayLogic(id, channel, listener, webhook_url, command, broadcaster_id);

        // 4. Clean up activeGiveaways
        delete activeGiveaways[id];

        res.json({ success: true });
    } else {
        console.log(`[Bot Server] ⚠️ Giveaway ${id} not found (Timer or Data missing).`);
        res.status(404).json({ error: "Giveaway not found" });
    }
});

app.listen(PORT, () => {
    console.log(`Bot Server listening on port ${PORT}`);
});