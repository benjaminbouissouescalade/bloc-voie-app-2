// src/routes/news.js
// Proxy + cache pour le flux RSS d'actualités escalade (PlanetGrimpe)
const express = require('express');
const router = express.Router();

const FEED_URL = 'https://planetgrimpe.com/feed/'; // flux global du site (le flux de la page /actualites/ est un agrégat sans propre flux RSS — canal vide)
const TTL_MS = 3 * 60 * 60 * 1000; // 3h — évite de solliciter le site à chaque visite

let cache = { items: [], fetchedAt: 0 };

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : null;
}

function cleanText(raw) {
  if (!raw) return '';
  let s = raw;
  const cdata = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) s = cdata[1];
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
  return s.trim();
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of blocks.slice(0, 10)) {
    const title = cleanText(extractTag(block, 'title'));
    const link = cleanText(extractTag(block, 'link'));
    const pubDate = cleanText(extractTag(block, 'pubDate'));
    if (title && link) items.push({ title, link, date: pubDate || null });
  }
  return items;
}

async function fetchFeed(url) {
  // fetch global natif (Node >=18) — plus besoin de node-fetch, un point de panne en moins
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetchFn(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

// GET /api/news — dernières actus escalade (mises en cache côté serveur)
router.get('/', async (req, res) => {
  const now = Date.now();
  if (now - cache.fetchedAt < TTL_MS && cache.items.length) {
    return res.json({ items: cache.items, cached: true });
  }
  try {
    const xml = await fetchFeed(FEED_URL);
    const items = parseRss(xml);
    if (items.length) cache = { items, fetchedAt: now };
    res.json({ items: cache.items, cached: false, debug: items.length ? undefined : ('0 item parsé, réponse reçue (' + xml.length + ' car.), début: ' + xml.slice(0, 120)) });
  } catch (err) {
    console.error('Erreur récupération flux RSS actus escalade:', err.message);
    // On renvoie le cache existant (même expiré) plutôt qu'une erreur — le bandeau reste silencieux si vide
    res.json({ items: cache.items, cached: true, stale: true, debug: err.message });
  }
});

module.exports = router;
