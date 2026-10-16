import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Cookie, Store } from 'tough-cookie';
import { app } from 'electron';
import { defaultLogger as logger } from './utils/logger';
import { PRODUCT_NAME } from './cobuilding/shared/product';

/**
 * Encrypted cookie store that uses AES-256-GCM encryption
 * to encrypt cookies at rest, preventing credential theft if the system is compromised.
 *
 * Uses a machine-specific encryption key derived from a persistent UUID.
 * Implements the tough-cookie Store interface for seamless integration.
 */
export class EncryptedCookieStore extends Store {
  private filePath: string;
  private idx: { [domain: string]: { [path: string]: { [key: string]: Cookie } } } = {};
  private encryptionKey: Buffer;

  constructor(filePath: string) {
    super();
    this.synchronous = true;
    this.filePath = filePath;
    this.encryptionKey = this.deriveEncryptionKey();
    this.loadFromFile();
  }

  /**
   * Derive a machine-specific encryption key from a persistent UUID.
   * This provides consistent encryption across app restarts while being
   * unique to each machine installation.
   */
  private deriveEncryptionKey(): Buffer {
    try {
      const machineId = this.getOrCreateMachineId();
      const password = machineId;
      const env = app.isPackaged ? 'production' : 'development';
      const salt = crypto.createHash('sha256').update(`${PRODUCT_NAME}-cookie-store:${env}`).digest();
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      return key;
    } catch (error) {
      logger.error('[EncryptedCookieStore] Error deriving encryption key:', error);
      // No usable key — cookies cannot be encrypted/decrypted
      // Return a random key so encrypt/decrypt calls fail gracefully
      return crypto.randomBytes(32);
    }
  }

  /**
   * Get or create a persistent machine identifier.
   * Uses a UUID stored in the userData directory for stable identification
   * across app restarts, regardless of network configuration changes.
   */
  private getOrCreateMachineId(): string {
    try {
      const machineIdPath = path.join(app.getPath('userData'), '.machine-id');

      // Try to read existing machine ID
      if (fs.existsSync(machineIdPath)) {
        const existingId = fs.readFileSync(machineIdPath, 'utf8').trim();
        if (existingId && existingId.length > 0) {
          return existingId;
        }
      }

      // Generate new UUID if file doesn't exist or is invalid
      const newId = crypto.randomUUID();

      // Ensure directory exists
      const dir = path.dirname(machineIdPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Save the new ID
      fs.writeFileSync(machineIdPath, newId, 'utf8');

      return newId;
    } catch (error) {
      logger.error('[EncryptedCookieStore] Error managing machine ID:', error);
      // Fallback to a random ID if file operations fail
      return `fallback-${crypto.randomUUID()}`;
    }
  }

  /**
   * Encrypt data using AES-256-GCM.
   * Returns encrypted data with IV prepended.
   */
  private encrypt(plaintext: string): Buffer {
    try {
      // Generate a random IV for each encryption (96 bits / 12 bytes for GCM)
      const iv = crypto.randomBytes(12);

      // Create cipher
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

      // Encrypt the data
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      // Get the authentication tag
      const authTag = cipher.getAuthTag();

      // Return: IV (12 bytes) + Auth Tag (16 bytes) + Encrypted Data
      return Buffer.concat([iv, authTag, encrypted]);
    } catch (error) {
      logger.error('[EncryptedCookieStore] Encryption error:', error);
      throw error;
    }
  }

  /**
   * Decrypt data using AES-256-GCM.
   * Expects data with IV prepended.
   */
  private decrypt(encryptedData: Buffer): string {
    try {
      // Extract IV (first 12 bytes)
      const iv = encryptedData.subarray(0, 12);

      // Extract auth tag (next 16 bytes)
      const authTag = encryptedData.subarray(12, 28);

      // Extract encrypted content (remaining bytes)
      const encrypted = encryptedData.subarray(28);

      // Create decipher
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Decrypt the data
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error) {
      logger.error('[EncryptedCookieStore] Decryption error:', error);
      throw error;
    }
  }

  /**
   * Load and decrypt cookies from disk
   */
  private loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const encryptedData = fs.readFileSync(this.filePath);

      // Check if this looks like encrypted data (has minimum size)
      if (encryptedData.length < 28) {
        logger.warn('[EncryptedCookieStore] Cookie file too small to be valid, starting with empty store');
        this.idx = {};
        return;
      }

      const decryptedData = this.decrypt(encryptedData);
      const parsed = JSON.parse(decryptedData);
      this.idx = this.deserializeCookies(parsed);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('unable to authenticate data') || errorMessage.includes('Unsupported state')) {
        logger.warn('[EncryptedCookieStore] Cookie decryption failed - encryption key mismatch');
      } else {
        logger.error('[EncryptedCookieStore] Unexpected error loading cookies:', error);
      }

      // Start with empty store if we can't load
      this.idx = {};
    }
  }

  /**
   * Convert plain objects to Cookie instances
   */
  private deserializeCookies(data: any): { [domain: string]: { [path: string]: { [key: string]: Cookie } } } {
    const result: { [domain: string]: { [path: string]: { [key: string]: Cookie } } } = {};

    for (const domain in data) {
      result[domain] = {};
      for (const path in data[domain]) {
        result[domain][path] = {};
        for (const key in data[domain][path]) {
          try {
            const cookie = Cookie.fromJSON(data[domain][path][key]);
            if (cookie) {
              result[domain][path][key] = cookie;
            }
          } catch (e) {
            logger.error('[EncryptedCookieStore] Failed to deserialize cookie:', e);
          }
        }
      }
    }

    return result;
  }

  /**
   * Encrypt and save cookies to disk
   */
  private saveToFile(): void {
    try {
      const jsonData = JSON.stringify(this.idx, null, 2);

      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Encrypt the data
      const encryptedData = this.encrypt(jsonData);

      // Write encrypted data to file
      fs.writeFileSync(this.filePath, encryptedData);
    } catch (error) {
      logger.error('[EncryptedCookieStore] Error saving cookies:', error);
    }
  }

  findCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback: (err: Error | null, cookie: Cookie | undefined) => void
  ): void;
  findCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined
  ): Promise<Cookie | undefined>;
  findCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback?: (err: Error | null, cookie: Cookie | undefined) => void
  ): Promise<Cookie | undefined> | void {
    const doFind = () => {
      if (!domain || !path || !key) {
        return undefined;
      }
      return this.idx[domain]?.[path]?.[key];
    };

    if (callback) {
      try {
        const cookie = doFind();
        callback(null, cookie);
      } catch (error) {
        callback(error as Error, undefined);
      }
      return;
    }

    return Promise.resolve(doFind());
  }

  findCookies(
    domain: string | null | undefined,
    path: string | null | undefined,
    allowSpecialUseDomain?: boolean,
    callback?: (err: Error | null, cookies: Cookie[]) => void
  ): void;
  findCookies(
    domain: string | null | undefined,
    path: string | null | undefined,
    allowSpecialUseDomain?: boolean
  ): Promise<Cookie[]>;
  findCookies(
    domain: string | null | undefined,
    path: string | null | undefined,
    allowSpecialUseDomain?: boolean,
    callback?: (err: Error | null, cookies: Cookie[]) => void
  ): Promise<Cookie[]> | void {
    const doFind = (): Cookie[] => {
      const results: Cookie[] = [];

      if (!domain) {
        return [];
      }

      const domainKeys = Object.keys(this.idx);
      for (const domainKey of domainKeys) {
        if (domainKey === domain || domainKey.endsWith('.' + domain) || domain.endsWith('.' + domainKey)) {
          const paths = this.idx[domainKey];

          const pathKeys = Object.keys(paths);
          for (const pathKey of pathKeys) {
            if (!path || pathKey === path || path.startsWith(pathKey)) {
              const cookies = paths[pathKey];
              results.push(...Object.values(cookies));
            }
          }
        }
      }

      return results;
    };

    if (callback) {
      try {
        const cookies = doFind();
        callback(null, cookies);
      } catch (error) {
        callback(error as Error, []);
      }
      return;
    }

    return Promise.resolve(doFind());
  }

  putCookie(cookie: Cookie, callback: (err: Error | null) => void): void;
  putCookie(cookie: Cookie): Promise<void>;
  putCookie(cookie: Cookie, callback?: (err: Error | null) => void): Promise<void> | void {
    const doPut = () => {
      const domain = cookie.domain;
      const path = cookie.path;
      const key = cookie.key;

      if (!domain || !path || !key) {
        throw new Error('Cookie must have domain, path, and key');
      }

      if (!this.idx[domain]) {
        this.idx[domain] = {};
      }
      if (!this.idx[domain][path]) {
        this.idx[domain][path] = {};
      }

      this.idx[domain][path][key] = cookie;
      this.saveToFile();
    };

    if (callback) {
      try {
        doPut();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doPut);
  }

  updateCookie(oldCookie: Cookie, newCookie: Cookie, callback: (err: Error | null) => void): void;
  updateCookie(oldCookie: Cookie, newCookie: Cookie): Promise<void>;
  updateCookie(oldCookie: Cookie, newCookie: Cookie, callback?: (err: Error | null) => void): Promise<void> | void {
    if (callback) {
      this.putCookie(newCookie, callback);
      return;
    }
    return this.putCookie(newCookie);
  }

  removeCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback: (err: Error | null) => void
  ): void;
  removeCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined
  ): Promise<void>;
  removeCookie(
    domain: string | null | undefined,
    path: string | null | undefined,
    key: string | null | undefined,
    callback?: (err: Error | null) => void
  ): Promise<void> | void {
    const doRemove = () => {
      if (!domain || !path || !key) {
        return;
      }

      if (this.idx[domain]?.[path]?.[key]) {
        delete this.idx[domain][path][key];

        if (Object.keys(this.idx[domain][path]).length === 0) {
          delete this.idx[domain][path];
        }
        if (Object.keys(this.idx[domain]).length === 0) {
          delete this.idx[domain];
        }

        this.saveToFile();
      }
    };

    if (callback) {
      try {
        doRemove();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doRemove);
  }

  removeCookies(domain: string, path: string | null | undefined, callback: (err: Error | null) => void): void;
  removeCookies(domain: string, path: string | null | undefined): Promise<void>;
  removeCookies(domain: string, path: string | null | undefined, callback?: (err: Error | null) => void): Promise<void> | void {
    const doRemove = () => {
      if (!path) {
        return;
      }

      if (this.idx[domain]?.[path]) {
        delete this.idx[domain][path];

        if (Object.keys(this.idx[domain]).length === 0) {
          delete this.idx[domain];
        }

        this.saveToFile();
      }
    };

    if (callback) {
      try {
        doRemove();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doRemove);
  }

  removeAllCookies(callback: (err: Error | null) => void): void;
  removeAllCookies(): Promise<void>;
  removeAllCookies(callback?: (err: Error | null) => void): Promise<void> | void {
    const doRemove = () => {
      this.idx = {};
      this.saveToFile();
    };

    if (callback) {
      try {
        doRemove();
        callback(null);
      } catch (error) {
        callback(error as Error);
      }
      return;
    }

    return Promise.resolve().then(doRemove);
  }

  getAllCookies(callback: (err: Error | null, cookies: Cookie[]) => void): void;
  getAllCookies(): Promise<Cookie[]>;
  getAllCookies(callback?: (err: Error | null, cookies: Cookie[]) => void): Promise<Cookie[]> | void {
    const doGetAll = (): Cookie[] => {
      const results: Cookie[] = [];

      for (const domain of Object.keys(this.idx)) {
        for (const path of Object.keys(this.idx[domain])) {
          results.push(...Object.values(this.idx[domain][path]));
        }
      }

      return results;
    };

    if (callback) {
      try {
        const cookies = doGetAll();
        callback(null, cookies);
      } catch (error) {
        callback(error as Error, []);
      }
      return;
    }

    return Promise.resolve(doGetAll());
  }
}
