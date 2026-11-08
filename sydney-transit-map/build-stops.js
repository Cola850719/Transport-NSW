// Usage: node build-stops.js [path/to/stops.txt] [output.json]
// Converts a GTFS stops.txt into a compact stops.json: [[name, lon, lat, type, stop_id], ...]
// type: 0 = bus, 1 = train/metro station, 2 = ferry wharf, 3 = light rail
const fs = require('fs');

const input = process.argv[2] || 'stops.txt';
const output = process.argv[3] || 'stops.json';

// Rough Greater Sydney bounding box (the full file covers all of NSW)
const BOUNDS = { minLon: 150.55, maxLon: 151.45, minLat: -34.25, maxLat: -33.55 };

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

// GTFS stops have no mode field, so this guesses from the stop name.
function classify(name) {
    if (/wharf/i.test(name)) return 2;
    if (/light rail/i.test(name)) return 3;
    if (/station/i.test(name)) return 1;
    return 0;
}

const text = fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter(Boolean);
const header = parseLine(lines[0]);
const col = n => header.indexOf(n);
const iName = col('stop_name'), iLat = col('stop_lat'), iLon = col('stop_lon');
const iType = col('location_type'), iParent = col('parent_station');
const iId = col('stop_id');

if (iName < 0 || iLat < 0 || iLon < 0) {
    console.error('stops.txt is missing stop_name, stop_lat or stop_lon columns.');
    process.exit(1);
}

const seen = new Set();
const result = [];
const counts = [0, 0, 0, 0];

for (let n = 1; n < lines.length; n++) {
    const f = parseLine(lines[n]);
    const lat = parseFloat(f[iLat]), lon = parseFloat(f[iLon]);
    if (isNaN(lat) || isNaN(lon)) continue;
    if (lon < BOUNDS.minLon || lon > BOUNDS.maxLon || lat < BOUNDS.minLat || lat > BOUNDS.maxLat) continue;

    const locType = iType >= 0 ? (f[iType] || '0') : '0';
    const parent = iParent >= 0 ? f[iParent] : '';
    // Keep stations (1) and standalone stops (0 with no parent).
    // Skip platforms inside stations, entrances and boarding nodes to avoid duplicates.
    if (locType !== '1' && !(locType === '0' && !parent)) continue;

    const name = f[iName];
    const key = name + '|' + lon.toFixed(4) + '|' + lat.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);

    const type = classify(name);
    counts[type]++;
    result.push([name, +lon.toFixed(5), +lat.toFixed(5), type, iId >= 0 ? f[iId] : '']);
}

fs.writeFileSync(output, JSON.stringify(result));
console.log(`Wrote ${result.length} stops to ${output}`);
console.log(`  bus: ${counts[0]}, train/metro: ${counts[1]}, ferry: ${counts[2]}, light rail: ${counts[3]}`);
