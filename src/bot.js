import { Account } from './wallet.js';
import { CookieJar, InceptionAPI } from './api.js';
import config from './config.js';

const logger = {
  info: (acctId, msg) => console.log(`[${new Date().toISOString()}] [Account ${acctId}] ${msg}`),
  error: (acctId, msg) => console.error(`[${new Date().toISOString()}] [Account ${acctId}] ERROR: ${msg}`),
  success: (acctId, msg) => console.log(`[${new Date().toISOString()}] [Account ${acctId}] ✅ ${msg}`),
  warn: (acctId, msg) => console.warn(`[${new Date().toISOString()}] [Account ${acctId}] ⚠️ ${msg}`),
};

// Delay helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 2000, max = 5000) =>
  sleep(Math.floor(Math.random() * (max - min)) + min);

export class DACBot {
  constructor(account, cookieJar) {
    this.account = account;
    this.api = new InceptionAPI(cookieJar);
    this.id = account.id;
    // State tracking
    this.state = {
      lastFaucet: null,
      lastCrate: null,
      lastBurn: null,
      lastStake: null,
      runs: 0,
      errors: 0,
    };
  }

  // Run full cycle: faucet → open crates → burn → stake
  async runCycle(opts = {}) {
    const {
      doFaucet = true,
      crateCount = config.DEFAULT_CRATE_COUNT,
      doBurn = false,
      doStake = false,
      burnAmount = '0',
      stakeAmount = '0',
    } = opts;

    this.state.runs++;
    logger.info(this.id, `Starting cycle #${this.state.runs}`);

    // 1. Sync session
    await this.syncSession();
    await randomDelay();

    // 2. Faucet
    if (doFaucet) {
      await this.doFaucet();
      await randomDelay();
    }

    // 3. Open Quantum Crates
    await this.doOpenCrates(crateCount);
    await randomDelay();

    // 4. Burn DACC → QE (if enabled)
    if (doBurn) {
      await this.doBurn(burnAmount);
      await randomDelay();
    }

    // 5. Stake (if enabled)
    if (doStake) {
      await this.doStake(stakeAmount);
      await randomDelay();
    }

    // 6. Report
    await this.reportStatus();

    logger.success(this.id, `Cycle #${this.state.runs} complete`);
  }

  async syncSession() {
    try {
      logger.info(this.id, 'Syncing session...');
      const result = await this.api.sync();
      logger.info(this.id, `Session synced: ${JSON.stringify(result).slice(0, 100)}`);
      return result;
    } catch (err) {
      logger.warn(this.id, `Sync failed: ${err.message}`);
      throw err;
    }
  }

  async doFaucet() {
    try {
      logger.info(this.id, `Requesting faucet for ${this.account.address}...`);
      const status = await this.api.faucetStatus(this.account.address);
      
      // Check if faucet is available
      if (status && status.status === 'available') {
        const result = await this.api.faucet(this.account.address);
        logger.success(this.id, `Faucet claimed: ${JSON.stringify(result).slice(0, 100)}`);
        this.state.lastFaucet = Date.now();
        return result;
      } else {
        logger.info(this.id, `Faucet not available yet. Status: ${JSON.stringify(status).slice(0, 100)}`);
        return status;
      }
    } catch (err) {
      logger.error(this.id, `Faucet failed: ${err.message}`);
      this.state.errors++;
      return null;
    }
  }

  async doOpenCrates(count = config.DEFAULT_CRATE_COUNT) {
    try {
      logger.info(this.id, `Opening ${count} Quantum Crates...`);
      const result = await this.api.openCrate(count);
      logger.success(this.id, `Crates opened: ${JSON.stringify(result).slice(0, 200)}`);
      this.state.lastCrate = Date.now();
      return result;
    } catch (err) {
      logger.error(this.id, `Open crate failed: ${err.message}`);
      this.state.errors++;
      return null;
    }
  }

  async doBurn(amount = '0') {
    try {
      logger.info(this.id, `Burning DACC → QE (amount: ${amount})...`);
      const result = await this.api.confirmBurn({ amount });
      logger.success(this.id, `Burn confirmed: ${JSON.stringify(result).slice(0, 200)}`);
      this.state.lastBurn = Date.now();
      return result;
    } catch (err) {
      logger.error(this.id, `Burn failed: ${err.message}`);
      this.state.errors++;
      return null;
    }
  }

  async doStake(amount = '0') {
    try {
      logger.info(this.id, `Staking DACC (amount: ${amount})...`);
      const result = await this.api.confirmStake({ amount });
      logger.success(this.id, `Stake confirmed: ${JSON.stringify(result).slice(0, 200)}`);
      this.state.lastStake = Date.now();
      return result;
    } catch (err) {
      logger.error(this.id, `Stake failed: ${err.message}`);
      this.state.errors++;
      return null;
    }
  }

  async reportStatus() {
    try {
      const profile = await this.api.getProfile();
      logger.info(this.id, `Profile: ${JSON.stringify(profile).slice(0, 300)}`);
      return profile;
    } catch (err) {
      logger.warn(this.id, `Profile fetch failed: ${err.message}`);
      return null;
    }
  }
}
