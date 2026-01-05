import fetch from "node-fetch";

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

const BASE = "https://slotslaunch.com/api";

export async function fetchGamesPage({ page, perPage, updatedAt }) {
    const token = requireEnv("SLOTSLAUNCH_TOKEN");
    const host = requireEnv("SLOTSLAUNCH_HOST");

    const url = new URL(`${BASE}/games`);
    url.searchParams.set("token", token);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("published", 1);
    url.searchParams.set("order_by", "updated_at");
    url.searchParams.set("order", "desc");

    if (updatedAt) {
        // format: yyyy-mm-dd
        url.searchParams.set("updated_at", updatedAt);
    }

    const res = await fetch(url.toString(), {
        headers: {
            // SlotsLaunch expects host/origin header to match your site host
            origin: host.startsWith("http") ? host : `https://${host}`,
        },
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`SlotsLaunch error ${res.status}: ${txt.slice(0, 300)}`);
    }

    return res.json();
}

// Build iframe URL the frontend can use directly.
// If SlotsLaunch already returns url as /iframe/{id}, we still append token safely.
export function buildEmbedUrl(gameUrlFromApi) {
    const token = process.env.SLOTSLAUNCH_TOKEN;
    if (!token) throw new Error("Missing env: SLOTSLAUNCH_TOKEN");

    const u = new URL(gameUrlFromApi);
    if (!u.searchParams.has("token")) u.searchParams.set("token", token);
    return u.toString();
}
