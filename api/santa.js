// Embrulho — Amigo secreto: sorteia, grava os códigos e envia por e-mail.
// POST /api/santa  { action: "draw" | "resend", groupId, index? }
// Header: Authorization: Bearer <token do Firebase do organizador>
// Variáveis na Vercel: GMAIL_USER, GMAIL_APP_PASSWORD (e opcional SANTA_SECRET)
const crypto = require('crypto');

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'desejario-521b4';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- Firestore REST helpers ---------- */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
}
function dec(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return null;
}
async function fs(path, token, opts = {}) {
  const r = await fetch(path.startsWith('http') ? path : BASE + path, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((body.error && body.error.message) || 'firestore ' + r.status); e.status = r.status; throw e; }
  return body;
}
const docName = p => `projects/${PROJECT}/databases/(default)/documents/${p}`;

/* ---------- codes ---------- */
function newCode() { const b = crypto.randomBytes(12); let s = ''; for (let i = 0; i < 12; i++) s += ALPHA[b[i] % 32]; return s; }
const pretty = c => c.match(/.{1,4}/g).join('-');
function key() {
  const secret = process.env.SANTA_SECRET || process.env.GMAIL_APP_PASSWORD || '';
  return crypto.createHash('sha256').update('desejario-santa:' + secret).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const out = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
}
function unseal(b64) {
  const buf = Buffer.from(b64, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
// Sattolo: one single cycle, so nobody draws themselves
function sattolo(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- e-mail ---------- */
let transport = null;
function mailer() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '') } });
  return transport;
}
const escHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function brDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }); }
async function sendCode({ to, name, code, group, origin }) {
  const link = `${origin}/#s-${code}`;
  const budget = typeof group.budget === 'number' && group.budget > 0 ? `até R$ ${group.budget.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '';
  const facts = [group.date ? `<b>Quando:</b> ${escHtml(brDate(group.date))}` : '', budget ? `<b>Valor:</b> ${escHtml(budget)}` : ''].filter(Boolean).join('<br>');
  const html = `<!doctype html><html><body style="margin:0;background:#e7ebe5;font-family:Arial,Helvetica,sans-serif;color:#1f2630">
  <div style="max-width:520px;margin:0 auto;padding:28px 16px">
    <div style="background:#ffffff;border-radius:24px;padding:28px">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7f8a85">Embrulho · Amigo secreto</p>
      <h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;font-weight:600">${escHtml(group.name)}</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.5">Oi, ${escHtml(name)}! ${escHtml(group.ownerName || 'O organizador')} te convidou para o amigo secreto. O sorteio já foi feito: use o código abaixo para descobrir quem você tirou.</p>
      ${facts ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4e5960">${facts}</p>` : ''}
      ${group.message ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.5;background:#f3f5f1;border-radius:14px;padding:12px 14px">${escHtml(group.message)}</p>` : ''}
      <div style="text-align:center;background:#1e5a45;color:#fff;border-radius:18px;padding:18px 12px;margin:0 0 18px">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.8">Seu código</div>
        <div style="font-size:28px;font-weight:700;letter-spacing:.12em;margin-top:6px;font-family:Menlo,Consolas,monospace">${pretty(code)}</div>
      </div>
      <p style="text-align:center;margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#9cc9b5;color:#1f2630;text-decoration:none;font-weight:600;padding:14px 22px;border-radius:999px">Ver quem eu tirei</a></p>
      <p style="margin:0;font-size:12.5px;line-height:1.5;color:#7f8a85">Se o botão não abrir, entre em ${escHtml(origin)}, toque em “Tenho um código” e digite o código acima. Não compartilhe este e-mail: ele é só seu.</p>
    </div>
  </div></body></html>`;
  const text = `Oi, ${name}! Amigo secreto "${group.name}". Seu código: ${pretty(code)}. Veja quem você tirou em: ${link}`;
  await mailer().sendMail({ from: `"Embrulho" <${process.env.GMAIL_USER}>`, to, subject: `Amigo secreto: ${group.name} — seu código chegou`, text, html });
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (code, obj) => res.status(code).end(JSON.stringify(obj));
  if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return send(500, { error: 'O envio de e-mails ainda não foi configurado na Vercel (GMAIL_USER e GMAIL_APP_PASSWORD).' });
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return send(401, { error: 'Entre na sua conta para sortear.' });
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { action, groupId, index } = body || {};
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(groupId || ''))) return send(400, { error: 'Grupo inválido.' });
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

  let raw, group;
  try { raw = await fs(`/santaGroups/${groupId}`, token); group = dec({ mapValue: { fields: raw.fields || {} } }); }
  catch (e) { return send(e.status === 403 || e.status === 404 ? 403 : 500, { error: 'Não encontramos esse grupo na sua conta.' }); }
  const people = Array.isArray(group.participants) ? group.participants : [];

  try {
    if (action === 'draw') {
      if (group.status === 'sorteado') return send(409, { error: 'Esse sorteio já foi feito.' });
      if (people.length < 3) return send(400, { error: 'Adicione pelo menos 3 participantes.' });
      if (people.length > 40) return send(400, { error: 'O limite é de 40 participantes.' });
      const emails = people.map(p => String(p.email || '').trim().toLowerCase());
      if (emails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) || new Set(emails).size !== emails.length) return send(400, { error: 'Confira os e-mails: todos precisam ser válidos e diferentes.' });

      // who already has a Embrulho list (to link their wishes)
      const uids = await Promise.all(emails.map(async e => { try { const d = await fs(`/emails/${encodeURIComponent(e)}`, token); return dec(d.fields.uid) || ''; } catch (x) { return ''; } }));
      const order = sattolo(people.length);
      const codes = people.map(() => newCode());
      const now = new Date().toISOString();
      const writes = people.map((p, i) => {
        const t = order[i];
        return { update: { name: docName(`santaInvites/${codes[i]}`), fields: enc({
          groupId, groupName: group.name || 'Amigo secreto', date: group.date || '', budget: typeof group.budget === 'number' ? group.budget : null,
          message: group.message || '', organizerName: group.ownerName || '', name: p.name || '', email: emails[i],
          giftTo: { name: people[t].name || '', uid: uids[t] || '' }, createdAt: now }).mapValue.fields },
          currentDocument: { exists: false } };
      });
      await fs(`${BASE}:commit`.replace('/documents:commit', '/documents:commit'), token, { method: 'POST', body: JSON.stringify({ writes }) });

      const results = await Promise.all(people.map((p, i) => sendCode({ to: emails[i], name: p.name || 'tudo bem', code: codes[i], group, origin }).then(() => true).catch(err => { console.error('mail', err && err.message); return false; })));
      const updated = people.map((p, i) => ({ ...p, email: emails[i], seal: seal(codes[i]), sent: results[i], sentAt: results[i] ? now : '' }));
      await fs(`/santaGroups/${groupId}?updateMask.fieldPaths=status&updateMask.fieldPaths=drawnAt&updateMask.fieldPaths=participants`, token,
        { method: 'PATCH', body: JSON.stringify({ fields: { status: enc('sorteado'), drawnAt: enc(now), participants: enc(updated) } }) });
      return send(200, { ok: true, sent: results.filter(Boolean).length, failed: emails.filter((e, i) => !results[i]) });
    }

    if (action === 'resend') {
      if (group.status !== 'sorteado') return send(400, { error: 'Faça o sorteio antes.' });
      const p = people[Number(index)];
      if (!p || !p.seal) return send(400, { error: 'Participante não encontrado.' });
      let code; try { code = unseal(p.seal); } catch (e) { return send(500, { error: 'Não foi possível recuperar esse código.' }); }
      await sendCode({ to: p.email, name: p.name || 'tudo bem', code, group, origin });
      const now = new Date().toISOString();
      const updated = people.map((x, i) => i === Number(index) ? { ...x, sent: true, sentAt: now } : x);
      await fs(`/santaGroups/${groupId}?updateMask.fieldPaths=participants`, token, { method: 'PATCH', body: JSON.stringify({ fields: { participants: enc(updated) } }) });
      return send(200, { ok: true });
    }
    return send(400, { error: 'Ação desconhecida.' });
  } catch (e) {
    console.error(e);
    return send(500, { error: /invalid login|username and password/i.test(e.message) ? 'O Gmail recusou o login. Confira GMAIL_USER e a senha de app na Vercel.' : 'Não foi possível concluir agora. Tente de novo.' });
  }
};
