'use strict';

const crypto = require('crypto');
const ALGO   = 'aes-256-gcm';

function getKey() {
  const hex = process.env.AES_256_KEY;
  if (!hex || hex.startsWith('CHANGE_ME') || hex.length !== 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AES_256_KEY must be a 64-character hex string. Generate: openssl rand -hex 32');
    }
    // Dev-only deterministic key — logs a warning but never crashes startup
    console.warn('[ENCRYPTION] WARNING: Using dev AES key. Set AES_256_KEY before deploying.');
    return Buffer.alloc(32, 0);
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key    = getKey();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  try {
    const [ivHex, tagHex, ctHex] = stored.split(':');
    const key     = getKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

/** Encrypt a file's bytes: [12-byte IV][16-byte tag][ciphertext]. */
function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decryptBuffer(buf) {
  const decipher = crypto.createDecipheriv(ALGO, getKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

module.exports = { encrypt, decrypt, encryptBuffer, decryptBuffer };
