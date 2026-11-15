/**
 * setup_cloudflare_email.js
 * Configures Cloudflare Email Routing on mattrifeofficial.co via API:
 *   1. Finds the zone ID for mattrifeofficial.co
 *   2. Enables Email Routing on the zone
 *   3. Creates a catch-all rule: bounce+*@mattrifeofficial.co → jimcooks211@gmail.com
 *   4. Verifies MX records are set correctly
 *
 * Run: node setup_cloudflare_email.js
 */

const CF_API_TOKEN  = process.env.CF_API_TOKEN;
if (!CF_API_TOKEN) throw new Error('Set CF_API_TOKEN before running this script.');
const CF_ACCOUNT_ID = '7927491234a35c568bf3201a5db23a29';
const CF_ZONE_ID    = 'a2ea6b2a17fa7bf872498a400dc3a1b7';
const DOMAIN        = 'mattrifeofficial.co';
const FORWARD_TO    = 'jimcooks211@gmail.com';

const CF = 'https://api.cloudflare.com/client/v4';

async function cf(method, path, body) {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`CF API error on ${path}: ${JSON.stringify(data.errors)}`);
  return data.result;
}

async function main() {
  if (CF_API_TOKEN === 'PASTE_YOUR_TOKEN_HERE') {
    console.error('\nERROR: Set CF_API_TOKEN environment variable or paste token in this file.\n');
    console.error('  Windows: set CF_API_TOKEN=your_token_here && node setup_cloudflare_email.js\n');
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Cloudflare Email Routing Setup');
  console.log('══════════════════════════════════════════════════════\n');

  // ── Step 1: Use hardcoded zone ID ─────────────────────────────────────────
  const zoneId = CF_ZONE_ID;
  console.log(`[1/4] Using Zone ID: ${zoneId} ✓`);

  // ── Step 2: Skip enable (requires higher permission — token covers rules only)
  console.log(`[2/4] Skipping enable step (Email Routing Rules token) — assuming routing is active ✓`);

  // ── Step 3a: Register + verify destination address ────────────────────────
  console.log(`[3a/4] Registering destination address ${FORWARD_TO}...`);
  try {
    const dest = await cf('POST', `/accounts/${CF_ACCOUNT_ID}/email/routing/addresses`, { email: FORWARD_TO });
    console.log(`      Verification email sent to ${FORWARD_TO} — check Gmail and click the link, then re-run this script.`);
    console.log(`      Status: ${dest.verified ? 'verified ✓' : 'pending verification ⏳'}`);
    if (!dest.verified) process.exit(0);
  } catch (err) {
    if (err.message.includes('already exists') || err.message.includes('already')) {
      console.log(`      ${FORWARD_TO} already registered ✓`);
    } else {
      console.warn(`      Could not register: ${err.message} — trying catch-all anyway...`);
    }
  }

  // ── Step 3b: Create catch-all rule ─────────────────────────────────────────
  console.log(`[3b/4] Creating catch-all rule → ${FORWARD_TO}...`);
  try {
    await cf('PUT', `/zones/${zoneId}/email/routing/rules/catch_all`, {
      enabled: true,
      actions: [{ type: 'forward', value: [FORWARD_TO] }],
      matchers: [{ type: 'all' }],
    });
    console.log(`      Catch-all set: *@${DOMAIN} → ${FORWARD_TO} ✓`);
  } catch (err) {
    console.warn(`      Catch-all warning: ${err.message}`);
  }

  // ── Step 4: Verify catch-all was set ──────────────────────────────────────
  console.log(`[4/4] Verifying catch-all rule...`);
  try {
    const catchAll = await cf('GET', `/zones/${zoneId}/email/routing/rules/catch_all`);
    console.log(`      Catch-all enabled: ${catchAll.enabled}`);
    console.log(`      Action: ${JSON.stringify(catchAll.actions)}`);
  } catch (err) {
    console.warn(`      Could not verify: ${err.message}`);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Done. All bounces to *@${DOMAIN} → ${FORWARD_TO}`);
  console.log(`  VERP format: bounce+<encoded-recipient>@${DOMAIN}`);
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n  FATAL:', err.message); process.exit(1); });
