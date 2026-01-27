// telegramBot.js
import TelegramBot from "node-telegram-bot-api";
import util from "node:util";
import { db } from "./firebase.js";

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

function normalizeBaseUrl(url) {
    // remove trailing slashes to avoid // in webhook URL
    return String(url || "").replace(/\/+$/, "");
}

const ADMIN_USER_IDS = (process.env.TG_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

function isAdmin(userId) {
    return ADMIN_USER_IDS.includes(Number(userId));
}

async function addUser(userId, username) {
    const firestore = db();
    await firestore.collection("users").doc(String(userId)).set(
        {
            id: Number(userId),
            username: username || "",
            updatedAt: new Date().toISOString(),
        },
        { merge: true }
    );
}

async function getAllUsers() {
    const firestore = db();
    const snap = await firestore.collection("users").get();
    return snap.docs.map((d) => d.data()?.id).filter(Boolean);
}

function logFullError(prefix, err) {
    console.error(prefix);
    console.error("message:", err?.message);
    console.error("code:", err?.code);
    console.error("name:", err?.name);

    // Telegram API details usually live here
    const body =
        err?.response?.body ||
        err?.response?.data ||
        err?.body ||
        err?.response;

    if (body) {
        console.error("telegram body:", typeof body === "string" ? body : util.inspect(body, { depth: 10 }));
    }

    if (err?.stack) console.error("stack:", err.stack);

    // If everything above is missing, print a trimmed inspect
    console.error("inspect:", util.inspect(err, { depth: 4 }));
}

/**
 * Call this from server.js:
 *   import { initTelegramBot } from "./telegramBot.js";
 *   ...
 *   app.use(express.json());
 *   initTelegramBot(app);
 */
export function initTelegramBot(app) {
    const token = requireEnv("TELEGRAM_BOT_TOKEN");
    const publicBaseUrl = normalizeBaseUrl(requireEnv("PUBLIC_BASE_URL"));
    const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
    const webAppUrl = requireEnv("TG_WEBAPP_URL"); // required for /start button

    const bot = new TelegramBot(token, { polling: false });

    bot.on("error", (err) => logFullError("telegram bot error:", err));
    bot.on("webhook_error", (err) => logFullError("telegram webhook_error:", err));

    // Webhook endpoint Telegram will POST updates to
    app.post(`/telegram/webhook/${webhookSecret}`, (req, res) => {
        try {
            // If you do not see this line when sending /start, Telegram is not reaching your backend
            console.log("Telegram update received:", JSON.stringify(req.body));
            bot.processUpdate(req.body);
            res.sendStatus(200);
        } catch (err) {
            logFullError("processUpdate failed:", err);
            // Still return 200 so Telegram does not retry aggressively
            res.sendStatus(200);
        }
    });

    // Register webhook with Telegram
    const webhookUrl = `${publicBaseUrl}/telegram/webhook/${webhookSecret}`;
    bot
        .setWebHook(webhookUrl)
        .then(() => console.log("Telegram webhook set to:", webhookUrl))
        .catch((err) => logFullError("Failed to set Telegram webhook:", err));

    // Temporary in-memory store (resets on deploy/restart)
    const broadcastState = new Map(); // adminChatId -> { step, payload }

    // /start
    bot.onText(/^\/start(?:\s|$)/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from?.username || "";

        try {
            await addUser(chatId, username);

            const imageUrl = process.env.TG_WELCOME_IMAGE_URL; // optional

            const caption = "👋 Welcome, " + `${username}` + "!\n\n🎰 Wanna spin without risk?\nPlay free demo slots only inside this bot\n\n🏆 Top-rated games & working providers always available\n\n💎 Hidden bonuses & special offers unlocked for players\n\n🔥 Best slots updated daily — don’t miss hot games\n\n👇 Hit play now & start spinning";

            const reply_markup = {
                inline_keyboard: [[{ text: "Play Now", web_app: { url: webAppUrl } }]],
            };

            try {
                if (imageUrl) {
                    await bot.sendPhoto(chatId, imageUrl, { caption, reply_markup });
                } else {
                    await bot.sendMessage(chatId, caption, { reply_markup });
                }
            } catch (err) {
                logFullError("failed to reply to /start:", err);
                throw err;
            }
        } catch (err) {
            logFullError("start handler failed:", err);
            // Try to send something even if DB fails
            try {
                await bot.sendMessage(chatId, "An error occurred. Please try again later.");
            } catch (e2) {
                logFullError("failed to send fallback message:", e2);
            }
        }
    });

    // /broadcast (admin only)
    bot.onText(/^\/broadcast(?:\s|$)/, async (msg) => {
        const chatId = msg.chat.id;

        if (!isAdmin(chatId)) {
            await bot.sendMessage(chatId, "You are not authorized to broadcast.");
            return;
        }

        broadcastState.set(chatId, { step: "waiting_for_message" });
        await bot.sendMessage(chatId, "Send the message you want to broadcast (text, photo, video, document, audio).");
    });

    // Capture the next message from admin as the broadcast payload
    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;

        if (!isAdmin(chatId)) return;

        const state = broadcastState.get(chatId);
        if (!state || state.step !== "waiting_for_message") return;

        // Ignore commands as broadcast content
        if (typeof msg.text === "string" && msg.text.startsWith("/")) return;

        // Store only what we can reliably resend
        const payload = {
            text: msg.text || null,
            caption: msg.caption || null,
            photoFileId: msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : null,
            videoFileId: msg.video?.file_id || null,
            videoNoteFileId: msg.video_note?.file_id || null,
            documentFileId: msg.document?.file_id || null,
            audioFileId: msg.audio?.file_id || null,
        };

        broadcastState.set(chatId, { step: "confirming", payload });

        // Echo back for confirmation (without reply_markup, because it is not present on incoming messages)
        try {
            if (payload.text) await bot.sendMessage(chatId, payload.text);
            else if (payload.photoFileId) await bot.sendPhoto(chatId, payload.photoFileId, { caption: payload.caption || "" });
            else if (payload.videoFileId) await bot.sendVideo(chatId, payload.videoFileId, { caption: payload.caption || "" });
            else if (payload.videoNoteFileId) await bot.sendVideoNote(chatId, payload.videoNoteFileId);
            else if (payload.documentFileId) await bot.sendDocument(chatId, payload.documentFileId, { caption: payload.caption || "" });
            else if (payload.audioFileId) await bot.sendAudio(chatId, payload.audioFileId, { caption: payload.caption || "" });
            else {
                await bot.sendMessage(chatId, "Unsupported message type. Please send text, photo, video, document, or audio.");
                broadcastState.delete(chatId);
                return;
            }

            await bot.sendMessage(chatId, "Is this the message you want to broadcast?", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Approve✅", callback_data: "approve_broadcast" }],
                        [{ text: "Decline❌", callback_data: "decline_broadcast" }],
                    ],
                },
            });
        } catch (err) {
            logFullError("broadcast confirm failed:", err);
            broadcastState.delete(chatId);
        }
    });

    // Approve/decline broadcast
    bot.on("callback_query", async (callbackQuery) => {
        const chatId = callbackQuery.message?.chat?.id;
        const data = callbackQuery.data;

        if (!chatId || !isAdmin(chatId)) return;

        const state = broadcastState.get(chatId);
        if (!state || state.step !== "confirming") return;

        if (data === "decline_broadcast") {
            broadcastState.delete(chatId);
            await bot.sendMessage(chatId, "Broadcast cancelled. Send /broadcast to start again.");
            return;
        }

        if (data !== "approve_broadcast") return;

        const payload = state.payload;
        broadcastState.delete(chatId);

        let userIds = [];
        try {
            userIds = await getAllUsers();
        } catch (err) {
            logFullError("getAllUsers failed:", err);
            await bot.sendMessage(chatId, "Failed to load users from the database.");
            return;
        }

        let sent = 0;

        for (const userId of userIds) {
            try {
                if (payload.text) await bot.sendMessage(userId, payload.text);
                else if (payload.photoFileId) await bot.sendPhoto(userId, payload.photoFileId, { caption: payload.caption || "" });
                else if (payload.videoFileId) await bot.sendVideo(userId, payload.videoFileId, { caption: payload.caption || "" });
                else if (payload.videoNoteFileId) await bot.sendVideoNote(userId, payload.videoNoteFileId);
                else if (payload.documentFileId) await bot.sendDocument(userId, payload.documentFileId, { caption: payload.caption || "" });
                else if (payload.audioFileId) await bot.sendAudio(userId, payload.audioFileId, { caption: payload.caption || "" });
                sent += 1;
            } catch {
                // ignore blocked users, etc.
            }
        }

        await bot.sendMessage(chatId, `Broadcast completed. Delivered to ${sent} users.`);
    });

    return bot;
}
