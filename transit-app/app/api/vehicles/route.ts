// app/api/vehicles/route.ts
// GET /api/vehicles           -> live vehicle positions as JSON
// GET /api/vehicles?debug=1   -> which feeds worked, with HTTP status and vehicle counts
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const BASE = "https://api.transport.nsw.gov.au";

type Feed = { mode: "train" | "metro" | "lightrail" | "ferry"; path: string };

const FEEDS: Feed[] = [
  { mode: "train", path: "/v2/gtfs/vehiclepos/sydneytrains" },
  { mode: "metro", path: "/v2/gtfs/vehiclepos/metro" },
  { mode: "lightrail", path: "/v2/gtfs/vehiclepos/lightrail/innerwest" },
  // The next two paths are from memory of the older v1 feeds.
  // If one is wrong, ?debug=1 will show its error and the others still work.
  { mode: "lightrail", path: "/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast" },
  { mode: "ferry", path: "/v1/gtfs/vehiclepos/ferries/sydneyferries" },
];

// Greater Sydney, so regional trains don't float around outside the map
const BOUNDS = { minLon: 150.5, maxLon: 151.5, minLat: -34.3, maxLat: -33.4 };

async function readFeed(feed: Feed, key: string) {
  const res = await fetch(BASE + feed.path, {
    headers: { Authorization: `apikey ${key}`, Accept: "application/x-google-protobuf" },
    next: { revalidate: 10 }, // upstream is hit at most once per feed every 10 seconds
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

export async function GET(req: Request) {
  const key = process.env.TFNSW_API_KEY;
  if (!key) {
    return Response.json({ error: "TFNSW_API_KEY is not set on the server" }, { status: 500 });
  }

  const results = await Promise.allSettled(FEEDS.map((f) => readFeed(f, key)));

  const vehicles: any[] = [];
  const feeds = results.map((r, i) => {
    if (r.status === "fulfilled") {
      vehicles.push(...r.value);
      return { path: FEEDS[i].path, ok: true, count: r.value.length };
    }
    return { path: FEEDS[i].path, ok: false, error: String(r.reason?.message ?? r.reason) };
  });

  const debug = new URL(req.url).searchParams.get("debug");
  const body = debug ? { feeds } : { vehicles, failed: feeds.filter((f) => !f.ok).length };

  return Response.json(body, {
    headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=10" },
  });
}
