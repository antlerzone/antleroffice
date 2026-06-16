// AES-256-GCM encryption for locally stored secrets (passwords, cookies, OTP).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('./store');

const PREFIX = 'enc:v1:';

function resolveMasterKey() {
  const envKey = process.env.ANTLEROFFICE_SECRET_KEY;
  if (envKey && String(envKey).trim()) {
    return crypto.createHash('sha256').update(String(envKey).trim()).digest();
  }

  const keyPath = path.join(getDataDir(), '.master-key');
  try {
    if (fs.existsSync(keyPath)) {
      const raw = fs.readFileSync(keyPath);
      if (raw.length >= 32) return raw.subarray(0, 32);
    }
  } catch {
    /* fall through to generate */
  }

  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key);
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort */
  }
  return key;
}

function encrypt(plaintext) {
  const text = String(plaintext ?? '');
  if (!text) return '';
  const key = resolveMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

function decrypt(ciphertext) {
  const raw = String(ciphertext ?? '');
  if (!raw) return '';
  if (!raw.startsWith(PREFIX)) return raw;
  const parts = raw.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted field');
  const [ivB64, tagB64, dataB64] = parts;
  const key = resolveMasterKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted, PREFIX };
