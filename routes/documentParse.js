const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const path = require('path');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Japan coordinate bounds
const LAT_MIN = 24, LAT_MAX = 46, LNG_MIN = 122, LNG_MAX = 154;

function normalize(text) {
  // NFKC converts full-width digits/punctuation (３５．６) → ASCII (35.6)
  return text.normalize('NFKC');
}

function dmsToDecimal(deg, min, sec, dir) {
  const decimal = parseFloat(deg) + parseFloat(min) / 60 + parseFloat(sec) / 3600;
  return (dir === 'S' || dir === 'W' || dir === '南' || dir === '西') ? -decimal : decimal;
}

function validateJapan(lat, lng) {
  return lat >= LAT_MIN && lat <= LAT_MAX && lng >= LNG_MIN && lng <= LNG_MAX;
}

// Pattern 1 — Japanese DMS: 北緯35度41分22秒 東経139度41分30秒
const RE_JA_DMS = /北緯\s*(\d+)\s*度\s*(\d+)\s*分\s*([\d.]+)\s*秒\s*[、,\s]*東経\s*(\d+)\s*度\s*(\d+)\s*分\s*([\d.]+)\s*秒/g;

// Pattern 2 — English DMS: 35°41'22"N 139°41'30"E  (also ′ ″ variants)
const RE_EN_DMS = /(\d+)[°˚]\s*(\d+)[′']\s*([\d.]+)[″"]\s*([NS])\s*[,\s]+(\d+)[°˚]\s*(\d+)[′']\s*([\d.]+)[″"]\s*([EW])/g;

// Pattern 3 — Labeled decimal: 緯度: 35.6895 / 経度: 139.6917  (or lat/lon/latitude/longitude)
const RE_LABELED = /(?:緯度|lat(?:itude)?)\s*[:：]\s*([-\d.]+)\s*[\/,、\s]+(?:経度|lon(?:gitude)?|lng)\s*[:：]\s*([-\d.]+)/gi;

// Pattern 4 — Directional decimal: 35.6895N, 139.6917E
const RE_DIRECTIONAL = /([\d.]+)\s*([NS])\s*[,\s]+([\d.]+)\s*([EW])/g;

// Pattern 5 — Bare decimal pair: 35.6895, 139.6917 (4+ decimal places to reduce false positives)
const RE_BARE = /\b((?:2[4-9]|[34]\d|4[0-6])\.\d{4,})\s*[,、]\s*((?:12[2-9]|1[3-4]\d|15[0-4])\.\d{4,})\b/g;

// Pattern 6 — Google Maps URL: @35.6895,139.6917
const RE_GMAPS = /@((?:2[4-9]|[34]\d|4[0-6])\.\d{4,}),((?:12[2-9]|1[3-4]\d|15[0-4])\.\d{4,})/g;

function extractCoordinates(rawText) {
  const text = normalize(rawText);
  const results = [];
  const seen = new Set();

  const add = (lat, lng, index, len) => {
    if (!validateJapan(lat, lng)) return;
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + len + 60);
    const context = text.slice(start, end).replace(/[\r\n\t]+/g, ' ').trim();
    results.push({ lat, lng, context });
  };

  let m;

  // 1. Japanese DMS
  const re1 = new RegExp(RE_JA_DMS.source, 'g');
  while ((m = re1.exec(text)) !== null) {
    const lat = dmsToDecimal(m[1], m[2], m[3], '北');
    const lng = dmsToDecimal(m[4], m[5], m[6], '東');
    add(lat, lng, m.index, m[0].length);
  }

  // 2. English DMS
  const re2 = new RegExp(RE_EN_DMS.source, 'g');
  while ((m = re2.exec(text)) !== null) {
    const lat = dmsToDecimal(m[1], m[2], m[3], m[4]);
    const lng = dmsToDecimal(m[5], m[6], m[7], m[8]);
    add(lat, lng, m.index, m[0].length);
  }

  // 3. Labeled decimal
  const re3 = new RegExp(RE_LABELED.source, 'gi');
  while ((m = re3.exec(text)) !== null) {
    add(parseFloat(m[1]), parseFloat(m[2]), m.index, m[0].length);
  }

  // 4. Directional decimal
  const re4 = new RegExp(RE_DIRECTIONAL.source, 'g');
  while ((m = re4.exec(text)) !== null) {
    const lat = parseFloat(m[1]) * (m[2] === 'S' ? -1 : 1);
    const lng = parseFloat(m[3]) * (m[4] === 'W' ? -1 : 1);
    add(lat, lng, m.index, m[0].length);
  }

  // 5. Bare decimal pair
  const re5 = new RegExp(RE_BARE.source, 'g');
  while ((m = re5.exec(text)) !== null) {
    add(parseFloat(m[1]), parseFloat(m[2]), m.index, m[0].length);
  }

  // 6. Google Maps URL
  const re6 = new RegExp(RE_GMAPS.source, 'g');
  while ((m = re6.exec(text)) !== null) {
    add(parseFloat(m[1]), parseFloat(m[2]), m.index, m[0].length);
  }

  return results.slice(0, 10);
}

// Japanese government inspection forms store coordinates as compact DMS
// numbers (DDMMSS.S / DDDMMSS.S) in the cell next to a 緯度/経度 label,
// not as plain decimal or standard DMS text — the generic regex patterns
// above can't see this until it's normalized into a "緯度: / 経度:" line.
const LAT_KEYWORDS = ['緯度', '北緯'];
const LON_KEYWORDS = ['経度', '東経'];
const LAT_COMPACT_MIN = 240000, LAT_COMPACT_MAX = 465959;   // 24°-46°N
const LON_COMPACT_MIN = 1230000, LON_COMPACT_MAX = 1545959; // 123°-154°E

function normalizeLabel(s) {
  return s.replace(/[ 　]/g, '').trim();
}

function compactDmsToDecimal(value, isLon) {
  const [lo, hi] = isLon ? [LON_COMPACT_MIN, LON_COMPACT_MAX] : [LAT_COMPACT_MIN, LAT_COMPACT_MAX];
  if (value < lo || value > hi) return null;

  const intPart = Math.trunc(value);
  const fracPart = value - intPart;
  const deg = isLon ? Math.trunc(intPart / 10000) : Math.trunc(intPart / 10000);
  const min = Math.trunc((intPart % 10000) / 100);
  const sec = (intPart % 100) + fracPart;

  return Math.round((deg + min / 60 + sec / 3600) * 1e6) / 1e6;
}

function findCoordsByLabel(workbook) {
  for (const sheet of workbook.worksheets) {
    let latVal = null, lonVal = null;

    for (const row of sheet._rows || []) {
      if (!row) continue;
      for (const cell of row._cells || []) {
        if (!cell || cell.value === null || cell.value === undefined) continue;
        const label = normalizeLabel(String(cell.value));

        const isLat = LAT_KEYWORDS.some(k => label.includes(k));
        const isLon = LON_KEYWORDS.some(k => label.includes(k));
        if (!isLat && !isLon) continue;

        // scan the 5 cells to the right for the first numeric value
        for (let offset = 1; offset <= 5; offset++) {
          const adj = sheet.getCell(cell.row, cell.col + offset);
          if (adj.value === null || adj.value === undefined) continue;
          const num = Number(adj.value);
          if (Number.isNaN(num)) continue;
          if (isLat) latVal = compactDmsToDecimal(num, false);
          else lonVal = compactDmsToDecimal(num, true);
          break;
        }

        if (latVal !== null && lonVal !== null) return { lat: latVal, lng: lonVal };
      }
    }
  }
  return null;
}

async function extractExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const coords = findCoordsByLabel(workbook);

  const texts = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => {
      row.eachCell(cell => {
        if (cell.value !== null && cell.value !== undefined) {
          const s = String(cell.value).trim();
          if (s) texts.push(s);
        }
      });
    });
  }

  const flatText = texts.join('\n');
  if (coords) {
    return `緯度: ${coords.lat.toFixed(6)}\n経度: ${coords.lng.toFixed(6)}\n${flatText}`;
  }
  return flatText;
}

async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    return extractExcel(buffer);
  }

  return buffer.toString('utf-8');
}

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルが選択されていません' });

  try {
    const text = await extractText(req.file.buffer, req.file.originalname);
    const coordinates = extractCoordinates(text);
    res.json({ coordinates, filename: req.file.originalname });
  } catch (err) {
    console.error('documentParse error:', err.message);
    res.status(500).json({ error: `ファイルの解析に失敗しました: ${err.message}` });
  }
});

module.exports = router;
