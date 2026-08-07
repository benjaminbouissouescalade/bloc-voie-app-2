// src/routes/news.js
// Proxy + cache pour le flux RSS d'actualités escalade (PlanetGrimpe)
const express = require('express');
const router = express.Router();

const FEED_URL = 'https://planetgrimpe.com/actualites/feed/';
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

// GET /api/news — dernières actus escalade (mises en cache côté serveur)
router.get('/', async (req, res) => {
  const now = Date.now();
  if (now - cache.fetchedAt < TTL_MS && cache.items.length) {
    return res.json({ items: cache.items, cached: true });
  }
  try {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(FEED_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlocVoieApp/1.0)' }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const xml = await resp.text();
    const items = parseRss(xml);
    if (items.length) cache = { items, fetchedAt: now };
    res.json({ items: cache.items, cached: false });
  } catch (err) {
    console.error('Erreur récupération flux RSS actus escalade:', err.message);
    // On renvoie le cache existant (même expiré) plutôt qu'une erreur — le bandeau reste silencieux si vide
    res.json({ items: cache.items, cached: true, stale: true });
  }
});

module.exports = router;
