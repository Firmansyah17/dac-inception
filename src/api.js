import config from './config.js';

// Cookie jar for session persistence
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setCookieString(raw) {
    // Parse set-cookie header
    if (!raw) return;
    const parts = raw.split(';');
    const nameValue = parts[0].trim().split('=');
    if (nameValue.length >= 2) {
      this.cookies.set(nameValue[0], nameValue.slice(1).join('='));
    }
  }

  getCookieHeader() {
    const pairs = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`);
    return pairs.join('; ') || undefined;
  }

  async setResponseCookies(response) {
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      // Could be multiple cookies
      const cookies = setCookie.split(/,\s*(?=\w+=)/);
      cookies.forEach(c => {
        const parts = c.split(';');
        const nameValue = parts[0].trim().split('=');
        if (nameValue.length >= 2) {
          this.cookies.set(nameValue[0], nameValue.slice(1).join('='));
        }
      });
    }
  }
}

// Simple authenticated API client using cookies
export class InceptionAPI {
  constructor(cookieJar) {
    this.jar = cookieJar;
    this.base = config.INCEPTION_BASE;
  }

  async request(method, endpoint, body, extraHeaders = {}) {
    const url = `${this.base}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': this.base,
      'Referer': `${this.base}/`,
      ...extraHeaders,
    };

    const cookieHeader = this.jar.getCookieHeader();
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    const opts = {
      method,
      headers,
      credentials: 'include',
    };

    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      opts.body = JSON.stringify(body);
    }

    const response = await fetch(url, opts);
    await this.jar.setResponseCookies(response);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${method} ${endpoint} failed: ${response.status} — ${text.slice(0, 200)}`);
    }

    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  get(endpoint) { return this.request('GET', endpoint); }
  post(endpoint, body) { return this.request('POST', endpoint, body); }

  // --- Auth flow: sign a message to authenticate ---
  // Wallet sign-in: first get a nonce, then sign and POST
  async walletLogin(address, signedMessage, signature) {
    return this.post(config.API_AUTH_WALLET, {
      address,
      message: signedMessage,
      signature,
    });
  }

  // --- Core endpoints ---
  async getProfile() {
    return this.get(config.API_PROFILE);
  }

  async faucet(walletAddress) {
    return this.post(config.API_FAUCET, { wallet: walletAddress });
  }

  async faucetStatus(walletAddress) {
    return this.get(config.API_FAUCET_STATUS.replace('${B}', walletAddress));
  }

  async faucetHistory() {
    return this.get(config.API_FAUCET_HISTORY);
  }

  async openCrate(count = config.DEFAULT_CRATE_COUNT) {
    return this.post(config.API_CRATE_OPEN, { count });
  }

  async crateHistory() {
    return this.get(config.API_CRATE_HISTORY);
  }

  async confirmBurn(params) {
    return this.post(config.API_EXCHANGE_BURN, params);
  }

  async confirmStake(params) {
    return this.post(config.API_EXCHANGE_STAKE, params);
  }

  async exchangeHistory() {
    return this.get(config.API_EXCHANGE_HISTORY);
  }

  async claimBadge() {
    return this.post(config.API_BADGE_CLAIM, {});
  }

  async sync() {
    return this.post(config.API_SYNC, {});
  }

  async getTasks() {
    return this.get(config.API_TASK);
  }

  async getQeHistory() {
    return this.get(config.API_QE_HISTORY);
  }

  async leaderboard() {
    return this.get(config.API_LEADERBOARD);
  }
}
