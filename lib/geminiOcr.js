// Falls back to Gemini's vision model to transcribe text from image-based
// PDF pages that pdf-parse can't extract anything from (scanned documents,
// or coordinate info embedded in a diagram rather than the text layer).
// Uses the older, stable generateContent endpoint rather than the newer
// Interactions API: this is a simple one-shot "read this image" call with
// no multi-turn state needed, so there's no benefit to the newer surface,
// and generateContent remains fully supported by Google.
// Free tier: observed live as "limit: 20" for generate_content_free_tier_requests
// on gemini-2.5-flash (2026-07-06) — much lower than the ~1,500/day figure
// generally quoted for the Gemini API, so don't assume headroom; a handful
// of test documents can exhaust it.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const OCR_PROMPT = 'Transcribe all visible text in this image exactly as written, ' +
  'including any coordinate, latitude/longitude, or 緯度/経度 information. ' +
  'Output only the raw transcribed text, preserving line breaks. ' +
  'Do not translate, summarize, or add commentary.';

function isGeminiConfigured() {
  return !!GEMINI_API_KEY;
}

// Returns the transcribed text, or '' on any failure (missing key, network
// error, quota exceeded, no text found) — callers treat that as "OCR found
// nothing usable" and move on, same graceful-degradation pattern used
// elsewhere in this app (e.g. findNearestIC).
async function ocrImageToText(base64Png) {
  if (!GEMINI_API_KEY) return '';

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: OCR_PROMPT },
              { inline_data: { mime_type: 'image/png', data: base64Png } },
            ],
          }],
        }),
      });
      const body = await res.json();
      if (body.error) {
        // RESOURCE_EXHAUSTED means the quota window is used up — retrying
        // immediately can't succeed and only wastes more of it once it does
        // reopen. Only retry genuinely transient errors (e.g. UNAVAILABLE,
        // Google's "high demand" 503).
        if (body.error.status === 'RESOURCE_EXHAUSTED') return '';
        throw new Error(`Gemini API: ${body.error.status} ${body.error.message}`);
      }
      return body.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch {
      if (i === attempts - 1) return '';
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return '';
}

module.exports = { ocrImageToText, isGeminiConfigured };
