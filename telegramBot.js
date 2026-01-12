// telegramBot.js
import TelegramBot from "node-telegram-bot-api";
import { db } from "./firebase.js";

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
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
        { id: Number(userId), username: username || "", updatedAt: new Date().toISOString() },
        { merge: true }
    );
}

async function getAllUsers() {
    const firestore = db();
    const snap = await firestore.collection("users").get();
    return snap.docs.map((d) => d.data()?.id).filter(Boolean);
}

export function initTelegramBot(app) {
    const token = requireEnv("TELEGRAM_BOT_TOKEN");
    const publicUrl = requireEnv("PUBLIC_BASE_URL"); // e.g. https://your-render-service.onrender.com
    const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET"); // any long random string

    const bot = new TelegramBot(token, { polling: false });

    // Webhook endpoint Telegram will POST updates to
    app.post(`/telegram/webhook/${webhookSecret}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

    // Register webhook with Telegram
    bot.setWebHook(`${publicUrl}/telegram/webhook/${webhookSecret}`);

    // Temporary in-memory store (resets on deploy/restart)
    const broadcastData = {};

    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from?.username || "";

        await addUser(chatId, username);

        // Prefer a hosted image URL (local files are awkward on Render)
        const imageUrl = process.env.TG_WELCOME_IMAGE_URL; // optional
        const webAppUrl = requireEnv("TG_WEBAPP_URL"); // your mini-app URL

        const caption =
            'Welcome to FreakSlots\nTo start the mini-app, press the button below 👇';

        const reply_markup = {
            inline_keyboard: [[{ text: "Open app", web_app: { url: webAppUrl } }]],
        };

        if (imageUrl) {
            await bot.sendPhoto(chatId, imageUrl, { caption, reply_markup });
        } else {
            await bot.sendMessage(chatId, caption, { reply_markup });
        }
    });

    bot.onText(/\/broadcast$/, async (msg) => {
        const chatId = msg.chat.id;

        if (!isAdmin(chatId)) {
            await bot.sendMessage(chatId, "You are not authorized to broadcast.");
            return;
        }

        broadcastData[chatId] = { step: "waiting_for_message" };
        await bot.sendMessage(chatId, "Send me the message you wish to broadcast.");
    });

    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;

        if (!isAdmin(chatId)) return;

        const state = broadcastData[chatId];
        if (!state || state.step !== "waiting_for_message") return;

        broadcastData[chatId] = { step: "confirming", message: msg };

        // Echo back for confirmation
        if (msg.text) await bot.sendMessage(chatId, msg.text, { reply_markup: msg.reply_markup });
        else if (msg.photo) await bot.sendPhoto(chatId, msg.photo[0].file_id, { caption: msg.caption, reply_markup: msg.reply_markup });
        else if (msg.video) await bot.sendVideo(chatId, msg.video.file_id, { caption: msg.caption, reply_markup: msg.reply_markup });
        else if (msg.video_note) await bot.sendVideoNote(chatId, msg.video_note.file_id, { reply_markup: msg.reply_markup });
        else if (msg.document) await bot.sendDocument(chatId, msg.document.file_id, { caption: msg.caption, reply_markup: msg.reply_markup });
        else if (msg.audio) await bot.sendAudio(chatId, msg.audio.file_id, { caption: msg.caption, reply_markup: msg.reply_markup });

        await bot.sendMessage(chatId, "Is this the message you want to broadcast?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Approve✅", callback_data: "approve_broadcast" }],
                    [{ text: "Decline❌", callback_data: "decline_broadcast" }],
                ],
            },
        });
    });

    bot.on("callback_query", async (callbackQuery) => {
        const chatId = callbackQuery.message?.chat?.id;
        const data = callbackQuery.data;

        if (!chatId || !isAdmin(chatId)) return;

        const state = broadcastData[chatId];
        if (!state || state.step !== "confirming") return;

        if (data === "decline_broadcast") {
            delete broadcastData[chatId];
            await bot.sendMessage(chatId, "Broadcast cancelled. Send /broadcast to start again.");
            return;
        }

        if (data !== "approve_broadcast") return;

        const messageToBroadcast = state.message;
        delete broadcastData[chatId];

        const userIds = await getAllUsers();

        for (const userId of userIds) {
            try {
                if (messageToBroadcast.text) {
                    await bot.sendMessage(userId, messageToBroadcast.text, { reply_markup: messageToBroadcast.reply_markup });
                } else if (messageToBroadcast.photo) {
                    await bot.sendPhoto(userId, messageToBroadcast.photo[0].file_id, { caption: messageToBroadcast.caption, reply_markup: messageToBroadcast.reply_markup });
                } else if (messageToBroadcast.video) {
                    await bot.sendVideo(userId, messageToBroadcast.video.file_id, { caption: messageToBroadcast.caption, reply_markup: messageToBroadcast.reply_markup });
                } else if (messageToBroadcast.video_note) {
                    await bot.sendVideoNote(userId, messageToBroadcast.video_note.file_id, { reply_markup: messageToBroadcast.reply_markup });
                } else if (messageToBroadcast.document) {
                    await bot.sendDocument(userId, messageToBroadcast.document.file_id, { caption: messageToBroadcast.caption, reply_markup: messageToBroadcast.reply_markup });
                } else if (messageToBroadcast.audio) {
                    await bot.sendAudio(userId, messageToBroadcast.audio.file_id, { caption: messageToBroadcast.caption, reply_markup: messageToBroadcast.reply_markup });
                }
            } catch {
                // ignore blocked users, etc.
            }
        }

        await bot.sendMessage(chatId, "Message successfully broadcasted to all users.");
    });

    return bot;
}
