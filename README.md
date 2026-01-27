# GiveawayBot.Me

GiveawayBot.Me is a fully-featured, Twitch-integrated giveaway bot designed for streamers who want to manage multiple giveaways simultaneously with advanced role weighting, auto-looping, and elimination modes.

## 🌟 Features

### Core Giveaway System
*   **Multiple Concurrent Giveaways:** Run as many giveaways as you want at the same time (e.g., `!subnight` and `!bits` running simultaneously).
*   **Role Restrictions:** Toggle which roles are allowed to enter (e.g., Subs only).
*   **Custom Commands:** Define unique commands for each giveaway (e.g., `!enter`, `!gaw`, `!bonus`).
*   **Custom Messages:** Personalize the winner announcement message (supports `{winner}` placeholder).
*   **Silent Entry Logic:** Entries are tracked internally without spamming chat, with periodic status updates.
*   **Last Man Standing (LMS):** Eliminate users randomly every 30 seconds until one winner remains.

### Management Interface
*   **Unified Dashboard:** A single-page web interface (`dashboard.html`) containing all controls.
    *   **Active Giveaways:** View and stop currently running giveaways.
    *   **Start New:** Manually create giveaways with full control (Timer, Loop, LMS).
    *   **Weights & Roles:** Configure global multipliers and entry restrictions.

### Bot Integration
*   **Easy Connection:** Simply connect your Twitch account upon loading website.
*   **Secure Data:** All settings and configurations are stored securely in MongoDB.
*   **No Twitch API Required:** Basic chat functions work without complex API registration (for entry logic).

## 🚀 How to Use

1.  **Connect:** Enter your Twitch channel name in the dashboard and click **Connect**.
2.  **Configure:** Go to the **Weights & Roles** tab to set up your entry multipliers.
3.  **Preset (Optional):** Go to the **Presets** tab to save common giveaway setups (e.g., "Sub Night" with Sub-only weight).
4.  **Start:** Go to the **Start New** tab, select a preset or enter details manually.
    *   Toggle **Loop** if you want the giveaway to restart automatically.
    *   Toggle **LMS** if you want elimination mode.
5.  **Monitor:** Watch the **Active Giveaways** list and Console to track entries.

## 🔗 Links

*   **Live Dashboard:** [https://giveawaybot.me](https://giveawaybot.me)
*   **Feature Requests / Tips:** [https://somerewardsfriday.me/pages/giveawaybotme](https://somerewardsfriday.me/pages/giveawaybotme)

## 🛠 Tech Stack

*   **Backend:** Node.js with Express
*   **Database:** MongoDB (Mongoose)
*   **Twitch Integration:** tmi.js (Twitch Chat)
*   **Real-time:** Socket.io
*   **Frontend:** HTML5, CSS3, JavaScript

---

**Note:** To use this bot, the bot account must be added as a Moderator in the target Twitch channel to speak and manage entries effectively if the chat is restricted.
