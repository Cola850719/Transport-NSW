// app/api/vehicles/route.ts
// GET /api/vehicles           -> live vehicle positions as JSON
// GET /api/vehicles?debug=1   -> state of each feed: ok or error, vehicle count, age in seconds
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const BASE = "https://api.transport.nsw.gov.au";

type Feed = { mode: "train" | "metro" | "lightrail" | "ferry"; path: string };

const FEEDS: Feed[] = [
  { mode: "train", path: "/v2/gtfs/vehiclepos/sydneytrains" },
  { mode: "metro", path: "/v2/gtfs/vehiclepos/metro" },
  { mode: "lightrail", path: "/v2/gtfs/vehiclepos/lightrail/innerwest" },
  { mode: "lightrail", path: "/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast" },
  { mode: "ferry", path: "/v1/gtfs/vehiclepos/ferries/sydneyferries" },
];

// Greater Sydney, so regional trains don't float around outside the map
const BOUNDS = { minLon: 150.5, maxLon: 151.5, minLat: -34.3, maxLat: -33.4 };

// Rate-limit friendliness (Transport for NSW answers 429 if you ask too fast):
const FRESH_MS = 10_000;   // reuse a feed's data for 10 seconds
const RETRY_MS = 5_000;    // after an error, wait 5 seconds before trying that feed again
const STALE_MS = 60_000;   // keep showing the last good positions for up to a minute
const GAP_MS = 300;        // pause between upstream calls so they don't arrive in one burst

type FeedState = { tried: number; ok: number; vehicles: any[]; error: string | null };
const state = new Map<string, FeedState>();   // lives as long as the server instance
let inflight: Promise<void> | null = null;    // lets simultaneous visitors share one refresh

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readFeed(feed: Feed, key: string) {
  const res = await fetch(BASE + feed.path, {
    headers: { Authorization: `apikey ${key}`, Accept: "application/x-google-protobuf" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const message = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);

  const vehicles: any[] = [];
  for (const entity of message.entity as any[]) {
    const v = entity.vehicle;
    const pos = v?.position;
    if (!v || !pos || pos.latitude == null || pos.longitude == null) continue;
    if (
      pos.longitude < BOUNDS.minLon || pos.longitude > BOUNDS.maxLon ||
      pos.latitude < BOUNDS.minLat || pos.latitude > BOUNDS.maxLat
    ) continue;

    vehicles.push({
      id: `${feed.mode}:${v.vehicle?.id ?? entity.id}`,
      mode: feed.mode,
      lat: +pos.latitude.toFixed(5),
      lon: +pos.longitude.toFixed(5),
      bearing: pos.bearing ?? null,
      speedKmh: pos.speed != null ? Math.round(pos.speed * 3.6) : null,
      label: v.vehicle?.label ?? "",
      routeId: v.trip?.routeId ?? "",
      tripId: v.trip?.tripId ?? "",
      timestamp: v.timestamp ? Number(v.timestamp.toString()) : null,
    });
  }
  return vehicles;
}

async function refresh(key: string) {
  let first = true;
  for (const feed of FEEDS) {
    const s = state.get(feed.path);
    const wait = s?.error ? RETRY_MS : FRESH_MS;
    if (s && Date.now() - s.tried < wait) continue;   // recent enough, don't call upstream

    if (!first) await sleep(GAP_MS);
    first = false;

    const now = Date.now();
    try {
      const vehicles = await readFeed(feed, key);
      state.set(feed.path, { tried: now, ok: now, vehicles, error: null });
    } catch (e: any) {
      // Keep the last good positions for a while so one failed call doesn't empty the map
      const keep = s && now - s.ok < STALE_MS ? s.vehicles : [];
      state.set(feed.path, { tried: now, ok: s?.ok ?? 0, vehicles: keep, error: String(e?.message ?? e) });
    }
  }
}

export async function GET(req: Request) {
  const key = process.env.TFNSW_API_KEY;
  if (!key) {
    return Response.json({ error: "TFNSW_API_KEY is not set on the server" }, { status: 500 });
  }

  if (!inflight) inflight = refresh(key).finally(() => { inflight = null; });
  await inflight;

  const vehicles: any[] = [];
  let failed = 0;
  const feeds = FEEDS.map((f) => {
    const s = state.get(f.path);
    if (!s) return { path: f.path, ok: false, error: "not fetched yet" };
    vehicles.push(...s.vehicles);
    if (s.error) failed++;
    return {
      path: f.path,
      ok: s.error === null,
      count: s.vehicles.length,
      ageSeconds: s.ok ? Math.round((Date.now() - s.ok) / 1000) : null,
      ...(s.error ? { error: s.error } : {}),
    };
  });

  const body = new URL(req.url).searchParams.get("debug") ? { feeds } : { vehicles, failed };
  return Response.json(body, {
    headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=10" },
  });
}
