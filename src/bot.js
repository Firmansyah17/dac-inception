import { ethers } from 'ethers';
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

// DACC contract on-chain info (from RPC inspection)
const DACC_CONTRACT = '0x3691a78be270db1f3b1a86177a8f23f89a8cef24';
const BURN_SELECTOR  = '0x4a5d094b';
const STAKE_SELECTOR = '0x3a4b66f1';
const TX_VALUE       = '0.1';
const MIN_BALANCE    = '0.12';

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
      return null;
    }
  }

  async doFaucet() {
    try {
      logger.info(this.id, `Requesting faucet for ${this.account.address}...`);

      // Probe status (informational only — don't gate on it; many server shapes)
      let status = null;
      try {
        status = await this.api.faucetStatus(this.account.address);
        logger.info(this.id, `Faucet status: ${JSON.stringify(status).slice(0, 200)}`);
      } catch (e) {
        logger.info(this.id, `Faucet status probe failed (continuing): ${e.message.slice(0, 100)}`);
      }

      // Always attempt the claim; server is source of truth for cooldown
      try {
        const result = await this.api.faucet(this.account.address);
        logger.success(this.id, `Faucet claimed: ${JSON.stringify(result).slice(0, 200)}`);
        this.state.lastFaucet = Date.now();
        return result;
      } catch (err) {
        const m = err.message.toLowerCase();
        if (m.includes('already') || m.includes('cooldown') || m.includes('wait') ||
            m.includes('too soon') || m.includes('claimed') || m.includes('429')) {
          logger.info(this.id, `Faucet on cooldown — skipping (${err.message.slice(0, 120)})`);
          return null;
        }
        throw err;
      }
    } catch (err) {
      logger.error(this.id, `Faucet failed: ${err.message.slice(0, 200)}`);
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
      if (err.message.includes('daily limit') || err.message.includes('Maximum') || err.message.includes('already')) {
        logger.info(this.id, `Crates daily limit reached (${count}/${count}) — skip`);
      } else {
        logger.error(this.id, `Open crate failed: ${err.message}`);
        this.state.errors++;
      }
      return null;
    }
  }

  async doBurn(amount = '0.1') {
    try {
      logger.info(this.id, `Burning DACC → QE...`);
      const provider = new ethers.JsonRpcProvider(config.RPC_URL);
      const signer = this.account.wallet.connect(provider);
      // Balance check
      const balance = await provider.getBalance(this.account.address);
      if (balance < ethers.parseEther(MIN_BALANCE)) {
        logger.warn(this.id, `Burn skipped: low balance ${ethers.formatEther(balance)} DACC`);
        return null;
      }
      const tx = await signer.sendTransaction({
        to: DACC_CONTRACT,
        data: BURN_SELECTOR,
        value: ethers.parseEther(TX_VALUE),
      });
      logger.info(this.id, `Burn tx: ${tx.hash}`);
      await tx.wait();
      const result = await this.api.confirmBurn({ tx_hash: tx.hash });
      logger.success(this.id, `Burn confirmed: ${JSON.stringify(result).slice(0, 100)}`);
      this.state.lastBurn = Date.now();
      return result;
    } catch (err) {
      logger.error(this.id, `Burn failed: ${err.message}`);
      this.state.errors++;
      return null;
    }
  }

  async doStake(amount = '0.1') {
    try {
      logger.info(this.id, `Staking DACC...`);
      const provider = new ethers.JsonRpcProvider(config.RPC_URL);
      const signer = this.account.wallet.connect(provider);
      // Balance check
      const balance = await provider.getBalance(this.account.address);
      if (balance < ethers.parseEther(MIN_BALANCE)) {
        logger.warn(this.id, `Stake skipped: low balance ${ethers.formatEther(balance)} DACC`);
        return null;
      }
      const tx = await signer.sendTransaction({
        to: DACC_CONTRACT,
        data: STAKE_SELECTOR,
        value: ethers.parseEther(TX_VALUE),
      });
      logger.info(this.id, `Stake tx: ${tx.hash}`);
      const receipt = await tx.wait();
      if (receipt.status === 0) {
        logger.warn(this.id, `Stake reverted — daily limit reached, skipping`);
        return null;
      }
      const result = await this.api.confirmStake({ tx_hash: tx.hash });
      logger.success(this.id, `Stake confirmed: ${JSON.stringify(result).slice(0, 100)}`);
      this.state.lastStake = Date.now();
      return result;
    } catch (err) {
      if (err.code === 'CALL_EXCEPTION') {
        logger.warn(this.id, `Stake reverted — daily limit or cooldown, skipping`);
        return null;
      }
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
