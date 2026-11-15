'use strict';
/**
 * Authentication and Credential Management Module.
 * - Argon2id password hashing and verification (with scrypt fallback).
 * - Automatic unique login generation in transliterated Ukrainian format (ivanenko.ip).
 * - Secure temporary password generation.
 * - Password complexity validation.
 */

const crypto = require('crypto');
let argon2 = null;
try {
  argon2 = require('argon2');
} catch (e) {
  // Argon2 fallback to scrypt if native binary unavailable
}

// ───────────────────────── Транслітерація (Українська → Латиниця) ─────────────────────────

const CYR_TO_LAT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'g', 'д': 'd', 'е': 'e', 'є': 'ye',
  'ж': 'zh', 'з': 'z', 'и': 'y', 'і': 'i', 'ї': 'yi', 'й': 'y', 'к': 'k', 'л': 'l',
  'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ь': '', 'ю': 'yu',
  'я': 'ya', '’': '', '\'': '', '`': ''
};

function transliterate(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .split('')
    .map((ch) => (CYR_TO_LAT[ch] !== undefined ? CYR_TO_LAT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Генерує унікальний логін виду ivanenko.ii або ivanenko.ip
 * Якщо такий логін уже зайнятий, додає числовий суфікс: ivanenko.ii2
 */
function generateLogin(fullName, isTakenFn) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'student.' + crypto.randomBytes(3).toString('hex');

  const lastName = transliterate(parts[0]) || 'student';
  const firstInitial = parts.length > 1 ? transliterate(parts[1][0]) : 'i';
  const patrInitial = parts.length > 2 ? transliterate(parts[2][0]) : '';

  const baseLogin = `${lastName}.${firstInitial}${patrInitial}`.toLowerCase();
  let candidate = baseLogin;
  let counter = 2;

  if (typeof isTakenFn === 'function') {
    while (isTakenFn(candidate)) {
      candidate = `${baseLogin}${counter}`;
      counter++;
    }
  }
  return candidate;
}

// ───────────────────────── Тимчасовий пароль ─────────────────────────

const CHARS_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHARS_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const CHARS_DIGITS = '23456789';
const CHARS_SPECIAL = '!@#$%^&*';
const ALL_CHARS = CHARS_UPPER + CHARS_LOWER + CHARS_DIGITS + CHARS_SPECIAL;

/**
 * Генерує надійний криптографічно стійкий випадковий пароль (довжиною 10 символів).
 */
function generateTempPassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  const res = [];
  // Гарантуємо наявність хоча б однієї великої, малої літери, цифри та спецсимволу
  res.push(CHARS_UPPER[crypto.randomInt(CHARS_UPPER.length)]);
  res.push(CHARS_LOWER[crypto.randomInt(CHARS_LOWER.length)]);
  res.push(CHARS_DIGITS[crypto.randomInt(CHARS_DIGITS.length)]);
  res.push(CHARS_SPECIAL[crypto.randomInt(CHARS_SPECIAL.length)]);

  for (let i = 4; i < length; i++) {
    res.push(ALL_CHARS[bytes[i] % ALL_CHARS.length]);
  }
  // Перемішуємо символи (Fisher-Yates)
  for (let i = res.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const temp = res[i];
    res[i] = res[j];
    res[j] = temp;
  }
  return res.join('');
}

// ───────────────────────── Хешування Argon2id / Scrypt ─────────────────────────

async function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Пароль має бути непорожнім рядком.');
  }
  if (argon2) {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 2,
    });
  }
  // Fallback: scrypt з 16-байтним salt
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  try {
    if (String(hash).startsWith('$argon2')) {
      if (!argon2) throw new Error('Argon2 binary is not available');
      return await argon2.verify(hash, password);
    }
    if (String(hash).startsWith('scrypt$')) {
      const parts = hash.split('$');
      if (parts.length !== 3) return false;
      const [, salt, originalHex] = parts;
      return new Promise((resolve) => {
        crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
          if (err) return resolve(false);
          const origBuf = Buffer.from(originalHex, 'hex');
          resolve(origBuf.length === derivedKey.length && crypto.timingSafeEqual(origBuf, derivedKey));
        });
      });
    }
    return false;
  } catch (e) {
    return false;
  }
}

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    return { ok: false, error: 'Введіть пароль.' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Пароль має містити щонайменше 8 символів.' };
  }
  if (!/[a-zA-Zа-яА-ЯіїєґІЇЄҐ]/.test(password)) {
    return { ok: false, error: 'Пароль має містити принаймні одну літеру.' };
  }
  if (!/\d/.test(password)) {
    return { ok: false, error: 'Пароль має містити принаймні одну цифру.' };
  }
  return { ok: true };
}

module.exports = {
  transliterate,
  generateLogin,
  generateTempPassword,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
};
