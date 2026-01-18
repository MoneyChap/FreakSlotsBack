import { db } from "./firebase.js";
import { fetchGamesPage, buildEmbedUrl } from "./slotslaunch.js";
import { CATEGORY_DEFS } from "./categories.js";

const PER_PAGE = 150;
// const FULL_SYNC = String(process.env.FULL_SYNC || "").toLowerCase() === "true";
// const FULL_SYNC_LIMIT = Number(process.env.FULL_SYNC_LIMIT || 100);
const MAX_SYNC_PAGES = Number(process.env.MAX_SYNC_PAGES || 1);


function toDateStringYYYYMMDD(d) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

export function normalizeGame(g) {
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

    const updatedAtTs = updatedAt ? Date.parse(String(updatedAt)) : 0;
    const createdAtTs = createdAt ? Date.parse(String(createdAt)) : 0;

    const publishedRaw = g.published;
    const published = publishedRaw === true || publishedRaw === 1 || publishedRaw === "1";

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
        updatedAtTs: Number.isFinite(updatedAtTs) ? updatedAtTs : 0,
        createdAtTs: Number.isFinite(createdAtTs) ? createdAtTs : 0,
        published,
        enabled: published,
        apiUrl,
        embedUrl,
    };
}


export async function upsertGames(games) {
    const firestore = db();
    const chunkSize = 250;

    for (let i = 0; i < games.length; i += chunkSize) {
        const batch = firestore.batch();
        const chunk = games.slice(i, i + chunkSize);

        for (const g of chunk) {
            const docRef = firestore.collection("games").doc(String(g.id));
            batch.set(
                docRef,
                { ...g, syncedAt: new Date().toISOString() },
                { merge: true }
            );
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
    await firestore.collection("meta").doc("sync").set(
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

async function rebuildCategoriesIndex({ limitPerCategory = 80, runId } = {}) {
    if (!runId) throw new Error("rebuildCategoriesIndex: missing runId");
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

    for (const [categoryId, list] of Object.entries(buckets)) {
        const batch = firestore.batch();

        const itemsCol = firestore
            .collection("categories")
            .doc(categoryId)
            .collection("runs")
            .doc(runId)
            .collection("items");

        list.forEach((g, idx) => {
            const docRef = itemsCol.doc(String(g.id));
            batch.set(docRef, {
                gameId: String(g.id),
                rank: idx + 1,
                updatedAt: new Date().toISOString(),
            });
        });

        // flip pointer on the category doc (same batch)
        const catRef = firestore.collection("categories").doc(categoryId);
        batch.set(
            catRef,
            {
                activeRunId: runId,
                updatedAt: new Date().toISOString(),
            },
            { merge: true }
        );

        await batch.commit();
    }
}

// Fetch newest published games and store exactly N
export async function seedNewestPublishedGames({ target = 100, maxPages = 10 } = {}) {
    let page = 1;
    const collected = [];

    while (collected.length < target && page <= maxPages) {
        const data = await fetchGamesPage({
            page,
            perPage: PER_PAGE,
            updatedAt: null,
        });

        const rawGames = Array.isArray(data) ? data : (data.data || data.games || []);
        if (!rawGames.length) break;

        // fetchGamesPage already requests published=1, but keep a safety filter
        const normalized = rawGames.map(normalizeGame).filter((g) => g.published === true);

        for (const g of normalized) {
            collected.push(g);
            if (collected.length >= target) break;
        }

        page += 1;
    }

    const finalList = collected.slice(0, target);
    await upsertGames(finalList);
    await setLastSyncDate(toDateStringYYYYMMDD(new Date()));

    return { stored: finalList.length, pagesUsed: page - 1 };
}

export async function runSync() {
    const lastDate = await getLastSyncDate();

    const FULL_SYNC = String(process.env.FULL_SYNC || "").toLowerCase() === "true";
    const updatedAt = FULL_SYNC ? null : (lastDate || null);

    const runId = String(Date.now()); // define BEFORE rebuildCategoriesIndex

    let page = 1;
    let totalFetched = 0;
    let lastSeenUpdatedAt = null;
    let lastPage = null;

    while (true) {
        const data = await fetchGamesPage({ page, perPage: PER_PAGE, updatedAt });

        const rawGames = Array.isArray(data) ? data : (data.data || data.games || []);
        const meta = Array.isArray(data) ? null : (data.meta || null);

        if (!rawGames.length) break;

        if (meta && typeof meta.last_page === "number") lastPage = meta.last_page;

        const normalized = rawGames.map(normalizeGame);
        const publishedOnly = normalized.filter((g) => g.published === true);

        await upsertGames(publishedOnly);

        totalFetched += publishedOnly.length;

        // track last seen updatedAt
        const tail = publishedOnly.length ? publishedOnly[publishedOnly.length - 1] : normalized[normalized.length - 1];
        lastSeenUpdatedAt = tail?.updatedAt || lastSeenUpdatedAt;

        // stop condition
        if (lastPage !== null) {
            if (page >= lastPage) break;
        } else {
            if (rawGames.length < PER_PAGE) break;
        }

        page += 1;
        if (page > MAX_SYNC_PAGES) break;
        if (page > 2000) break;
    }

    const REBUILD_CATEGORIES = String(process.env.REBUILD_CATEGORIES || "false").toLowerCase() === "true";
    if (REBUILD_CATEGORIES) {
        await rebuildCategoriesIndex({ limitPerCategory: 80, runId });
    }

    await setLastSyncDate(toDateStringYYYYMMDD(new Date()));

    return { totalFetched, updatedAtUsed: updatedAt, lastSeenUpdatedAt, lastPage, runId };
}


