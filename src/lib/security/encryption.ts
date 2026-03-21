/**
 * Encryption utilities for sensitive data storage
 * Uses AES-256-GCM for authenticated encryption
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key from environment
 * Must be a 32-byte (256-bit) key encoded as base64
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }

  // Key should be base64-encoded 32-byte key
  const keyBuffer = Buffer.from(key, "base64");
  if (keyBuffer.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte key encoded as base64");
  }

  return keyBuffer;
}

/**
 * Encrypt a string value
 * Returns format: iv:authTag:ciphertext (all base64)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");

  const authTag = cipher.getAuthTag();

  // Return iv:authTag:ciphertext format
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
}

/**
 * Decrypt a string value
 * Expects format: iv:authTag:ciphertext (all base64)
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();

  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }

  const [ivBase64, authTagBase64, encrypted] = parts;
  const iv = Buffer.from(ivBase64, "base64");
  const authTag = Buffer.from(authTagBase64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid IV length");
  }

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid auth tag length");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Check if a value appears to be encrypted (has iv:authTag:ciphertext format)
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(":");
  if (parts.length !== 3) return false;

  try {
    const iv = Buffer.from(parts[0], "base64");
    const authTag = Buffer.from(parts[1], "base64");
    return iv.length === IV_LENGTH && authTag.length === AUTH_TAG_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Safely encrypt - throws error if encryption fails
 * For production use - encryption failures should not silently store plaintext
 */
export function safeEncrypt(plaintext: string): string {
  try {
    return encrypt(plaintext);
  } catch (error) {
    // Log and rethrow - we should never silently store plaintext
    console.error("Encryption failed:", error);
    throw new Error("Failed to encrypt sensitive data");
  }
}

/**
 * Safely decrypt - returns original if decryption fails
 * Handles both encrypted and unencrypted values (for migration)
 */
export function safeDecrypt(value: string): string | null {
  if (!value) return value || null;

  // If not encrypted (legacy), return as-is
  if (!isEncrypted(value)) {
    return value;
  }

  try {
    return decrypt(value);
  } catch (error) {
    console.error("Decryption failed:", error);
    return null;
  }
}

/**
 * Generate a new encryption key (for setup)
 * Returns base64-encoded 32-byte key
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("base64");
}
