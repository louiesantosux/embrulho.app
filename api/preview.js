// Desejário — lê a página de um produto (imagem, nome, preço) e serve imagens redimensionadas.
//   /api/preview?url=<link da loja>        -> JSON { images, title, price, site }
//   /api/preview?img=<link da imagem>&w=600 -> imagem redimensionada (WebP) para a largura pedida
const dns = require('dns').promises;
const net = require('net');

const UAS = [
  // Link-preview crawlers: many stores serve full Open Graph data to them and skip bot walls.
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'WhatsApp/2.24.6.77 A',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Twitterbot/1.0'
];
const BROWSER_UA = UAS[3];

/* ---------- safety: only public hosts ---------- */
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return isPrivateIp(m[1]);
    return false;
  }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('protocolo');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('host');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('host');
}
async function safeFetch(u, opts, signal) {
  let url = u, r, hops = 0;
  while (true) {
    await assertPublic(url);
    r = await fetch(url, { ...opts, redirect: 'manual', signal });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc && hops < 6) { url = new URL(loc, url); hops++; continue; }
    return { r, url };
  }
}
async function readText(r, max = 3500000) {
  const reader = r.body.getReader(); const dec = new TextDecoder('utf-8'); let html = '', size = 0;
  while (size < max) { const { done, value } = await reader.read(); if (done) break; size += value.length; html += dec.decode(value, { stream: true }); }
  try { reader.cancel(); } catch (e) {}
  return html;
}

/* ---------- parsing ---------- */
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).trim();
const unescapeJs = s => String(s || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
function metas(html) {
  const out = {}; const re = /<meta\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val != null) { const k = key.toLowerCase(); (out[k] = out[k] || []).push(decode(val)); }
  }
  return out;
}
function jsonLdProducts(html) {
  const all = []; const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) { try { all.push(JSON.parse(m[1].trim())); } catch (e) {} }
  const flat = []; const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); flat.push(o); if (o['@graph']) walk(o['@graph']); if (o.mainEntity) walk(o.mainEntity); if (o.itemListElement) walk(o.itemListElement); };
  walk(all);
  return flat.filter(o => [].concat(o['@type'] || []).some(t => /product|offer/i.test(t)));
}
function parsePrice(v) {
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,]/g, ''); if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s); return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
}
const JUNK = /\.svg(\?|$)|sprite|logo|icon|favicon|pixel|1x1|blank\.|placeholder|spinner|loading|badge|flag|avatar|banner-|\/ads?\//i;
function amazonFull(u) { return u.replace(/\._[^/]*?_\.(jpg|jpeg|png|webp)/i, '.$1'); }

function extract(html, baseUrl) {
  const M = metas(html); const P = jsonLdProducts(html);
  const imgs = []; const seen = new Set();
  const abs = s => { try { const u = new URL(decode(unescapeJs(s)), baseUrl); return /^https?:$/.test(u.protocol) ? u.href : null; } catch (e) { return null; } };
  const add = (s, front) => {
    let a = s && abs(String(s).trim()); if (!a || JUNK.test(a)) return;
    if (/media-amazon\.com\/images\/I\//.test(a)) a = amazonFull(a);
    const key = a.replace(/\?.*$/, ''); if (seen.has(key)) return; seen.add(key);
    front ? imgs.unshift(a) : imgs.push(a);
  };
  const host = new URL(baseUrl).hostname;

  // 1. Open Graph / Twitter
  ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image'].forEach(k => (M[k] || []).forEach(v => add(v)));
  // 2. JSON-LD Product
  P.forEach(p => [].concat(p.image || []).forEach(i => add(typeof i === 'string' ? i : i && (i.url || i.contentUrl))));
  // 3. Store specifics
  if (/amazon\./.test(host) || /amzn\./.test(host)) {
    const hires = html.match(/"(?:hiRes|large|mainUrl)"\s*:\s*"(https:[^"]+?media-amazon\.com\/images\/I\/[^"]+)"/g) || [];
    hires.forEach(h => add(h.replace(/^"[^"]+"\s*:\s*"/, '').replace(/"$/, '')));
    const dyn = html.match(/data-a-dynamic-image\s*=\s*"([^"]+)"/i);
    if (dyn) { try { Object.keys(JSON.parse(decode(dyn[1]))).forEach(k => add(k)); } catch (e) {} }
    (html.match(/data-old-hires\s*=\s*"([^"]+)"/gi) || []).forEach(t => add(t.replace(/^[^"]+"/, '').replace(/"$/, '')));
  }
  // 4. <link rel=image_src>
  const linkImg = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i); if (linkImg) add(linkImg[1]);
  // 5. <img> with lazy-load attributes and srcset (largest candidate)
  const imgRe = /<img\b[^>]*>/gi; let m;
  while ((m = imgRe.exec(html)) && imgs.length < 14) {
    const t = m[0];
    const srcset = (t.match(/\b(?:data-srcset|srcset)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (srcset) {
      const best = srcset.split(',').map(x => x.trim().split(/\s+/)).map(([u, d]) => ({ u, n: parseFloat(d) || 1 })).sort((a, b) => b.n - a.n)[0];
      if (best && !/^data:/.test(best.u)) add(best.u);
    }
    const src = (t.match(/\b(?:data-zoom-image|data-large_image|data-old-hires|data-original|data-lazy-src|data-lazy|data-src|src)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const w = +((t.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || 0);
    if (src && !src.startsWith('data:') && (w === 0 || w >= 180)) add(src);
  }
  // 6. Images referenced inside scripts (pages rendered by JavaScript)
  if (imgs.length < 3) {
    const re = /https?:(?:\\?\/|\\u002F){2}[^"'\s<>)]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s<>)]*)?/gi; let k = 0;
    for (const u of (unescapeJs(html).match(re) || [])) { add(u); if (++k > 60 || imgs.length >= 10) break; }
  }

  const offer = P.map(p => [].concat(p.offers || [])[0]).find(Boolean) || {};
  const priceRaw = (M['product:price:amount'] || M['og:price:amount'] || [])[0] || offer.price || offer.lowPrice || (offer.priceSpecification && offer.priceSpecification.price) || (M['price'] || [])[0];
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const name = (P.find(p => p.name) || {}).name;
  const title = decode(name || (M['og:title'] || [])[0] || (M['twitter:title'] || [])[0] || titleTag || '')
    .replace(/\s+/g, ' ').replace(/\s*[|\-–—]\s*(Amazon\.com\.br|Mercado Livre|Magalu|Shopee Brasil|Americanas|Netshoes|Kabum!?|Shein).*$/i, '').slice(0, 120);
  return { images: imgs.slice(0, 10), title, price: parsePrice(priceRaw), site: ((M['og:site_name'] || [])[0]) || host.replace(/^www\./, '') };
}

/* ---------- store APIs and fallback ---------- */
async function mercadoLivre(url, signal) {
  const id = (url.href.match(/ML[A-Z]-?\d{6,}/i) || [])[0]; if (!id) return null;
  const clean = id.replace('-', '').toUpperCase();
  for (const path of [`items/${clean}`, `products/${clean}`]) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/${path}`, { signal, headers: { Accept: 'application/json' } });
      if (!r.ok) continue; const j = await r.json();
      const pics = (j.pictures || []).map(p => p.secure_url || p.url).filter(Boolean);
      if (pics.length) return { images: pics.slice(0, 10), title: j.title || j.name || '', price: j.price || (j.buy_box_winner && j.buy_box_winner.price) || null, site: 'Mercado Livre' };
    } catch (e) {}
  }
  return null;
}
async function microlink(url, signal) {
  try {
    const r = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url.href), { signal });
    if (!r.ok) return null; const j = await r.json(); const d = j && j.data; if (!d) return null;
    const images = [d.image && d.image.url, d.screenshot && d.screenshot.url].filter(Boolean);
    return images.length ? { images, title: d.title || '', price: null, site: d.publisher || url.hostname } : null;
  } catch (e) { return null; }
}

async function readPage(target, signal) {
  let best = null;
  if (/mercadoli[vb]re|mercadolibre/.test(target.hostname)) { const ml = await mercadoLivre(target, signal); if (ml) return ml; }
  for (const ua of UAS) {
    try {
      const { r, url } = await safeFetch(target, { headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7' } }, signal);
      if (!r.ok) continue;
      const type = r.headers.get('content-type') || '';
      if (type.startsWith('image/')) return { images: [url.href], title: '', price: null, site: url.hostname };
      const data = extract(await readText(r), url);
      if (/mercadoli[vb]re/.test(url.hostname) && !data.images.length) { const ml = await mercadoLivre(url, signal); if (ml) return ml; }
      if (!best || data.images.length > best.images.length || (!best.title && data.title)) best = { ...data, title: data.title || (best && best.title) || '', price: data.price || (best && best.price) || null };
      if (data.images.length && data.title) break;
    } catch (e) { if (signal.aborted) break; }
  }
  if (!best || !best.images.length) { const ml = await microlink(target, signal); if (ml) best = { ...ml, title: (best && best.title) || ml.title, price: best && best.price }; }
  return best || { images: [], title: '', price: null, site: target.hostname };
}

/* ---------- image proxy with resizing ---------- */
let sharp = null; try { sharp = require('sharp'); } catch (e) { sharp = null; }
async function proxyImage(req, res) {
  let u; try { u = new URL(String(req.query.img || '')); } catch (e) { res.status(400).end('bad url'); return; }
  const w = Math.min(1600, Math.max(64, parseInt(req.query.w, 10) || 0)) || 0;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    let r = null;
    for (const ua of [BROWSER_UA, UAS[0]]) {
      try {
        ({ r } = await safeFetch(u, { headers: { 'User-Agent': ua, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: u.origin + '/' } }, ctrl.signal));
        if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) break;
      } catch (e) { if (ctrl.signal.aborted) throw e; }
    }
    const type = r ? (r.headers.get('content-type') || '').split(';')[0].trim() : '';
    if (!r || !r.ok || !type.startsWith('image/') || type.includes('svg')) { res.status(415).end('not an image'); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) { res.status(413).end('too big'); return; }
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=2592000, immutable');
    if (sharp && w) {
      try {
        const out = await sharp(buf, { failOn: 'none' }).rotate().resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        res.setHeader('Content-Type', 'image/webp'); res.status(200).end(out); return;
      } catch (e) { /* fall back to the original bytes */ }
    }
    res.setHeader('Content-Type', type); res.status(200).end(buf);
  } catch (e) { res.status(502).end('fetch failed'); }
  finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  if (req.query.img) return proxyImage(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  let target;
  try { target = new URL(String(req.query.url || '')); await assertPublic(target); }
  catch (e) { res.status(400).end(JSON.stringify({ error: 'Link inválido.' })); return; }
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 9500);
  try {
    const data = await readPage(target, ctrl.signal);
    res.setHeader('Cache-Control', data.images.length ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'public, s-maxage=600');
    res.status(200).end(JSON.stringify(data.images.length ? data : { ...data, error: 'Não encontramos imagem nessa página.' }));
  } catch (e) {
    res.status(200).end(JSON.stringify({ images: [], error: 'Não foi possível ler essa página.' }));
  } finally { clearTimeout(timer); }
};
