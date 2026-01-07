import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { db } from "./firebase.js";
import { runSync } from "./sync.js";
import { CATEGORY_DEFS } from "./categories.js";
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

const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const geoCache = new Map(); // ip -> { ts, data }

function requireSecret(req) {
    const secret = req.headers["x-sync-secret"];
    return secret && secret === process.env.SYNC_SECRET;
}

function getClientIp(req) {
    // Prefer X-Forwarded-For (first IP)
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
        return xff.split(",")[0].trim();
    }
    // Express also supports req.ip (works with trust proxy)
    if (req.ip) return req.ip;

    // Fallback
    const ra = req.socket?.remoteAddress;
    return typeof ra === "string" ? ra : "";
}

function normalizeIp(ip) {
    // Remove IPv6 prefix if present (e.g., ::ffff:1.2.3.4)
    if (!ip) return "";
    if (ip.startsWith("::ffff:")) return ip.replace("::ffff:", "");
    return ip;
}

app.get("/debug/firestore", async (req, res) => {
    const firestore = db();
    await firestore.collection("meta").doc("ping").set({ t: Date.now() }, { merge: true });
    res.json({ ok: true });
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

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

/**
 * GEO by IP (automatic, no permission prompt).
 * Returns country/city information based on request IP.
 */
app.get("/api/geo", async (req, res) => {
    try {
        const ip = normalizeIp(getClientIp(req)) || "unknown";

        // 1) Cache hit
        const cached = cacheGet(ip);
        if (cached) {
            res.json({ ok: true, cached: true, ...cached });
            return;
        }

        // 2) Provider A: ipwho.is (usually lenient, no key)
        // docs: returns { success, country, city, region, timezone, ip, ... }
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

        // 3) Fallback provider B: ipapi.co
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

        // If both failed, return meaningful error
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

app.get("/api/home", async (req, res) => {
    try {
        const firestore = db();

        const toClientGame = (g) => ({
            id: g.id,
            name: g.name,
            provider: g.provider,
            thumb: g.thumb,
            demoUrl: g.embedUrl,
            rtp: g.rtp ?? null,
        });

        const bestSnap = await firestore
            .collection("games")
            .where("enabled", "==", true)
            .orderBy("updatedAt", "desc")
            .limit(50)
            .get();

        const bestGames = bestSnap.docs.map((d) => toClientGame(d.data()));

        const newSnap = await firestore
            .collection("games")
            .where("enabled", "==", true)
            .orderBy("createdAt", "desc")
            .limit(50)
            .get();

        const newGames = newSnap.docs.map((d) => toClientGame(d.data()));

        let rtp97Games = [];
        try {
            const rtpSnap = await firestore
                .collection("games")
                .where("enabled", "==", true)
                .where("rtp", ">=", 97)
                .orderBy("rtp", "desc")
                .limit(50)
                .get();

            rtp97Games = rtpSnap.docs.map((d) => toClientGame(d.data()));
        } catch (e) {
            rtp97Games = bestGames
                .filter((g) => typeof g.rtp === "number" && g.rtp >= 97)
                .slice(0, 50);
        }

        const allSnap = await firestore
            .collection("games")
            .where("enabled", "==", true)
            .limit(500)
            .get();

        const allDocs = allSnap.docs.map((d) => d.data());

        const christmasKeywords = [
            "christmas",
            "xmas",
            "santa",
            "noel",
            "holiday",
            "winter",
            "snow",
            "new year",
            "ny",
            "jingle",
        ];

        const exclusiveFiltered = allDocs.filter((g) => {
            const name = String(g.name || "").toLowerCase();
            return christmasKeywords.some((k) => name.includes(k));
        });

        const exclusiveGames = exclusiveFiltered.slice(0, 50).map((g) => toClientGame(g));
        const exclusiveFinal = exclusiveGames.length ? exclusiveGames : bestGames.slice(0, 50);

        const result = [
            { id: "exclusive", title: "Exclusive games", icon: "🎁", games: exclusiveFinal },
            { id: "best", title: "Best games", icon: "⭐", games: bestGames },
            { id: "new", title: "New games", icon: "🆕", games: newGames },
            { id: "rtp97", title: "RTP 97%", icon: "🎯", games: rtp97Games },
        ];

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.get("/api/games/:id", async (req, res) => {
    try {
        const firestore = db();
        const id = String(req.params.id);

        const snap = await firestore.collection("games").doc(id).get();
        if (!snap.exists) {
            res.status(404).json({ error: "Not found" });
            return;
        }

        const g = snap.data();
        res.json({
            id: g.id,
            name: g.name,
            provider: g.provider,
            thumb: g.thumb,
            demoUrl: g.embedUrl,
            rtp: g.rtp ?? null,
        });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.post("/api/sync", async (req, res) => {
    try {
        if (!requireSecret(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        const info = await runSync();
        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
    console.log(`API listening on :${port}`);
});

app.post("/api/admin/reset", async (req, res) => {
    try {
        if (!requireSecret(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        const target = Number(req.body?.target ?? 100);

        await deleteCollection("games", 300);

        const info = await seedNewestPublishedGames({ target });

        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});
