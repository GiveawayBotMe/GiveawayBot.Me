// server.js
require('dotenv').config(); 
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const tmi = require('tmi.js');

const connectDB = require('./config/db');
const Settings = require('./models/Settings');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

connectDB();
app.use(express.json());
app.use(express.static('public')); 

app.get('/api/settings', async (req, res) => {
    try {
        const { username } = req.query;
        const settings = await Settings.findOne({ username: username.toLowerCase() });
        if (!settings) return res.status(404).json({ message: "User not found" });
        res.json(settings);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', async (req, res) => {
    try {
        const { username, options, weights, allow, giveaways } = req.body;
        const updateData = { username: username.toLowerCase() };
        if (options) updateData.options = options;
        if (weights) updateData.weights = weights;
        if (allow) updateData.allow = allow;
        if (giveaways) updateData.giveaways = giveaways;

        const updatedSettings = await Settings.findOneAndUpdate(
            { username: username.toLowerCase() },
            updateData,
            { upsert: true, new: true, setDefaultsOnSave: true }
        );
        res.json({ success: true });
        io.emit('settingsUpdated', updatedSettings);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
    console.log('User connected');

    socket.on('joinStreamer', (username) => {
        const newChannel = username.trim().toLowerCase();
        if (activeClients.size > 0) {
            activeClients.forEach((client, oldChannel) => {
                if (oldChannel !== newChannel) {
                    client.part(oldChannel).catch(err => console.log(err));
                    activeClients.delete(oldChannel);
                }
            });
        }
        startBotForChannel(newChannel);
    });

    socket.on('startGiveaway', ({ channel, prize, timer, command, message, loop }) => {
        let channelKey = channel.trim().toLowerCase();
        if (!channelKey.startsWith('#')) channelKey = '#' + channelKey;
        const cmd = command.trim().toLowerCase();
        const uniqueKey = `${channelKey}|${cmd}`;

        if(activeClients.has(channelKey)) {
            const client = activeClients.get(channelKey);
            
            // 1. Initialize Data
            giveawayEntries.set(uniqueKey, {
                active: true,
                list: [],
                lastAnnouncedCount: 0,
                prize: prize,
                command: cmd,
                message: message,
                loop: loop
            });

            // 2. Status Timer
            const statusTimer = setInterval(() => {
                const data = giveawayEntries.get(uniqueKey);
                if (data && data.active) {
                    const count = data.list.length;
                    const lastCount = data.lastAnnouncedCount;
                    if (count > lastCount) {
                        client.say(channelKey, `📢 There are currently ${count} entries! Type ${cmd} to join!`);
                        data.lastAnnouncedCount = count;
                        broadcastState(channelKey);
                    }
                }
            }, 30000); 
            giveawayTimers.set(uniqueKey, statusTimer);

            // 3. Auto-Timer
            let autoStopTimer = null;
            if (timer && timer > 0) {
                const ms = timer * 60 * 1000; 
                client.say(channelKey, `⏰ Giveaway ends in ${timer} minute(s)!`);
                autoStopTimer = setTimeout(() => {
                    if (giveawayEntries.has(uniqueKey) && giveawayEntries.get(uniqueKey).active) {
                        concludeGiveaway(uniqueKey);
                    }
                }, ms);
                giveawayTimers.set(uniqueKey + '_auto', autoStopTimer);
            }

            // 4. Send Start Message
            const msg = `🎉 GIVEAWAY STARTED! Prize: ${prize}. Type ${cmd} to join!`;
            io.emit('logMessage', msg);
            client.say(channelKey, msg);
            broadcastState(channelKey);
        }
    });

    socket.on('stopGiveaway', ({ channel, command }) => {
        let channelKey = channel.trim().toLowerCase();
        if (!channelKey.startsWith('#')) channelKey = '#' + channelKey;
        const cmd = command.trim().toLowerCase();
        const uniqueKey = `${channelKey}|${cmd}`;

        if(giveawayEntries.has(uniqueKey)) {
            concludeGiveaway(uniqueKey);
        } else {
             io.emit('logMessage', `⚠️ No active giveaway found for ${cmd}`);
        }
    });
    
    socket.on('stopLoop', ({ channel, command }) => {
        let channelKey = channel.trim().toLowerCase();
        if (!channelKey.startsWith('#')) channelKey = '#' + channelKey;
        const cmd = command.trim().toLowerCase();
        const uniqueKey = `${channelKey}|${cmd}`;

        if(giveawayEntries.has(uniqueKey)) {
            const data = giveawayEntries.get(uniqueKey);
            data.loop = false; // Just turn off the loop flag
            io.emit('logMessage', `🛑 Looping stopped for ${cmd}. Giveaway continues normally.`);
        }
    });
});

// Helper to send active list to dashboard
function broadcastState(channelKey) {
    const activeList = [];
    // Iterate all giveaways and filter for this channel
    giveawayEntries.forEach((data, uniqueKey) => {
        if (uniqueKey.startsWith(channelKey) && data.active) {
            activeList.push({
                prize: data.prize,
                command: data.command,
                count: data.list.length
            });
        }
    });
    // In a real app with multiple users, you'd target specific socket room.
    // For now, broadcast to everyone.
    io.emit('giveawayStateUpdate', activeList);
}

// --- HELPER: CONCLUDE GIVEAWAY ---
function concludeGiveaway(uniqueKey) {
    const [channelKey] = uniqueKey.split('|');
    if(!activeClients.has(channelKey)) return;
    
    const client = activeClients.get(channelKey);
    const data = giveawayEntries.get(uniqueKey);
    if (!data) return;

    data.active = false;

    // STOP TIMERS
    const timer = giveawayTimers.get(uniqueKey);
    if (timer) { clearInterval(timer); giveawayTimers.delete(uniqueKey); }
    const autoTimer = giveawayTimers.get(uniqueKey + '_auto');
    if (autoTimer) { clearTimeout(autoTimer); giveawayTimers.delete(uniqueKey + '_auto'); }

    io.emit('logMessage', `🛑 Giveaway stopped for ${data.command}. Picking winner in 5s...`);
    client.say(channelKey, `🏆 Giveaway for ${data.prize} ended! Picking winner in 5 seconds...`);

    setTimeout(() => {
        const entries = data.list;
        const prize = data.prize || "Unknown";
        const cmd = data.command;
        const msgTemplate = data.message || "The winner is {winner}!";
        
        if (entries.length > 0) {
            // Weighted Pick
            const ticketPool = [];
            entries.forEach(user => {
                for(let i = 0; i < user.weight; i++) ticketPool.push(user.username);
            });
            const winnerIndex = Math.floor(Math.random() * ticketPool.length);
            const winner = ticketPool[winnerIndex];

            // Custom Message
            const finalMsg = msgTemplate.replace(/{winner}/gi, `@${winner}`);
            
            const winMsg = `🎊 WINNER for ${cmd}: @${winner} !`;
            io.emit('logMessage', winMsg);
            client.say(channelKey, finalMsg);
            giveawayEntries.delete(uniqueKey);
            broadcastState(channelKey); // Remove from UI list
            
            // Auto Restart
            if (data.loop) {
                // Reset Data
                giveawayEntries.set(uniqueKey, {
                    active: true, list: [], lastAnnouncedCount: 0, prize, cmd, message: msgTemplate, loop: true
                });
                // Restart Timers
                const statusTimer = setInterval(() => {
                    const d = giveawayEntries.get(uniqueKey);
                    if (d && d.active) {
                        const c = d.list.length; const lc = d.lastAnnouncedCount;
                        if (c > lc) { client.say(channelKey, `📢 There are currently ${c} entries! Type ${cmd} to join!`); d.lastAnnouncedCount = c; broadcastState(channelKey); }
                    }
                }, 30000);
                giveawayTimers.set(uniqueKey, statusTimer);
                io.emit('logMessage', `🔄 Auto-restarted ${cmd}`);
                client.say(channelKey, `🔄 Giveaway RESTARTED! Prize: ${prize}. Type ${cmd} to join!`);
                broadcastState(channelKey); // Add back to UI list
            }

        } else {
            io.emit('logMessage', `😢 0 entries for ${cmd}.`);
            client.say(channelKey, "Nobody entered the giveaway :(");
            giveawayEntries.delete(uniqueKey);
            broadcastState(channelKey);
        }
    }, 5000);
}

// 5. Twitch Bot Logic
const activeClients = new Map();
const giveawayEntries = new Map();
const giveawayTimers = new Map();
const channelWeights = new Map();
const channelAllow = new Map();
const channelOptions = new Map();

async function startBotForChannel(channelName) {
    let cleanName = channelName.trim().toLowerCase();
    if (!cleanName.startsWith('#')) cleanName = '#' + cleanName;
    if (activeClients.has(cleanName)) return;

    const client = new tmi.Client({
        identity: { username: process.env.BOT_USERNAME, password: process.env.BOT_OAUTH },
        channels: [cleanName]
    });

    client.connect().catch(err => console.error(err));
    activeClients.set(cleanName, client);

    // Load Settings
    let currentWeights = { default: 1, vip: 1, mod: 1, t1: 1, t2: 1, t3: 1 };
    let currentAllow = { default: true, vip: true, mod: true, t1: true, t2: true, t3: true };
    let currentOptions = { autoRestart: false };
    
    try {
        const settings = await Settings.findOne({ username: cleanName.replace('#','') });
        if (settings) {
            if (settings.weights) currentWeights = settings.weights;
            if (settings.allow) currentAllow = settings.allow;
            if (settings.options) currentOptions = settings.options;
        }
    } catch (err) { console.log("Could not load settings."); }
    
    channelWeights.set(cleanName, currentWeights);
    channelAllow.set(cleanName, currentAllow);
    channelOptions.set(cleanName, currentOptions);

    client.on('connected', (addr, port) => {
        console.log(`* Bot connected to ${cleanName}`);
        io.emit('botConnected', cleanName); 
    });
    
    client.on('message', (channel, tags, message, self) => {
        if (self) return; 
        const content = message.toLowerCase();
        
        giveawayEntries.forEach((data, uniqueKey) => {
            if (data.active && content === data.command) {
                const entries = data.list;
                const username = tags.username;
                
                if (!entries.some(e => e.username === username)) {
                    const w = channelWeights.get(channel) || { default: 1 };
                    const a = channelAllow.get(channel) || { default: true, vip: true, mod: true, t1: true, t2: true, t3: true };
                    
                    let weight = w.default; let allowed = a.default;

                    if (tags.badges && tags.badges.moderator) { weight = w.mod; allowed = a.mod; } 
                    else if (tags.badges && tags.badges.vip) { weight = w.vip; allowed = a.vip; }
                    else if (tags.subscriber) {
                        const pk = (tags.subPlan === 'Prime') ? 't1' : 't' + tags.subPlan; 
                        weight = w[pk] || w.t1; allowed = a[pk] || a.t1;
                    }

                    if (allowed) {
                        entries.push({ username, weight });
                        io.emit('logMessage', `@${username} entered (${data.command})`);
                        broadcastState(channel); // Update UI count
                    } else {
                        io.emit('logMessage', `❌ @${username} blocked from ${data.command}.`);
                    }
                }
            }
        });
    });
}

server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });