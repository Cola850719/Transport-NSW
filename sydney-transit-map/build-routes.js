// Usage: node build-routes.js [folder with routes.txt, trips.txt, shapes.txt] [output.json]
// Builds routes.json: [[name, mode, [[lon,lat,lon,lat,...], ...]], ...]
// mode: train | metro | lightrail | ferry   (buses are skipped: too many routes)
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const dir = process.argv[2] || '.';
const output = process.argv[3] || 'routes.json';

// Slightly wider than the stops box so lines run off the edge of the map cleanly
const BOUNDS = { minLon: 150.50, maxLon: 151.45, minLat: -34.30, maxLat: -33.45 };
const SHAPES_PER_LINE = 3;     // keep the 3 most-used shapes per line (covers branches)
const SIMPLIFY_TOLERANCE = 0.0001; // degrees, roughly 10 m

function parseLine(line) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else quoted = false;
            } else cur += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}

// Reads a CSV one row at a time so huge files (shapes.txt) don't fill memory.
async function eachRow(file, fn) {
    const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });
    let col = null;
    for await (let line of rl) {
        if (!line) continue;
        if (!col) {
            line = line.replace(/^\uFEFF/, '');
            col = {};
            parseLine(line).forEach((h, i) => { col[h.trim()] = i; });
            continue;
        }
        fn(line.indexOf('"') === -1 ? line.split(',') : parseLine(line), col);
    }
}

// Handles both standard GTFS route_type codes and the extended ones.
function modeOf(t) {
    t = +t;
    if (t === 2 || (t >= 100 && t < 200)) return 'train';
    if (t === 1 || (t >= 400 && t < 500)) return 'metro';
    if (t === 0 || (t >= 900 && t < 1000)) return 'lightrail';
    if (t === 4 || (t >= 1000 && t < 1300)) return 'ferry';
    return null;
}

function perpDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Douglas-Peucker line simplification (iterative, so long lines can't overflow the stack)
function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let maxD = 0, idx = -1;
        for (let i = a + 1; i < b; i++) {
            const d = perpDist(pts[i], pts[a], pts[b]);
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (idx > 0 && maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
}

function inside(lon, lat) {
    return lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon && lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat;
}

(async () => {
    // 1. Which routes are trains, metro, light rail or ferries?
    const routes = new Map();
    const typeCounts = {};
    await eachRow(path.join(dir, 'routes.txt'), (f, c) => {
        const t = f[c.route_type];
        typeCounts[t] = (typeCounts[t] || 0) + 1;
        const mode = modeOf(t);
        if (!mode) return;
        const name = (f[c.route_short_name] || f[c.route_long_name] || f[c.route_id]).trim();
        routes.set(f[c.route_id], { mode, name });
    });
    console.log('route_type values found in routes.txt:', typeCounts);
    console.log('Routes kept (rail, metro, light rail, ferry):', routes.size);

    // 2. For each line, count how many trips use each shape
    const groups = new Map(); // "mode|name" -> { mode, name, shapes: Map(shape_id -> trips) }
    await eachRow(path.join(dir, 'trips.txt'), (f, c) => {
        const r = routes.get(f[c.route_id]);
        const sid = f[c.shape_id];
        if (!r || !sid) return;
        const key = r.mode + '|' + r.name;
        let g = groups.get(key);
        if (!g) { g = { mode: r.mode, name: r.name, shapes: new Map() }; groups.set(key, g); }
        g.shapes.set(sid, (g.shapes.get(sid) || 0) + 1);
    });
    console.log('Lines found:', groups.size);

    // 3. Keep the most-used shapes for each line
    const wanted = new Map(); // shape_id -> array of points (filled in step 4)
    groups.forEach(g => {
        g.top = [...g.shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHAPES_PER_LINE).map(e => e[0]);
        g.top.forEach(id => wanted.set(id, []));
    });

    // 4. Read the points for only those shapes
    await eachRow(path.join(dir, 'shapes.txt'), (f, c) => {
        const arr = wanted.get(f[c.shape_id]);
        if (arr) arr.push([+f[c.shape_pt_sequence], +f[c.shape_pt_lon], +f[c.shape_pt_lat]]);
    });

    // 5. Clip to Sydney, simplify, drop duplicate (reversed) shapes, write out
    const result = [];
    const modeCounts = {};
    groups.forEach(g => {
        const seen = new Set();
        const lines = [];
        g.top.forEach(id => {
            const pts = wanted.get(id).sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);
            if (pts.length < 2) return;
            // the same track run in the other direction is the same line: skip it
            const a = pts[0].map(v => v.toFixed(3)).join(',');
            const b = pts[pts.length - 1].map(v => v.toFixed(3)).join(',');
            const key = [a, b].sort().join('|');
            if (seen.has(key)) return;
            seen.add(key);

            let run = [];
            const flush = () => {
                if (run.length >= 2) {
                    const flat = [];
                    simplify(run, SIMPLIFY_TOLERANCE).forEach(p => flat.push(+p[0].toFixed(5), +p[1].toFixed(5)));
                    lines.push(flat);
                }
                run = [];
            };
            pts.forEach(p => { if (inside(p[0], p[1])) run.push(p); else flush(); });
            flush();
        });
        if (lines.length) {
            result.push([g.name, g.mode, lines]);
            modeCounts[g.mode] = (modeCounts[g.mode] || 0) + 1;
        }
    });

    fs.writeFileSync(output, JSON.stringify(result));
    console.log(`Wrote ${result.length} lines to ${output}`, modeCounts);
})().catch(err => {
    console.error('Failed:', err.message);
    console.error('Check that routes.txt, trips.txt and shapes.txt are in the folder you pointed at.');
    process.exit(1);
});