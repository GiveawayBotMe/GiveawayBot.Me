// models/Settings.js
const mongoose = require('mongoose');

const GiveawayConfigSchema = new mongoose.Schema({
    name: { type: String, required: true },
    command: { type: String, required: true, default: '!giveaway' },
    winnerMessage: { type: String, default: "Congratulations {winner}!" },
    prize: { type: String, default: "Mystery Prize" },
    timer: { type: Number, default: 0 },
    isLMS: { type: Boolean, default: false },
    weights: {
        default: { type: Number, default: 1 },
        vip: { type: Number, default: 1 },
        mod: { type: Number, default: 1 },
        t1: { type: Number, default: 1 },
        t2: { type: Number, default: 1 },
        t3: { type: Number, default: 1 }
    },
    allow: {
        default: { type: Boolean, default: true },
        vip: { type: Boolean, default: true },
        mod: { type: Boolean, default: true },
        t1: { type: Boolean, default: true },
        t2: { type: Boolean, default: true },
        t3: { type: Boolean, default: true }
    }
});

const SettingsSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    
    options: {
        followerOnly: { type: Boolean, default: false },
        subOnly: { type: Boolean, default: false },
        vipOnly: { type: Boolean, default: false },
        modOnly: { type: Boolean, default: false },
        bitsPerTicket: { type: Number, default: 0 }, // NEW: How many bits for 1 ticket
        autoRestart: { type: Boolean, default: false }
    },

    giveaways: [GiveawayConfigSchema]
});

module.exports = mongoose.model('Settings', SettingsSchema);