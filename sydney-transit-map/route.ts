// app/api/departures/route.ts
// GET /api/departures?stop=<stop id>            -> tidy list of upcoming departures
// GET /api/departures?stop=<stop id>&raw=1      -> the unedited Transport for NSW response (for debugging)

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const stop = searchParams.get("stop");

  // Only plain IDs are allowed, so nothing odd can be slipped into the upstream request
  if (!stop || !/^[A-Za-z0-9_-]{1,40}$/.test(stop)) {
    return Response.json({ error: "Missing or invalid stop" }, { status: 400 });
  }

  const key = process.env.TFNSW_API_KEY;
  if (!key) {
    return Response.json({ error: "TFNSW_API_KEY is not set on the server" }, { status: 500 });
  }

  const url =
    `https://api.transport.nsw.gov.au/v1/tp/departure_mon` +
    `?outputFormat=rapidJSON&coordOutputFormat=EPSG%3A4326&mode=direct` +
    `&type_dm=stop&name_dm=${encodeURIComponent(stop)}` +
    `&departureMonitorMacro=true&TfNSWDM=true&version=10.2.1.42`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `apikey ${key}` },
      next: { revalidate: 20 }, // cache for 20 seconds so many viewers don't each hit the API
    });
  } catch {
    return Response.json({ error: "Could not reach Transport for NSW" }, { status: 502 });
  }

  if (!res.ok) {
    return Response.json({ error: `Transport for NSW returned ${res.status}` }, { status: 502 });
  }

  const data = await res.json();
  if (searchParams.get("raw")) return Response.json(data);

  // The response shape below is written from memory of the Trip Planner API.
  // If events come back empty or oddly named, check ?raw=1 and adjust these field names.
  const events = (data.stopEvents ?? []).slice(0, 12).map((e: any) => {
    const planned: string | null = e.departureTimePlanned ?? null;
    const estimated: string | null = e.departureTimeEstimated ?? null;
    const delayMin =
      planned && estimated ? Math.round((Date.parse(estimated) - Date.parse(planned)) / 60000) : null;
    return {
      line: e.transportation?.disassembledName ?? e.transportation?.number ?? "",
      destination: e.transportation?.destination?.name ?? "",
      platform: e.location?.disassembledName ?? "",
      planned,
      estimated,
      delayMin,
    };
  });

  return Response.json({ stop: data.locations?.[0]?.name ?? null, events });
}
