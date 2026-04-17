/* ═══════════════════════════════════════════════════════
   CTpaste — /api/ocr.js  (Vercel Serverless Function)
   Proxies image to OCR.space using a server-side API key.
   POST /api/ocr   →   { image: "data:image/jpeg;base64,..." }
   Returns          →   { success: true, text: "..." }
   ═══════════════════════════════════════════════════════ */

module.exports = async function handler(req, res) {
    // ── CORS headers ───────────────────────────────────────
    res.setHeader("Access-Control-Allow-Credentials", true);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST")
        return res.status(405).json({ success: false, error: "Method not allowed" });

    // ── API key from Vercel environment variables ──────────
    const apiKey = process.env.OCR_API_KEY;
    if (!apiKey)
        return res.status(500).json({ success: false, error: "OCR service not configured (missing env var)" });

    const { image } = req.body || {};
    if (!image)
        return res.status(400).json({ success: false, error: "No image provided in request body" });

    // ── Call OCR.space ─────────────────────────────────────
    try {
        const params = new URLSearchParams();
        params.append("apikey", apiKey);
        params.append("base64Image", image);   // data:image/jpeg;base64,...
        params.append("language", "eng");
        params.append("isOverlayRequired", "false");
        params.append("detectOrientation", "true");
        params.append("scale", "true");
        params.append("OCREngine", "2");       // Engine 2 handles screenshots better

        const ocrRes = await fetch("https://api.ocr.space/parse/image", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString()
        });

        if (!ocrRes.ok)
            return res.status(200).json({ success: false, error: `OCR.space returned HTTP ${ocrRes.status}` });

        const data = await ocrRes.json();

        if (data.IsErroredOnProcessing) {
            const errMsg = (data.ErrorMessage && data.ErrorMessage[0]) || "OCR processing failed";
            return res.status(200).json({ success: false, error: errMsg });
        }

        const text = (data.ParsedResults && data.ParsedResults[0] && data.ParsedResults[0].ParsedText) || "";

        if (!text.trim())
            return res.status(200).json({ success: false, error: "No text could be extracted from the image" });

        return res.status(200).json({ success: true, text });

    } catch (err) {
        console.error("[OCR proxy error]", err);
        return res.status(500).json({ success: false, error: "Internal server error: " + err.message });
    }
};
