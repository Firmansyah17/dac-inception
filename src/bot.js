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

    // Re-sync after faucet to pick up faucet credits
    if (doFaucet) {
      await sleep(5000);
      await this.syncSession();
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
    let claimed = 0;
    for (let i = 0; i < count; i++) {
      try {
        logger.info(this.id, `Opening crate ${i + 1}/${count}...`);
        const result = await this.api.openCrate(1);
        const reward = result?.reward?.label || JSON.stringify(result).slice(0, 80);
        logger.success(this.id, `Crate ${i + 1}: ${reward}`);
        claimed++;
        await randomDelay(1000, 3000);
      } catch (err) {
        const m = err.message.toLowerCase();
        if (m.includes('daily limit') || m.includes('maximum') || m.includes('already')) {
          logger.info(this.id, `Open crate ${i + 1}: daily limit reached — stopping crate opens`);
          break;
        }
        logger.error(this.id, `Open crate ${i + 1} failed: ${err.message.slice(0, 120)}`);
        this.state.errors++;
      }
    }
    this.state.lastCrate = Date.now();
    return { claimed, total: count };
  }

  async doBurn(amount = '0') {
    const targetConfirmed = 3;
    const maxAttempts = 20;
    let confirmed = 0;
    let attempts = 0;

    let provider;
    try {
      provider = new ethers.JsonRpcProvider(config.RPC_URL);
      await provider.getBlockNumber();
    } catch (rpcErr) {
      logger.error(this.id, `RPC unavailable — skipping burn (${rpcErr.message.slice(0, 100)})`);
      this.state.lastBurn = Date.now();
      return { confirmed, target: targetConfirmed, attempts: 0, rpcDown: true };
    }

    while (confirmed < targetConfirmed && attempts < maxAttempts) {
      attempts++;
      try {
        logger.info(this.id, `Burn attempt ${attempts}/${maxAttempts} (${confirmed}/${targetConfirmed} confirmed)...`);
        const signer = this.account.wallet.connect(provider);
        const balance = await provider.getBalance(this.account.address);
        if (balance < ethers.parseEther(MIN_BALANCE)) {
          logger.warn(this.id, `Burn stopped: low balance ${ethers.formatEther(balance)} ETH`);
          break;
        }
        const tx = await signer.sendTransaction({
          to: DACC_CONTRACT,
          data: BURN_SELECTOR,
          value: ethers.parseEther(TX_VALUE),
        });
        logger.info(this.id, `Burn tx: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 0) {
          logger.warn(this.id, `Burn tx reverted — likely daily/cool-down limit. Stopping burn loop.`);
          break; // revert after 1+ success means limit hit; stop gracefully
        }
        // Wait for API to index the tx
        await sleep(8000);
        let confirmOk = false;
        for (let retry = 0; retry < 3; retry++) {
          try {
            const result = await this.api.confirmBurn({ tx_hash: tx.hash });
            confirmed++;
            logger.success(this.id, `Burn ${confirmed}/${targetConfirmed} confirmed: ${JSON.stringify(result).slice(0, 100)}`);
            confirmOk = true;
            break;
          } catch (e) {
            if (retry < 2) {
              logger.info(this.id, `Burn confirm retry ${retry + 1}/3... (${e.message.slice(0, 60)})`);
              await sleep(2000);
            } else {
              logger.error(this.id, `Burn confirm failed: ${e.message.slice(0, 150)}`);
              this.state.errors++;
            }
          }
        }
        if (!confirmOk) {
          logger.warn(this.id, `Burn tx on-chain but API confirm failed — does not count toward target`);
        }
        await randomDelay(2000, 4000);
      } catch (err) {
        if (err.code === 'CALL_EXCEPTION') {
          logger.warn(this.id, `Burn tx reverted (CALL_EXCEPTION) — likely daily/cool-down limit. Stopping.`);
          break;
        }
        logger.error(this.id, `Burn attempt ${attempts}: ${err.message.slice(0, 200)}`);
        this.state.errors++;
        await sleep(2000);
      }
    }

    if (confirmed >= targetConfirmed) {
      logger.success(this.id, `Burn target reached: ${confirmed}/${targetConfirmed} confirmed`);
    } else {
      logger.warn(this.id, `Burn session ended: ${confirmed}/${targetConfirmed} confirmed (${attempts} attempts, max ${maxAttempts})`);
    }
    this.state.lastBurn = Date.now();
    return { confirmed, target: targetConfirmed, attempts };
  }

  async doStake(amount = '0') {
    const targetConfirmed = 5;
    const maxAttempts = 20;
    let confirmed = 0;
    let attempts = 0;

    let provider;
    try {
      provider = new ethers.JsonRpcProvider(config.RPC_URL);
      await provider.getBlockNumber();
    } catch (rpcErr) {
      logger.error(this.id, `RPC unavailable — skipping stake (${rpcErr.message.slice(0, 100)})`);
      this.state.lastStake = Date.now();
      return { confirmed, target: targetConfirmed, attempts: 0, rpcDown: true };
    }

    while (confirmed < targetConfirmed && attempts < maxAttempts) {
      attempts++;
      try {
        logger.info(this.id, `Stake attempt ${attempts}/${maxAttempts} (${confirmed}/${targetConfirmed} confirmed)...`);
        const signer = this.account.wallet.connect(provider);
        const balance = await provider.getBalance(this.account.address);
        if (balance < ethers.parseEther(MIN_BALANCE)) {
          logger.warn(this.id, `Stake stopped: low balance ${ethers.formatEther(balance)} ETH`);
          break;
        }
        const tx = await signer.sendTransaction({
          to: DACC_CONTRACT,
          data: STAKE_SELECTOR,
          value: ethers.parseEther(TX_VALUE),
        });
        logger.info(this.id, `Stake tx: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 0) {
          logger.warn(this.id, `Stake tx reverted — likely daily/cool-down limit. Stopping stake loop.`);
          break; // revert after 1+ success means limit hit; stop gracefully
        }
        // Wait for API to index the tx
        await sleep(8000);
        let confirmOk = false;
        for (let retry = 0; retry < 3; retry++) {
          try {
            const result = await this.api.confirmStake({ tx_hash: tx.hash });
            confirmed++;
            logger.success(this.id, `Stake ${confirmed}/${targetConfirmed} confirmed: ${JSON.stringify(result).slice(0, 100)}`);
            confirmOk = true;
            break;
          } catch (e) {
            if (retry < 2) {
              logger.info(this.id, `Stake confirm retry ${retry + 1}/3... (${e.message.slice(0, 60)})`);
              await sleep(2000);
            } else {
              logger.error(this.id, `Stake confirm failed: ${e.message.slice(0, 150)}`);
              this.state.errors++;
            }
          }
        }
        if (!confirmOk) {
          logger.warn(this.id, `Stake tx on-chain but API confirm failed — does not count toward target`);
        }
        await randomDelay(2000, 4000);
      } catch (err) {
        if (err.code === 'CALL_EXCEPTION') {
          logger.warn(this.id, `Stake tx reverted (CALL_EXCEPTION) — likely daily/cool-down limit. Stopping.`);
          break;
        }
        logger.error(this.id, `Stake attempt ${attempts}: ${err.message.slice(0, 200)}`);
        this.state.errors++;
        await sleep(2000);
      }
    }

    if (confirmed >= targetConfirmed) {
      logger.success(this.id, `Stake target reached: ${confirmed}/${targetConfirmed} confirmed`);
    } else {
      logger.warn(this.id, `Stake session ended: ${confirmed}/${targetConfirmed} confirmed (${attempts} attempts, max ${maxAttempts})`);
    }
    this.state.lastStake = Date.now();
    return { confirmed, target: targetConfirmed, attempts };
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
