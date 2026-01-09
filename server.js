// server.js
require('dotenv').config(); // Load secrets from .env
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const tmi = require('tmi.js');
const path = require('path');

// Import our custom files
const connectDB = require('./config/db');
const Settings = require('./models/Settings');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 1. Connect to Database
connectDB();

// 2. Middleware (Setup)
app.use(express.json());
app.use(express.static('public')); // Serve files from the 'public' folder

// 3. Web Routes (API)
// Endpoint to get settings for a specific user
app.get('/api/settings', async (req, res) => {
    try {
        const { username } = req.query;
        const settings = await Settings.findOne({ username: username.toLowerCase() });
        if (!settings) return res.status(404).json({ message: "User not found" });
        res.json(settings.options);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint to save/update settings
app.post('/api/settings', async (req, res) => {
    try {
        const { username, options } = req.body;
        
        // Update settings if user exists, or create new if not
        const updatedSettings = await Settings.findOneAndUpdate(
            { username: username.toLowerCase() },
            { options },
            { upsert: true, new: true, setDefaultsOnSave: true }
        );
        
        res.json({ success: true, message: "Settings saved" });
        
        // Notify the bot to update its logic if it's running
        io.emit('settingsUpdated', updatedSettings);
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Socket.IO (Real-time communication between website and bot)
io.on('connection', (socket) => {
    console.log('A user connected to the dashboard');

    // When the website wants to start the bot for a channel
    socket.on('joinStreamer', (username) => {
        startBotForChannel(username.toLowerCase());
    });

    // Commands from Website
    socket.on('startGiveaway', ({ channel, prize }) => {
        if(activeClients.has(channel)) {
            const client = activeClients.get(channel);
            client.say(channel, `🎉 GIVEAWAY STARTED! Prize: ${prize}. Type !enter to join!`);
            
            // Logic to set active state would go here
            // For now, we just send a chat message
        }
    });

    socket.on('stopGiveaway', (channel) => {
        if(activeClients.has(channel)) {
            const client = activeClients.get(channel);
            client.say(channel, `🏆 Giveaway ended! Picking a winner...`);
            // Winner logic would go here
        }
    });
});

// 5. Twitch Bot Logic
const activeClients = new Map(); // Stores bot connections

function startBotForChannel(channelName) {
    // If bot is already running for this channel, don't restart it
    if (activeClients.has(channelName)) return;

    console.log(`Starting bot for channel: ${channelName}`);

    const client = new tmi.Client({
        identity: {
            username: process.env.BOT_USERNAME,
            password: process.env.BOT_OAUTH
        },
        channels: [channelName]
    });

    client.connect().catch(console.error);
    activeClients.set(channelName, client);

    client.on('message', (channel, tags, message, self) => {
        if (self) return; // Ignore messages from the bot itself

        // Basic Command Logic
        if (message.toLowerCase() === '!enter') {
            // TODO: Here is where we would check Follower/Sub status later
            // TODO: Here is where we would check Bits logic later
            
            client.say(channel, `@${tags.username} has entered the giveaway!`);
            console.log(`[Entry] ${tags.username} entered in ${channel}`);
        }
    });
}

// 6. Start Server
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});