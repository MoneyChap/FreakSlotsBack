import { db } from "./firebase.js";
import { fetchGamesPage, buildEmbedUrl } from "./slotslaunch.js";
import { CATEGORY_DEFS } from "./categories.js";

const PER_PAGE = 150;
// const FULL_SYNC = String(process.env.FULL_SYNC || "").toLowerCase() === "true";
// const FULL_SYNC_LIMIT = Number(process.env.FULL_SYNC_LIMIT || 100);


function toDateStringYYYYMMDD(d) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function normalizeGame(g) {
    // g fields depend on SlotsLaunch response.
    // Store only what frontend needs now; expand later.
    const id = String(g.id);
    const name = g.name || g.title || "";
    const provider =
        (g.provider && (g.provider.name || g.provider.title)) ||
        g.provider_name ||
        "";
    const thumb = g.thumb || g.thumbnail || "";
    const rtp = typeof g.rtp === "number" ? g.rtp : g.rtp ? Number(g.rtp) : null;
    const updatedAt = g.updated_at || null;
    const createdAt = g.created_at || null;
    const publishedRaw = g.published;
    const published =
        publishedRaw === true ||
        publishedRaw === 1 ||
        publishedRaw === "1";

    // SlotsLaunch provides iframe URL in g.url (typically https://slotslaunch.com/iframe/{id})
    const apiUrl = g.url || "";
    const embedUrl = apiUrl ? buildEmbedUrl(apiUrl) : "";

    return {
        id,
        name,
        provider,
        thumb,
        rtp,
        updatedAt,
        createdAt,
        published,
        enabled: published,
        apiUrl,
        embedUrl,
    };
}

async function upsertGames(games) {
    const firestore = db();

    const chunkSize = 250;
    for (let i = 0; i < games.length; i += chunkSize) {
        const batch = firestore.batch();
        const chunk = games.slice(i, i + chunkSize);

        for (const g of chunk) {
            const docRef = firestore.collection("games").doc(String(g.id));
            batch.set(docRef, { ...g, syncedAt: new Date().toISOString() }, { merge: true });
        }

        await batch.commit();
    }
}

async function getLastSyncDate() {
    const firestore = db();
    const metaRef = firestore.collection("meta").doc("sync");
    const snap = await metaRef.get();
    if (!snap.exists) return null;
    return snap.data()?.lastUpdatedAtDate ?? null;
}

async function setLastSyncDate(dateStr) {
    const firestore = db();
    const metaRef = firestore.collection("meta").doc("sync");
    await metaRef.set(
        {
            lastUpdatedAtDate: dateStr,
            updatedAt: new Date().toISOString(),
        },
        { merge: true }
    );
}

function pickCategoryIdsForGame(game) {
    const ids = [];

    // Best games: placeholder logic: first pages will populate; later replace with telemetry.
    ids.push("best");

    // RTP 97%+
    if (typeof game.rtp === "number" && game.rtp >= 97) ids.push("rtp97");

    // Exclusive games: placeholder (you can switch to tags/themes from API later)
    // For now, do not auto-assign unless you add a rule.
    // ids.push("exclusive");

    // New games: created in last 30 days if createdAt exists
    if (game.createdAt) {
        const created = Date.parse(game.createdAt);
        if (!Number.isNaN(created)) {
            const days30 = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - created < days30) ids.push("new");
        }
    }

    return ids;
}

async function rebuildCategoriesIndex({ limitPerCategory = 80 } = {}) {
    const firestore = db();

    // ensure category docs exist
    for (const c of CATEGORY_DEFS) {
        await firestore.collection("categories").doc(c.id).set(
            {
                title: c.title,
                icon: c.icon,
                updatedAt: new Date().toISOString(),
            },
            { merge: true }
        );
    }

    // Load games once, then distribute.
    const gamesSnap = await firestore
        .collection("games")
        .where("enabled", "==", true)
        .limit(2000)
        .get();

    const games = gamesSnap.docs.map((d) => d.data());

    // Sort for “best” and “new”
    const byUpdatedDesc = [...games].sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );
    const byCreatedDesc = [...games].sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );

    const buckets = {
        best: byUpdatedDesc.slice(0, limitPerCategory),
        rtp97: games
            .filter((g) => typeof g.rtp === "number" && g.rtp >= 97)
            .slice(0, limitPerCategory),
        exclusive: [], // fill later with real rule/curation
        new: byCreatedDesc.slice(0, limitPerCategory),
    };

    // Write category items with rank
    for (const [categoryId, list] of Object.entries(buckets)) {
        const batch = firestore.batch();
        const colRef = firestore
            .collection("categories")
            .doc(categoryId)
            .collection("items");

        // Clear previous items (simple approach)
        const old = await colRef.get();
        old.docs.forEach((doc) => batch.delete(doc.ref));

        list.forEach((g, idx) => {
            const docRef = colRef.doc(String(g.id));
            batch.set(docRef, {
                gameId: String(g.id),
                rank: idx + 1,
                updatedAt: new Date().toISOString(),
            });
        });

        await batch.commit();
    }
}

export async function runSync() {
    const lastDate = await getLastSyncDate();

    // One-time full sync switch (set FULL_SYNC=true in Render env vars)
    const FULL_SYNC = String(process.env.FULL_SYNC || "").toLowerCase() === "true";
    const updatedAt = FULL_SYNC ? null : (lastDate || null);

    let page = 1;
    let totalFetched = 0;
    let lastSeenUpdatedAt = null;
    let lastPage = null;

    while (true) {
        const data = await fetchGamesPage({ page, perPage: PER_PAGE, updatedAt });

        // SlotsLaunch returns { data: [...], meta: {...} }
        const rawGames = Array.isArray(data) ? data : (data.data || data.games || []);
        const meta = Array.isArray(data) ? null : (data.meta || null);

        if (!rawGames.length) break;

        // Learn last_page from meta (first response is enough)
        if (meta && typeof meta.last_page === "number") {
            lastPage = meta.last_page;
        }

        const normalized = rawGames.map(normalizeGame);
        const publishedOnly = normalized.filter((g) => g.published === true);
        await upsertGames(publishedOnly);

        totalFetched += publishedOnly.length;

        if (publishedOnly.length > 0) {
            lastSeenUpdatedAt =
                publishedOnly[publishedOnly.length - 1]?.updatedAt || lastSeenUpdatedAt;
        } else {
            lastSeenUpdatedAt =
                normalized[normalized.length - 1]?.updatedAt || lastSeenUpdatedAt;
        }

        // Stop condition based on meta, fallback to length-based
        if (lastPage !== null) {
            if (page >= lastPage) break;
        } else {
            if (rawGames.length < PER_PAGE) break;
        }

        page += 1;

        // extra safety limit (keep it, but make it generous)
        if (page > 2000) break;
    }

    await rebuildCategoriesIndex({ limitPerCategory: 80 });

    const today = toDateStringYYYYMMDD(new Date());
    await setLastSyncDate(today);

    return { totalFetched, updatedAtUsed: updatedAt, lastSeenUpdatedAt, lastPage };
}

