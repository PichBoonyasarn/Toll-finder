const express = require('express');
const router = express.Router();
const { decodePolyline } = require('../lib/polyline');
const { withRetry } = require('../lib/retry');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_FIELD_MASK = [
  'routes.distanceMeters', 'routes.duration', 'routes.polyline.encodedPolyline',
  'routes.travelAdvisory.tollInfo', 'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.startLocation',
].join(',');

async function computeLeg(origin, destination) {
  return withRetry(async () => {
    const body = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'DRIVE',
      languageCode: 'ja',
      units: 'METRIC',
      extraComputations: ['TOLLS'],
      // Without routeModifiers, Google only confirms a toll exists (tollInfo: {}, no price).
      // JP_ETC assumes ETC payment (Japan's near-universal electronic toll system).
      routeModifiers: {
        vehicleInfo: { emissionType: 'GASOLINE' },
        tollPasses: ['JP_ETC'],
      },
    };
    const r = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error) throw new Error(`Routes API: ${json.error.status} ${json.error.message}`);
    if (!json.routes || !json.routes.length) throw new Error('Routes API: no route found');
    return json.routes[0];
  }, { attempts: 3, delayMs: 800 });
}

// Routes API returns toll cost as Money objects per currency inside
// travelAdvisory.tollInfo.estimatedPrice. Returns null when route has no tolls.
function extractTollEstimate(route) {
  const prices = route.travelAdvisory?.tollInfo?.estimatedPrice;
  if (!prices || !prices.length) return null;
  const byCurrency = new Map();
  for (const p of prices) {
    const amount = parseInt(p.units || '0', 10) + (p.nanos || 0) / 1e9;
    byCurrency.set(p.currencyCode, (byCurrency.get(p.currencyCode) || 0) + amount);
  }
  const [currencyCode, amount] = [...byCurrency.entries()][0];
  return { currencyCode, amount: Math.round(amount) };
}

// Scans turn-by-turn steps for toll road names — same heuristic as hotel-finder.
const TOLL_ROAD_TOKEN = /[^\s、/]+(?:高速道路|自動車道|有料道路|高速|線)/g;
const TOLL_ENTER_VERBS = /に入る|を進む|の出口を出る/;
const LANE_BLACKLIST = /^[右左中央]車線$/;
const MANEUVER_PREFIXES = [
  /^斜め(?:左|右)方向に曲がり/, /^右折して(?:そのまま)?/, /^左折して(?:そのまま)?/,
  /^直進(?:して)?/, /^右車線を使用して/, /^左車線を使用して/, /^中央車線を使用して/, /^そのまま/,
];

function stripManeuverPrefixes(line) {
  let s = line;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of MANEUVER_PREFIXES) {
      const stripped = s.replace(re, '');
      if (stripped !== s) { s = stripped; changed = true; }
    }
  }
  return s;
}

function extractTollRoadNames(route) {
  const names = [];
  const seen = new Set();
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const text = step.navigationInstruction?.instructions || '';
      const firstLine = text.split('\n')[0];
      if (!text.includes('有料区間') || !TOLL_ENTER_VERBS.test(firstLine)) continue;
      const cleaned = stripManeuverPrefixes(firstLine);
      for (const token of cleaned.match(TOLL_ROAD_TOKEN) || []) {
        if (LANE_BLACKLIST.test(token)) continue;
        if (!seen.has(token)) { seen.add(token); names.push(token); }
      }
    }
  }
  return names;
}

// Looks up the nearest expressway interchange/exit near a coordinate by:
// (1) reverse-geocoding to get the town/city name, then (2) Places text
// searching for it near the point. Returns the first plausible match, or
// null if nothing found.
// Uses the Legacy Places Text Search API because the New Places API (v1) doesn't
// index Japan expressway interchanges as distinct POIs (empirically confirmed
// 2026-07-05 — nearbysearch with includedTypes returns nothing).
//
// Entries and exits use different naming conventions in Japan: entrances are
// always "◯◯インターチェンジ"/"◯◯IC", while exits are named "◯◯出口" — a
// completely different word. Searching only "インターチェンジ" for an exit
// point (the original behavior) means Google Places is being asked for the
// wrong term entirely and will legitimately find nothing, even though the
// exit is indexed under its real "出口" name. Try the term matching `kind`
// first, then fall back to the other in case a location is labeled unusually.
async function findNearestIC(lat, lng, apiKey, kind = 'entry') {
  if (lat == null || lng == null) return null;
  try {
    const geoRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&language=ja`
    );
    const geoJson = await geoRes.json();
    const result = geoJson.results?.[0];
    if (!result) return null;

    const town = result.address_components.find(ac =>
      ac.types.includes('administrative_area_level_2') || ac.types.includes('locality')
    );
    if (!town) return null;
    const townName = town.long_name.replace(/[市郡町村]$/, '');

    const suffixes = kind === 'exit' ? ['出口', 'インターチェンジ'] : ['インターチェンジ', '出口'];

    for (const suffix of suffixes) {
      const q = encodeURIComponent(`${townName} ${suffix}`);
      const placeRes = await fetch(
        `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&location=${lat},${lng}&radius=10000&key=${apiKey}&language=ja`
      );
      const placeJson = await placeRes.json();
      const candidates = placeJson.results || [];
      // Prefer Google's own intersection tag, but many real IC/exit POIs
      // aren't tagged that way — a name match on the expected term is a
      // reasonable fallback rather than requiring the tag.
      const match = candidates.find(r => r.types?.includes('intersection'))
        || candidates.find(r => /出口|インターチェンジ|IC/.test(r.name || ''));
      if (match) return match.name;
    }
    return null;
  } catch {
    return null;
  }
}

// Parses the exit name from a navigation instruction, e.g.:
// "霞が関 出口を 日比谷/半蔵門/永田町 方面に向かって右方向に進む" → "霞が関出口"
const EXIT_PARSE = /^(.+?)\s出口を/;

async function extractICs(route, apiKey) {
  const allSteps = (route.legs || []).flatMap(leg => leg.steps || []);
  const tollSteps = allSteps.filter(s =>
    (s.navigationInstruction?.instructions || '').includes('有料区間')
  );
  if (!tollSteps.length) return { entryICs: [], exitICs: [] };

  const firstStep = tollSteps[0];
  const lastStep = tollSteps[tollSteps.length - 1];

  const entryLat = firstStep.startLocation?.latLng?.latitude;
  const entryLng = firstStep.startLocation?.latLng?.longitude;
  const exitLat = lastStep.startLocation?.latLng?.latitude;
  const exitLng = lastStep.startLocation?.latLng?.longitude;

  // Parse exit name from instruction text first (works for 首都高 exits and national
  // expressway exits that appear as "XX 出口を..."). Fall back to IC lookup.
  const lastInstr = lastStep.navigationInstruction?.instructions || '';
  const exitTextMatch = lastInstr.match(EXIT_PARSE);
  const exitNameFromText = exitTextMatch ? exitTextMatch[1].trim() + '出口' : null;

  // Run both IC lookups in parallel to minimise latency.
  const [entryIC, exitICFromSearch] = await Promise.all([
    findNearestIC(entryLat, entryLng, apiKey, 'entry'),
    exitNameFromText ? Promise.resolve(null) : findNearestIC(exitLat, exitLng, apiKey, 'exit'),
  ]);

  const exitIC = exitNameFromText || exitICFromSearch;

  return {
    entryICs: entryIC ? [entryIC] : [],
    exitICs: exitIC ? [exitIC] : [],
  };
}

function parseCoord(req, res, prefix) {
  const lat = parseFloat(req.query[`${prefix}Lat`]);
  const lng = parseFloat(req.query[`${prefix}Lng`]);
  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: `${prefix}Lat and ${prefix}Lng are required` });
    return null;
  }
  return { lat, lng };
}

router.get('/leg', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!GOOGLE_MAPS_KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY is not configured' });

  const from = parseCoord(req, res, 'from'); if (!from) return;
  const to   = parseCoord(req, res, 'to');   if (!to) return;

  try {
    const route = await computeLeg(from, to);
    const path = decodePolyline(route.polyline?.encodedPolyline);
    const durationSec = route.duration ? parseInt(route.duration, 10) : null;
    const { entryICs, exitICs } = await extractICs(route, GOOGLE_MAPS_KEY);

    res.json({
      distanceMeters: route.distanceMeters ?? null,
      durationSeconds: durationSec,
      path,
      tollEstimate: extractTollEstimate(route),
      tollRoads: extractTollRoadNames(route),
      entryICs,
      exitICs,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
