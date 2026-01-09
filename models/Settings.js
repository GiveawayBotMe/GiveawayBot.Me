// models/Settings.js
const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
    twitchId: {
        type: String,
        required: true,
        unique: true // Makes sure we don't create duplicate accounts for the same streamer
    },
    username: {
        type: String,
        required: true
    },
    
    // The specific features you wanted
    options: {
        followerOnly: { type: Boolean, default: false },
        subOnly: { type: Boolean, default: false },
        vipOnly: { type: Boolean, default: false },
        modOnly: { type: Boolean, default: false },
        bitsPerEntry: { type: Number, default: 0 }
    }
});

// Export the model so we can use it in other files (like server.js)
module.exports = mongoose.model('Settings', SettingsSchema);