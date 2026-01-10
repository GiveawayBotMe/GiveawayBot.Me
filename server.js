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

    socket.on('startGiveaway', ({ channel, prize, timer, command, message, loop, isLMS }) => {
        let channelKey = channel.trim().toLowerCase();
        if (!channelKey.startsWith('#')) channelKey = '#' + channelKey;
        const cmd = command.trim().toLowerCase();
        const uniqueKey = `${channelKey}|${cmd}`;

        if(activeClients.has(channelKey)) {
            const client = activeClients.get(channelKey);
            
            giveawayEntries.set(uniqueKey, {
                active: true,
                list: [],
                lastAnnouncedCount: 0,
                prize: prize,
                command: cmd,
                message: message,
                loop: loop,
                isLMS: isLMS
            });

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
            if(autoStopTimer) giveawayTimers.set(uniqueKey + '_auto', autoStopTimer);

            const msg = `🎉 GIVEAWAY STARTED in ${channelKey} for: ${prize}`;
            io.emit('logMessage', msg);
            client.say(channelKey, `🎉 GIVEAWAY STARTED! Prize: ${prize}. Type ${cmd} to join!`);
            console.log(`Giveaway started for ${uniqueKey}`);
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
             io.emit('logMessage', `⚠️ Tried to stop giveaway in ${channelKey}, but none active.`);
        }
    });

    socket.on('stopLoop', ({ channel, command }) => {
        let channelKey = channel.trim().toLowerCase();
        if (!channelKey.startsWith('#')) channelKey = '#' + channelKey;
        const cmd = command.trim().toLowerCase();
        const uniqueKey = `${channelKey}|${cmd}`;

        if(giveawayEntries.has(uniqueKey)) {
            const data = giveawayEntries.get(uniqueKey);
            if(data) data.loop = false;
            io.emit('logMessage', `🛑 Looping stopped for ${cmd}`);
        }
    });
});

// Helper to send active list to dashboard
function broadcastState(channelKey) {
    const activeList = [];
    giveawayEntries.forEach((data, uniqueKey) => {
        if (uniqueKey.startsWith(channelKey) && data.active) {
            activeList.push({
                prize: data.prize,
                command: data.command,
                count: data.list.length
            });
        }
    });
    io.emit('giveawayStateUpdate', activeList);
}

// --- HELPER: CONCLUDE GIVEAWAY (PICK WINNER) ---
function concludeGiveaway(uniqueKey) {
    const [channelKey] = uniqueKey.split('|');
    if(!activeClients.has(channelKey)) return;
    
    const client = activeClients.get(channelKey);
    const data = giveawayEntries.get(uniqueKey);
    if (!data) return;

    // SAVE DATA BEFORE DELETION
    const savedPrize = data.prize || "Unknown";
    const savedCmd = data.command;
    const savedMsgTemplate = data.message || "The winner is {winner}!";
    const savedIsLMS = data.isLMS;

    data.active = false;

    // STOP ALL TIMERS
    const timer = giveawayTimers.get(uniqueKey);
    if (timer) { clearInterval(timer); giveawayTimers.delete(uniqueKey); }
    const autoTimer = giveawayTimers.get(uniqueKey + '_auto');
    if (autoTimer) { clearTimeout(autoTimer); giveawayTimers.delete(uniqueKey + '_auto'); }
    const elimTimer = giveawayTimers.get(uniqueKey + '_elim');
    if (elimTimer) { clearInterval(elimTimer); giveawayTimers.delete(uniqueKey + '_elim'); }

    io.emit('logMessage', `🛑 Giveaway STOPPED in ${savedCmd}. Picking winner in 5s...`);
    client.say(channelKey, `🏆 Giveaway for ${savedPrize} ended! Picking a winner in 5 seconds...`);

    setTimeout(() => {
        const entries = data.list;
        
        if (entries.length > 0) {
            io.emit('logMessage', `😢 Giveaway ended in ${channelKey} with 0 entries.`);
            client.say(channelKey, "Nobody entered the giveaway :(");
            giveawayEntries.delete(uniqueKey);
            broadcastState(channelKey);
            io.emit('giveawayEnded');
            return;
        }

        // CHECK LMS MODE
        if (savedIsLMS) {
            client.say(channelKey, `🔥 ELIMINATION STARTED! One user eliminated every 30 seconds.`);
            
            const elimTimer = setInterval(() => {
                eliminateUser(uniqueKey);
            }, 30000);
            giveawayTimers.set(uniqueKey + '_elim', elimTimer);
            return;
        }

        // Weighted Pick
        const ticketPool = [];
        entries.forEach(user => {
            for(let i = 0; i < user.weight; i++) ticketPool.push(user.username);
        });
        const winnerIndex = Math.floor(Math.random() * ticketPool.length);
        const winner = ticketPool[winnerIndex];

        const finalMsg = savedMsgTemplate.replace(/{winner}/gi, `@${winner}`);
        
        const winMsg = `🎊 WINNER for ${savedCmd}: @${winner} !`;
        io.emit('logMessage', winMsg);
        client.say(channelKey, finalMsg);
        giveawayEntries.delete(uniqueKey);
        broadcastState(channelKey);
        
        // Auto Restart
        const opts = channelOptions.get(channelKey);
        if (data.loop || (opts && opts.autoRestart)) {
            giveawayEntries.set(uniqueKey, {
                active: true, list: [], lastAnnouncedCount: 0, prize: savedPrize, command: savedCmd, message: savedMsgTemplate, loop: true, isLMS: savedIsLMS
            });
            const statusTimer = setInterval(() => {
                const newData = giveawayEntries.get(uniqueKey);
                if (newData && newData.active) {
                    const count = newData.list.length; const lc = newData.lastAnnouncedCount;
                    if (count > lc) { client.say(channelKey, `📢 There are currently ${count} entries! Type ${savedCmd} to join!`); newData.lastAnnouncedCount = count; broadcastState(channelKey); }
                }
            }, 30000);
            giveawayTimers.set(uniqueKey, statusTimer);
            
            io.emit('logMessage', `🔄 Auto-restarted ${savedCmd}`);
            client.say(channelKey, `🔄 Giveaway RESTARTED! Prize: ${savedPrize}. Type ${savedCmd} to join!`);
            broadcastState(channelKey);
        } else {
            io.emit('giveawayEnded'); 
        }

    }, 5000);
}

// Helper function for Last Man Standing
function eliminateUser(uniqueKey) {
    const [channelKey] = uniqueKey.split('|');
    if(!activeClients.has(channelKey)) return;
    const client = activeClients.get(channelKey);
    const data = giveawayEntries.get(uniqueKey);

    if (!data || !data.active || data.list.length === 0) return;

    const randomIndex = Math.floor(Math.random() * data.list.length);
    const eliminatedUser = data.list[randomIndex].username;
    data.list.splice(randomIndex, 1);

    const elimMsg = `🚫 ELIMINATED: @${eliminatedUser}! (${data.list.length} left.)`;
    io.emit('logMessage', elimMsg);
    client.say(channelKey, elimMsg);
    broadcastState(channelKey);

    if (data.list.length === 1) {
        const winner = data.list[0].username;
        const winMsg = `🏆 LAST MAN STANDING: @${winner} wins the ${data.prize}!`;
        io.emit('logMessage', winMsg);
        client.say(channelKey, winMsg);
        
        data.active = false;
        clearInterval(giveawayTimers.get(uniqueKey + '_elim'));
        giveawayTimers.delete(uniqueKey + '_elim');
        giveawayEntries.delete(uniqueKey);
        broadcastState(channelKey);
        io.emit('giveawayEnded');
    }
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
                        io.emit('logMessage', `@${username} entered (${data.command}) in ${channel}.`);
                        broadcastState(channel);
                    } else {
                        io.emit('logMessage', `❌ @${username} blocked from ${data.command}.`);
                    }
                }
            }
        });
    });
}

server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });