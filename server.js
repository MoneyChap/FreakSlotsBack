import "dotenv/config";
import express from "express";
import cors from "cors";
import { db } from "./firebase.js";
import { runSync } from "./sync.js";
import { CATEGORY_DEFS } from "./categories.js";

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

app.get("/api/home", async (req, res) => {
    try {
        const firestore = db();
        const result = [];

        for (const c of CATEGORY_DEFS) {
            // Read category doc to find which run is active
            const catSnap = await firestore.collection("categories").doc(c.id).get();
            const activeRunId = catSnap.exists ? catSnap.data()?.activeRunId : null;

            if (!activeRunId) {
                result.push({ id: c.id, title: c.title, icon: c.icon, games: [] });
                continue;
            }

            const itemsSnap = await firestore
                .collection("categories")
                .doc(c.id)
                .collection("runs")
                .doc(String(activeRunId))
                .collection("items")
                .orderBy("rank", "asc")
                .limit(50)
                .get();

            const gameIds = itemsSnap.docs.map((d) => d.id);

            if (gameIds.length === 0) {
                result.push({ id: c.id, title: c.title, icon: c.icon, games: [] });
                continue;
            }

            // Batch fetch games (max 50 here, safe)
            const gamesRefs = gameIds.map((id) => firestore.collection("games").doc(id));
            const gamesSnaps = await firestore.getAll(...gamesRefs);

            const games = gamesSnaps
                .filter((s) => s.exists)
                .map((s) => s.data())
                .map((g) => ({
                    id: g.id,
                    name: g.name,
                    provider: g.provider,
                    thumb: g.thumb,
                    demoUrl: g.embedUrl,
                    rtp: g.rtp ?? null,
                }));

            // keep the order according to item ranks
            const byId = new Map(games.map((g) => [String(g.id), g]));
            const ordered = gameIds.map((id) => byId.get(String(id))).filter(Boolean);

            result.push({ id: c.id, title: c.title, icon: c.icon, games: ordered });
        }

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
