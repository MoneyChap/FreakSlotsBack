import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./firebase.js";
import { runSync } from "./sync.js";
import { CATEGORY_DEFS } from "./categories.js";
import { seedNewestPublishedGames } from "./sync.js";
import { deleteCollection } from "./admin.js";
import fetch from "node-fetch";


const app = express();
app.use(cors());
app.use(express.json());

function requireSecret(req) {
    const secret = req.headers["x-sync-secret"];
    return secret && secret === process.env.SYNC_SECRET;
}

app.get("/debug/firestore", async (req, res) => {
    const firestore = db();
    await firestore.collection("meta").doc("ping").set({ t: Date.now() }, { merge: true });
    res.json({ ok: true });
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

// app.get("/api/home", async (req, res) => {
//     try {
//         const firestore = db();
//         const result = [];

//         for (const c of CATEGORY_DEFS) {
//             // Read category doc to find which run is active
//             const catSnap = await firestore.collection("categories").doc(c.id).get();
//             const activeRunId = catSnap.exists ? catSnap.data()?.activeRunId : null;

//             if (!activeRunId) {
//                 result.push({ id: c.id, title: c.title, icon: c.icon, games: [] });
//                 continue;
//             }

//             const itemsSnap = await firestore
//                 .collection("categories")
//                 .doc(c.id)
//                 .collection("runs")
//                 .doc(String(activeRunId))
//                 .collection("items")
//                 .orderBy("rank", "asc")
//                 .limit(50)
//                 .get();

//             const gameIds = itemsSnap.docs.map((d) => d.id);

//             if (gameIds.length === 0) {
//                 result.push({ id: c.id, title: c.title, icon: c.icon, games: [] });
//                 continue;
//             }

//             // Batch fetch games (max 50 here, safe)
//             const gamesRefs = gameIds.map((id) => firestore.collection("games").doc(id));
//             const gamesSnaps = await firestore.getAll(...gamesRefs);

//             const games = gamesSnaps
//                 .filter((s) => s.exists)
//                 .map((s) => s.data())
//                 .map((g) => ({
//                     id: g.id,
//                     name: g.name,
//                     provider: g.provider,
//                     thumb: g.thumb,
//                     demoUrl: g.embedUrl,
//                     rtp: g.rtp ?? null,
//                 }));

//             // keep the order according to item ranks
//             const byId = new Map(games.map((g) => [String(g.id), g]));
//             const ordered = gameIds.map((id) => byId.get(String(id))).filter(Boolean);

//             result.push({ id: c.id, title: c.title, icon: c.icon, games: ordered });
//         }

//         res.json(result);
//     } catch (e) {
//         res.status(500).json({ error: String(e.message || e) });
//     }
// });

app.get("/api/home", async (req, res) => {
    try {
        const firestore = db();

        // helper to map stored game doc to frontend shape
        const toClientGame = (g) => ({
            id: g.id,
            name: g.name,
            provider: g.provider,
            thumb: g.thumb,
            demoUrl: g.embedUrl,
            rtp: g.rtp ?? null,
        });

        // best: newest updatedAt first
        const bestSnap = await firestore
            .collection("games")
            .where("enabled", "==", true)
            .orderBy("updatedAt", "desc")
            .limit(50)
            .get();

        const bestGames = bestSnap.docs.map((d) => toClientGame(d.data()));

        // new: newest createdAt first
        const newSnap = await firestore
            .collection("games")
            .where("enabled", "==", true)
            .orderBy("createdAt", "desc")
            .limit(50)
            .get();

        const newGames = newSnap.docs.map((d) => toClientGame(d.data()));

        // rtp97: try query, fallback to in-memory if you lack an index or rtp types are inconsistent
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
            // fallback: derive from "best" pool
            rtp97Games = bestGames.filter((g) => typeof g.rtp === "number" && g.rtp >= 97).slice(0, 50);
        }

        // exclusive: christmas themed (simple keyword match)
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

        // fallback if nothing matched
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

        // wipe collections
        await deleteCollection("games", 300);
        // optional: if you still use categories collection from older code
        // await deleteCollection("categories", 100);

        const info = await seedNewestPublishedGames({ target });

        res.json({ ok: true, info });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.post("/api/geo/reverse", async (req, res) => {
    try {
        const lat = Number(req.body?.lat);
        const lon = Number(req.body?.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            res.status(400).json({ error: "Invalid lat/lon" });
            return;
        }

        const url = new URL("https://nominatim.openstreetmap.org/reverse");
        url.searchParams.set("format", "json");
        url.searchParams.set("lat", String(lat));
        url.searchParams.set("lon", String(lon));
        url.searchParams.set("zoom", "10");
        url.searchParams.set("addressdetails", "1");

        const r = await fetch(url.toString(), {
            headers: {
                "User-Agent": "FreakSlots/1.0 (support@your-domain.example)",
                "Accept": "application/json",
            },
        });

        if (!r.ok) {
            const txt = await r.text().catch(() => "");
            res.status(502).json({ error: `Reverse geocode failed: ${r.status} ${txt.slice(0, 120)}` });
            return;
        }

        const data = await r.json();

        const a = data?.address || {};
        const country = a.country || null;

        const city =
            a.city ||
            a.town ||
            a.village ||
            a.municipality ||
            a.county ||
            null;

        res.json({
            ok: true,
            lat,
            lon,
            city,
            country,
            label: city && country ? `${country} (${city})` : (country || city || "Unknown"),
            raw: {
                display_name: data?.display_name || null,
            },
        });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});