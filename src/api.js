import fetch from 'node-fetch';
import { CookieJar as ToughCookieJar } from 'tough-cookie';
import config from './config.js';

// Wrapper around tough-cookie with helper for CSRF token
export class CookieJar {
  constructor() {
    this.jar = new ToughCookieJar();
    this.lastUrl = config.INCEPTION_BASE;
  }

  async setResponseCookies(response, url) {
    const setCookieHeaders = response.headers.raw?.()['set-cookie'] || [];
    for (const cookie of setCookieHeaders) {
      // Skip cookies that clear an existing important session cookie
      // (some endpoints incorrectly return sessionid="" Max-Age=0)
      if (/^sessionid=("")?\s*;/i.test(cookie) || /sessionid=;/i.test(cookie)) {
        continue;
      }
      try {
        await this.jar.setCookie(cookie, url || this.lastUrl);
      } catch {}
    }
  }

  async getCookieHeader(url) {
    return this.jar.getCookieString(url || this.lastUrl);
  }

  async getCsrfToken(url) {
    const cookies = await this.jar.getCookies(url || this.lastUrl);
    const csrf = cookies.find(c => c.key === 'csrftoken');
    return csrf?.value || null;
  }
}

export class InceptionAPI {
  constructor(cookieJar) {
    this.jar = cookieJar;
    this.base = config.INCEPTION_BASE;
  }

  async fetchCookies() {
    // GET endpoints that set csrftoken cookie
    for (const path of ['/api/auth/wallet/', '/api/']) {
      const url = `${this.base}${path}`;
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': this.base,
            'Referer': `${this.base}/`,
          },
        });
        await this.jar.setResponseCookies(res, url);
        const token = await this.jar.getCsrfToken(url);
        if (token) return token;
      } catch {}
    }
    return null;
  }

  async request(method, endpoint, body, extraHeaders = {}) {
    const url = `${this.base}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': this.base,
      'Referer': `${this.base}/`,
      'Accept': 'application/json',
      ...extraHeaders,
    };

    const cookieHeader = await this.jar.getCookieHeader(url);
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const token = await this.jar.getCsrfToken(url);
      if (token && !headers['X-CSRFToken']) {
        headers['X-CSRFToken'] = token;
      }
    }

    const opts = { method, headers };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      opts.body = JSON.stringify(body);
    }

    const response = await fetch(url, opts);
    await this.jar.setResponseCookies(response, url);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`API ${method} ${endpoint} failed: ${response.status} — ${text.slice(0, 200)}`);
    }

    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      return response.json();
    }
    await response.text().catch(() => '');
    return null;
  }

  get(endpoint) { return this.request('GET', endpoint); }
  post(endpoint, body) { return this.request('POST', endpoint, body); }

  async walletLogin(address, signedMessage, signature) {
    return this.post(config.API_AUTH_WALLET, {
      wallet_address: address,
      message: signedMessage,
      signature,
    });
  }

  async getProfile() { return this.get(config.API_PROFILE); }
  async faucet(walletAddress) { return this.post(config.API_FAUCET, { wallet: walletAddress }); }
  async faucetStatus(walletAddress) { return this.get(config.API_FAUCET_STATUS.replace('${B}', walletAddress)); }
  async faucetHistory() { return this.get(config.API_FAUCET_HISTORY); }
  async openCrate(count = config.DEFAULT_CRATE_COUNT) { return this.post(config.API_CRATE_OPEN, { count }); }
  async crateHistory() { return this.get(config.API_CRATE_HISTORY); }
  async confirmBurn(params) { return this.post(config.API_EXCHANGE_BURN, params); }
  async confirmStake(params) { return this.post(config.API_EXCHANGE_STAKE, params); }
  async exchangeHistory() { return this.get(config.API_EXCHANGE_HISTORY); }
  async claimBadge() { return this.post(config.API_BADGE_CLAIM, {}); }
  async sync() { return this.post(config.API_SYNC, {}); }
  async getTasks() { return this.get(config.API_TASK); }
  async getQeHistory() { return this.get(config.API_QE_HISTORY); }
  async leaderboard() { return this.get(config.API_LEADERBOARD); }
}
