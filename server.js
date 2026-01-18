import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { db } from "./firebase.js";
import { runSync, seedNewestPublishedGames, normalizeGame, upsertGames } from "./sync.js";
import { deleteCollection } from "./admin.js";
import { fetchGamesPage } from "./slotslaunch.js";

const app = express();

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
   Best-games pinning (NEW)
------------------------------ */
const DEFAULT_BEST_GAME_NAMES = [
    "Zeus vs Hades gods of war",
    "wanted dead or a wild",
    "Sweet bonanza 1000",
    "Mental 2",
    "Brute Force",
];

function keyName(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

async function getPinnedBestIds() {
    const firestore = db();
    const snap = await firestore.collection("meta").doc("curation").get();
    if (!snap.exists) return [];
    const ids = snap.data()?.bestPinnedIds;
    return Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
}

async function setPinnedBestIds(ids) {
    const firestore = db();
    await firestore.collection("meta").doc("curation").set(
        {
            bestPinnedIds: ids.map(String),
            updatedAt: new Date().toISOString(),
        },
        { merge: true }
    );
}

function mergePinnedFirst(pinnedDocs, poolDocs, limit) {
    const pinnedIds = new Set(pinnedDocs.map((g) => String(g.id)));
    const merged = [...pinnedDocs];

    for (const g of poolDocs) {
        if (merged.length >= limit) break;
        if (pinnedIds.has(String(g.id))) continue;
        merged.push(g);
    }

    return merged.slice(0, limit);
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
        if (homeCache && Date.now() - homeCache.ts < HOME_CACHE_TTL_MS) {
            res.json(homeCache.data);
            return;
        }

        if (Date.now() < homeCircuitUntil) {
            if (homeCache?.data) res.json(homeCache.data);
            else res.status(503).json({ error: "Temporarily unavailable" });
            return;
        }

        if (!homeInFlight) {
            homeInFlight = (async () => {
                const firestore = db();

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

                // NEW: pinned best games first
                const pinnedIds = await getPinnedBestIds();
                let pinnedDocs = [];
                if (pinnedIds.length) {
                    const pinnedSet = new Set(pinnedIds.map(String));
                    pinnedDocs = docs
                        .filter((g) => pinnedSet.has(String(g.id)))
                        .sort((a, b) => pinnedIds.indexOf(String(a.id)) - pinnedIds.indexOf(String(b.id)));
                }

                const bestMerged = mergePinnedFirst(pinnedDocs, byUpdated, 50).map(toClientGame);

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
                    { id: "best", title: "Best games", icon: "⭐", games: bestMerged },
                    { id: "new", title: "New games", icon: "🆕", games: newGames },
                    { id: "rtp97", title: "RTP 97%", icon: "🎯", games: rtp97Games },
                ];
            })()
                .then((data) => {
                    homeCache = { ts: Date.now(), data };
                    return data;
                })
                .catch((e) => {
                    if (isQuotaError(e)) homeCircuitUntil = Date.now() + 60 * 1000;
                    throw e;
                })
                .finally(() => {
                    homeInFlight = null;
                });
        }

        const data = await withTimeout(homeInFlight, 2500);
        res.json(data);
    } catch (e) {
        if (isQuotaError(e) && homeCache?.data) {
            res.json(homeCache.data);
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
        homeCache = null;

        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

/* -----------------------------
   ADMIN: pull and pin best games from SlotsLaunch (NEW)
------------------------------ */
app.post("/api/admin/best-games/pull", async (req, res) => {
    try {
        if (!requireSecret(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        const names = Array.isArray(req.body?.names) && req.body.names.length
            ? req.body.names
            : DEFAULT_BEST_GAME_NAMES;

        // Scan deeper by default
        const maxPages = Number(req.body?.maxPages ?? 400);

        // Even if SlotsLaunch caps per_page, keeping this high does not hurt.
        const perPage = Number(req.body?.perPage ?? 150);

        const wanted = names.map((n) => ({
            raw: String(n),
            key: keyName(n),
        }));

        // foundByKey: key -> normalized game doc
        const foundByKey = new Map();

        let page = 1;
        let lastMeta = null;

        while (page <= maxPages && foundByKey.size < wanted.length) {
            const data = await fetchGamesPage({ page, perPage, updatedAt: null });

            // SlotsLaunch usually returns { data: [...], meta: {...} }
            const rawGames = Array.isArray(data) ? data : (data.data || data.games || []);
            lastMeta = Array.isArray(data) ? null : (data.meta || data.pagination || null);

            if (!rawGames.length) break;

            for (const g of rawGames) {
                const apiName = g?.name || g?.title || "";
                const apiKey = keyName(apiName);

                // FUZZY MATCH:
                // - exact key match OR
                // - api title contains requested title OR
                // - requested title contains api title (rare but safe)
                for (const w of wanted) {
                    if (foundByKey.has(w.key)) continue;

                    const ok =
                        apiKey === w.key ||
                        apiKey.includes(w.key) ||
                        w.key.includes(apiKey);

                    if (ok) {
                        const normalized = normalizeGame(g); // uses same shape as your sync 
                        if (normalized.published === true) {
                            foundByKey.set(w.key, normalized);
                        }
                    }
                }
            }

            // If API provides total pages, we can stop earlier
            const totalPages =
                typeof lastMeta?.total_pages === "number" ? lastMeta.total_pages :
                    typeof lastMeta?.last_page === "number" ? lastMeta.last_page :
                        null;

            if (totalPages && page >= totalPages) break;

            page += 1;
        }

        const found = [];
        const missing = [];

        for (const w of wanted) {
            const g = foundByKey.get(w.key);
            if (g) found.push(g);
            else missing.push(w.raw);
        }

        if (found.length) {
            await upsertGames(found);
            await setPinnedBestIds(found.map((g) => String(g.id)));

            homeCache = null;
            gameCache.clear();
        }

        res.json({
            ok: true,
            requested: names,
            found: found.map((g) => ({ id: g.id, name: g.name, provider: g.provider })),
            missing,
            pagesScanned: page,
            meta: lastMeta || null,
        });
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
