import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { db } from "./firebase.js";
import { runSync } from "./sync.js";
import { seedNewestPublishedGames } from "./sync.js";
import { deleteCollection } from "./admin.js";

const app = express();

/**
 * Important for Render / reverse proxies:
 * This makes req.ip use X-Forwarded-For correctly.
 */
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());

/* -----------------------------
   GEO cache (unchanged)
------------------------------ */
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const geoCache = new Map(); // ip -> { ts, data }


function requireSecret(req) {
    const secret = req.headers["x-sync-secret"];
    return secret && secret === process.env.SYNC_SECRET;
}

function getClientIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
    if (req.ip) return req.ip;
    const ra = req.socket?.remoteAddress;
    return typeof ra === "string" ? ra : "";
}

function normalizeIp(ip) {
    if (!ip) return "";
    if (ip.startsWith("::ffff:")) return ip.replace("::ffff:", "");
    return ip;
}

function cacheGet(ip) {
    const v = geoCache.get(ip);
    if (!v) return null;
    if (Date.now() - v.ts > GEO_CACHE_TTL_MS) {
        geoCache.delete(ip);
        return null;
    }
    return v.data;
}

function cacheSet(ip, data) {
    geoCache.set(ip, { ts: Date.now(), data });
}

async function fetchJson(url, headers = {}) {
    const r = await fetch(url, {
        headers: {
            "User-Agent": "FreakSlots/1.0",
            Accept: "application/json",
            ...headers,
        },
    });
    const text = await r.text().catch(() => "");
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // ignore
    }
    return { ok: r.ok, status: r.status, json, text };
}

/* -----------------------------
   Simple in-memory API caches
------------------------------ */
const HOME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
let homeCache = null; // { ts, data }
let homeInFlight = null; // Promise resolving to result array
let homeCircuitUntil = 0; // if quota errors happen, skip Firestore until this time


const GAME_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const gameCache = new Map(); // id -> { ts, data }

function isQuotaError(e) {
    const msg = String(e?.message || e || "");
    return msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded");
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
    ]);
}

function safeTs(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? t : 0;
}

function toClientGame(g) {
    return {
        id: g.id,
        name: g.name,
        provider: g.provider,
        thumb: g.thumb,
        demoUrl: g.embedUrl,
        rtp: g.rtp ?? null,
    };
}


/* -----------------------------
   Debug / health
------------------------------ */
app.get("/debug/firestore", async (req, res) => {
    const firestore = db();
    await firestore.collection("meta").doc("ping").set({ t: Date.now() }, { merge: true });
    res.json({ ok: true });
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

/* -----------------------------
   GEO by IP (unchanged)
------------------------------ */
app.get("/api/geo", async (req, res) => {
    try {
        const ip = normalizeIp(getClientIp(req)) || "unknown";

        const cached = cacheGet(ip);
        if (cached) {
            res.json({ ok: true, cached: true, ...cached });
            return;
        }

        const a = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);

        if (a.ok && a.json && a.json.success !== false) {
            const payload = {
                ip: a.json.ip || ip,
                country: a.json.country || null,
                countryCode: a.json.country_code || null,
                city: a.json.city || null,
                region: a.json.region || null,
                timezone: a.json.timezone?.id || a.json.timezone || null,
            };
            payload.label =
                payload.country && payload.city
                    ? `${payload.country} (${payload.city})`
                    : payload.country || payload.city || "Unknown";

            cacheSet(ip, payload);
            res.json({ ok: true, cached: false, ...payload });
            return;
        }

        const b = await fetchJson(
            ip === "unknown" ? "https://ipapi.co/json/" : `https://ipapi.co/${encodeURIComponent(ip)}/json/`
        );

        if (b.ok && b.json && typeof b.json === "object" && !b.json.error) {
            const payload = {
                ip: b.json.ip || ip,
                country: b.json.country_name || null,
                countryCode: b.json.country_code || null,
                city: b.json.city || null,
                region: b.json.region || null,
                timezone: b.json.timezone || null,
            };
            payload.label =
                payload.country && payload.city
                    ? `${payload.country} (${payload.city})`
                    : payload.country || payload.city || "Unknown";

            cacheSet(ip, payload);
            res.json({ ok: true, cached: false, ...payload });
            return;
        }

        res.status(502).json({
            ok: false,
            error: "Geo providers failed",
            providerA: { status: a.status, details: a.json || a.text?.slice(0, 200) },
            providerB: { status: b.status, details: b.json || b.text?.slice(0, 200) },
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
    }
});

/* -----------------------------
   HOME: single Firestore read + cache + stale fallback
------------------------------ */
app.get("/api/home", async (req, res) => {
    try {
        // 1) Serve cache if fresh
        if (homeCache && Date.now() - homeCache.ts < HOME_CACHE_TTL_MS) {
            res.json(homeCache.data);
            return;
        }

        // 2) If we recently hit quota, do NOT touch Firestore (fast path)
        if (Date.now() < homeCircuitUntil) {
            if (homeCache?.data) {
                res.json(homeCache.data); // stale but usable
            } else {
                res.status(503).json({ error: "Temporarily unavailable" });
            }
            return;
        }

        // 3) Coalesce multiple requests into one Firestore read
        if (!homeInFlight) {
            homeInFlight = (async () => {
                const firestore = db();

                // Only one query. Keep limit low.
                // If you added updatedAtTs/createdAtTs later, it will use them for sorting in-memory.
                const snap = await firestore
                    .collection("games")
                    .where("enabled", "==", true)
                    .limit(220)
                    .get();

                const docs = snap.docs.map((d) => d.data());

                const byUpdated = [...docs].sort(
                    (a, b) => safeTs(b.updatedAtTs ?? b.updatedAt) - safeTs(a.updatedAtTs ?? a.updatedAt)
                );
                const byCreated = [...docs].sort(
                    (a, b) => safeTs(b.createdAtTs ?? b.createdAt) - safeTs(a.createdAtTs ?? a.createdAt)
                );

                const christmasKeywords = [
                    "christmas", "xmas", "santa", "noel", "holiday",
                    "winter", "snow", "new year", "ny", "jingle",
                ];

                const exclusive = docs.filter((g) => {
                    const name = String(g.name || "").toLowerCase();
                    return christmasKeywords.some((k) => name.includes(k));
                });

                const bestGames = byUpdated.slice(0, 50).map(toClientGame);
                const newGames = byCreated.slice(0, 50).map(toClientGame);

                const rtp97Games = docs
                    .filter((g) => typeof g.rtp === "number" && g.rtp >= 97)
                    .sort((a, b) => (b.rtp ?? 0) - (a.rtp ?? 0))
                    .slice(0, 50)
                    .map(toClientGame);

                const exclusiveGames = (exclusive.length ? exclusive : byUpdated)
                    .slice(0, 50)
                    .map(toClientGame);

                return [
                    { id: "exclusive", title: "Exclusive games", icon: "🎁", games: exclusiveGames },
                    { id: "best", title: "Best games", icon: "⭐", games: bestGames },
                    { id: "new", title: "New games", icon: "🆕", games: newGames },
                    { id: "rtp97", title: "RTP 97%", icon: "🎯", games: rtp97Games },
                ];
            })()
                .then((data) => {
                    homeCache = { ts: Date.now(), data };
                    return data;
                })
                .catch((e) => {
                    // Open circuit on quota errors to stop 15s hangs/retries
                    if (isQuotaError(e)) {
                        homeCircuitUntil = Date.now() + 60 * 1000; // 60s cooldown
                    }
                    throw e;
                })
                .finally(() => {
                    homeInFlight = null;
                });
        }

        // 4) Timeout so requests don't hang forever
        const data = await withTimeout(homeInFlight, 2500);
        res.json(data);
    } catch (e) {
        if (isQuotaError(e) && homeCache?.data) {
            res.json(homeCache.data); // stale fallback
            return;
        }
        res.status(503).json({ error: String(e.message || e) });
    }
});


/* -----------------------------
   GAME: cache per id + stale fallback on quota
------------------------------ */
app.get("/api/games/:id", async (req, res) => {
    const id = String(req.params.id);

    // Cache hit
    const cached = gameCache.get(id);
    if (cached && Date.now() - cached.ts < GAME_CACHE_TTL_MS) {
        res.json(cached.data);
        return;
    }

    try {
        const firestore = db();
        const snap = await firestore.collection("games").doc(id).get();

        if (!snap.exists) {
            res.status(404).json({ error: "Not found" });
            return;
        }

        const g = snap.data();
        const payload = toClientGame(g);

        gameCache.set(id, { ts: Date.now(), data: payload });
        res.json(payload);
    } catch (e) {
        if (isQuotaError(e) && cached?.data) {
            // Serve stale to prevent "Game not found" on temporary Firestore throttling
            res.json(cached.data);
            return;
        }
        res.status(500).json({ error: String(e.message || e) });
    }
});

/* -----------------------------
   SYNC (unchanged)
------------------------------ */
app.post("/api/sync", async (req, res) => {
    try {
        if (!requireSecret(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        const info = await runSync();

        // After syncing, drop home cache so next /api/home rebuilds once
        homeCache = null;

        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

/* -----------------------------
   ADMIN reset (unchanged)
------------------------------ */
app.post("/api/admin/reset", async (req, res) => {
    try {
        if (!requireSecret(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        const target = Number(req.body?.target ?? 100);

        await deleteCollection("games", 300);

        const info = await seedNewestPublishedGames({ target });

        // After reset, drop caches
        homeCache = null;
        gameCache.clear();

        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
    console.log(`API listening on :${port}`);
});
