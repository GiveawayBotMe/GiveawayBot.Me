// models/Settings.js
const mongoose = require('mongoose');

const GiveawayConfigSchema = new mongoose.Schema({
    name: { type: String, required: true }, // e.g., "Sub Night", "Friday Fun"
    command: { type: String, required: true, default: '!giveaway' }, // Custom command
    winnerMessage: { type: String, default: "Congratulations {winner}! You won!" }, // {winner} is a placeholder
    prize: { type: String, default: "Mystery Prize" }, // Default prize text
    timer: { type: Number, default: 0 },
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
    twitchId: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: true
    },
    
    // Global Options (Auto-restart applies to all for now)
    options: {
        followerOnly: { type: Boolean, default: false },
        subOnly: { type: Boolean, default: false },
        vipOnly: { type: Boolean, default: false },
        modOnly: { type: Boolean, default: false },
        bitsPerEntry: { type: Number, default: 0 },
        autoRestart: { type: Boolean, default: false }
    },

    // Store Multiple Giveaway Presets
    giveaways: [GiveawayConfigSchema]
});

module.exports = mongoose.model('Settings', SettingsSchema);