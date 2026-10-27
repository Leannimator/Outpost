/* Staff sign-in helpers: authenticator-app codes (TOTP, RFC 6238) and recovery codes.
   Uses only Node's built-in crypto. No outside service or account is involved. */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

// Returns the time step that matched (so a code can't be used twice), or null. Allows one step either side for clock drift.
function checkTotp(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  let hit = null;
  for (const s of [step - 1, step, step + 1]) {
    const a = Buffer.from(hotp(secret, s)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) hit = s;
  }
  return hit;
}

const otpauthUrl = (secret, label, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Recovery codes look like k7m2-qx9d. Only a hash is stored.
const RC_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCodes(n = 8) {
  const pick = () => Array.from(crypto.randomBytes(4), (b) => RC_CHARS[b % RC_CHARS.length]).join('');
  return Array.from({ length: n }, () => pick() + '-' + pick());
}
const normRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (c) => crypto.createHash('sha256').update(normRecovery(c)).digest('hex');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

module.exports = { newSecret, checkTotp, hotp, otpauthUrl, newRecoveryCodes, hashRecovery, hashToken, base32Encode, base32Decode };
