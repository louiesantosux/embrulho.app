// Desejário — lê a página de um produto e devolve imagem, nome e preço.
// Roda como função da Vercel em /api/preview?url=...
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
function metas(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val != null) { const k = key.toLowerCase(); if (!(k in out)) out[k] = decode(val); }
  }
  return out;
}
function jsonLd(html) {
  const res = []; const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) { try { const j = JSON.parse(m[1].trim()); res.push(...(Array.isArray(j) ? j : [j])); } catch (e) {} }
  const flat = [];
  const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); flat.push(o); if (o['@graph']) walk(o['@graph']); };
  walk(res);
  return flat.find(o => [].concat(o['@type'] || []).some(t => /product/i.test(t)));
}
function parsePrice(v) {
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,]/g, ''); if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  let target;
  try { target = new URL(String(req.query.url || '')); await assertPublic(target); }
  catch (e) { res.status(400).end(JSON.stringify({ error: 'Link inválido.' })); return; }

  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    let url = target, r, hops = 0;
    while (true) {
      r = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.7' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc && hops < 5) { url = new URL(loc, url); await assertPublic(url); hops++; continue; }
      break;
    }
    if (!r.ok) { res.status(200).end(JSON.stringify({ images: [], error: 'A loja não respondeu.' })); return; }
    const reader = r.body.getReader(); let html = '', size = 0; const dec = new TextDecoder('utf-8');
    while (size < 1500000) { const { done, value } = await reader.read(); if (done) break; size += value.length; html += dec.decode(value, { stream: true }); }
    try { reader.cancel(); } catch (e) {}

    const M = metas(html); const P = jsonLd(html) || {};
    const abs = s => { try { const u = new URL(decode(s), url); return /^https?:$/.test(u.protocol) ? u.href : null; } catch (e) { return null; } };
    const imgs = [];
    const add = s => { const a = s && abs(s); if (a && !imgs.includes(a) && !/\.svg(\?|$)|sprite|logo|icon|favicon|pixel|1x1|blank\./i.test(a)) imgs.push(a); };
    add(M['og:image:secure_url']); add(M['og:image']); add(M['twitter:image']); add(M['twitter:image:src']);
    [].concat(P.image || []).forEach(i => add(typeof i === 'string' ? i : i && (i.url || i.contentUrl)));
    const linkImg = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i); if (linkImg) add(linkImg[1]);
    const imgRe = /<img\b[^>]*>/gi; let m;
    while ((m = imgRe.exec(html)) && imgs.length < 8) {
      const t = m[0]; const src = (t.match(/\b(?:data-zoom-image|data-old-hires|data-src|src)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const w = +((t.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || 0);
      if (src && !src.startsWith('data:') && (w === 0 || w >= 200)) add(src);
    }
    const offers = [].concat(P.offers || [])[0] || {};
    const price = parsePrice(M['product:price:amount'] || M['og:price:amount'] || offers.price || offers.lowPrice || M['price']);
    const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const title = decode(P.name || M['og:title'] || M['twitter:title'] || titleTag || '').replace(/\s+/g, ' ').slice(0, 120);
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).end(JSON.stringify({ images: imgs.slice(0, 8), title, price, site: M['og:site_name'] || url.hostname.replace(/^www\./, '') }));
  } catch (e) {
    res.status(200).end(JSON.stringify({ images: [], error: 'Não foi possível ler essa página.' }));
  } finally { clearTimeout(timer); }
};

