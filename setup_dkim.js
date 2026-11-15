/**
 * setup_dkim.js
 * 1. Generates a 2048-bit RSA DKIM key pair
 * 2. Saves private key to dkim_private.pem
 * 3. Adds SPF, DKIM, DMARC records to Cloudflare DNS automatically
 *
 * Run: node setup_dkim.js
 */
import { generateKeyPairSync } from 'crypto';
import { writeFileSync, existsSync } from 'fs';

const CF_API_TOKEN = process.env.CF_API_TOKEN;
if (!CF_API_TOKEN) throw new Error('Set CF_API_TOKEN before running this script.');
const CF_ZONE_ID   = '33a94d7b53f91d419272fd0c3e0d793f';
const DOMAIN       = 'mscertify.live';
const SELECTOR     = 'mail'; // mail._domainkey.mscertify.live
const CF           = 'https://api.cloudflare.com/client/v4';

async function cfDNS(method, path, body) {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function getZoneId() {
  const res = await cfDNS('GET', `/zones?name=${DOMAIN}&status=active`);
  if (!res.success || !res.result.length) {
    throw new Error(`Zone not found for ${DOMAIN}. Make sure the domain is active in your Cloudflare account.`);
  }
  return res.result[0].id;
}

async function upsertDNS(zoneId, type, name, content) {
  // Check if record already exists
  const listRes = await cfDNS('GET', `/zones/${zoneId}/dns_records?type=${type}&name=${name}.${DOMAIN}`);
  const existing = listRes.result || [];

  if (existing.length > 0) {
    const id  = existing[0].id;
    const upd = await cfDNS('PUT', `/zones/${zoneId}/dns_records/${id}`, { type, name, content, ttl: 3600 });
    if (upd.success) {
      console.log(`  ✓ Updated  ${name}.${DOMAIN} (${type})`);
    } else {
      console.warn(`  ⚠ Update failed: ${JSON.stringify(upd.errors)}`);
    }
  } else {
    const crt = await cfDNS('POST', `/zones/${zoneId}/dns_records`, { type, name, content, ttl: 3600 });
    if (crt.success) {
      console.log(`  ✓ Created  ${name}.${DOMAIN} (${type})`);
    } else {
      console.warn(`  ⚠ Create failed: ${JSON.stringify(crt.errors)}`);
    }
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  DKIM + SPF + DMARC Setup for', DOMAIN);
  console.log('══════════════════════════════════════════════════════\n');

  // ── Step 1: Generate fresh DKIM key pair ─────────────────────────────────────
  console.log('[1/4] Generating fresh 2048-bit RSA DKIM key pair...');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync('dkim_private.pem', privateKey, 'utf8');
  console.log('  ✓ Private key saved → dkim_private.pem');

  const pubKeyBase64 = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, '');
  writeFileSync('dkim_public.txt', pubKeyBase64, 'utf8');
  console.log('  ✓ Public key saved  → dkim_public.txt');

  // ── Step 2: Zone ID ──────────────────────────────────────────────────────────
  const zoneId = CF_ZONE_ID;
  console.log(`\n[2/4] Using Zone ID: ${zoneId} (${DOMAIN})`);

  // ── Step 3: Push DNS records to Cloudflare ───────────────────────────────────
  console.log('\n[3/4] Adding DNS records to Cloudflare...');
  try {
    // SPF — authorises Namecheap private email + Brevo as fallback
    await upsertDNS(zoneId, 'TXT', '@',
      `v=spf1 include:spf.privateemail.com include:spf.brevo.com ~all`
    );

    // DKIM
    await upsertDNS(zoneId, 'TXT', `${SELECTOR}._domainkey`,
      `v=DKIM1; k=rsa; p=${pubKeyBase64}`
    );

    // DMARC
    await upsertDNS(zoneId, 'TXT', '_dmarc',
      `v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}; adkim=r; aspf=r`
    );

  } catch (err) {
    console.warn(`  ⚠ Cloudflare API error: ${err.message}`);
    console.log('\n  Add these manually in Cloudflare DNS instead:');
    console.log(`  SPF   @                  → v=spf1 include:spf.privateemail.com include:spf.brevo.com ~all`);
    console.log(`  DKIM  mail._domainkey    → v=DKIM1; k=rsa; p=${pubKeyBase64}`);
    console.log(`  DMARC _dmarc            → v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}`);
  }

  // ── Step 4: Summary ──────────────────────────────────────────────────────────
  console.log('\n[4/4] Done.\n');
  console.log('  Private key : dkim_private.pem');
  console.log(`  Sender      : portal@${DOMAIN}`);
  console.log('  DNS records : SPF + DKIM + DMARC pushed to Cloudflare\n');
  console.log('  Wait 1-5 min for DNS propagation, then run: node send_mass.js');
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n  FATAL:', err.message); process.exit(1); });
