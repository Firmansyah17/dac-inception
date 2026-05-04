import { ethers } from 'ethers';
import { Account } from './wallet.js';
import { CookieJar, InceptionAPI } from './api.js';
import config from './config.js';

const logger = {
  info:    (id, msg) => console.log( `[${new Date().toISOString()}] [Account ${id}] ${msg}`),
  error:   (id, msg) => console.error(`[${new Date().toISOString()}] [Account ${id}] ERROR: ${msg}`),
  success: (id, msg) => console.log( `[${new Date().toISOString()}] [Account ${id}] ✅ ${msg}`),
  warn:    (id, msg) => console.warn( `[${new Date().toISOString()}] [Account ${id}] ⚠️ ${msg}`),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 2000, max = 5000) =>
  sleep(Math.floor(Math.random() * (max - min)) + min);

const pollReceipt = async (rpcUrl, hash, timeoutMs = 180000, intervalMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt  = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    } catch (_) { /* 504 / timeout — diam-diam retry */ }
    await sleep(intervalMs);
  }
  return null; // timeout tapi tx mungkin sudah on-chain
};

const DACC_CONTRACT = '0x3691a78be270db1f3b1a86177a8f23f89a8cef24';
const BURN_SELECTOR  = '0x4a5d094b';
const STAKE_SELECTOR = '0x3a4b66f1';
const TX_VALUE       = '0.1';
const MIN_BALANCE    = '0.12';

export class DACBot {
  constructor(account, cookieJar) {
    this.account = account;
    this.api     = new InceptionAPI(cookieJar);
    this.id      = account.id;
    this.state   = { lastFaucet: null, lastCrate: null, lastBurn: null, lastStake: null, runs: 0, errors: 0 };
  }

  async runCycle(opts = {}) {
    const { doFaucet = true, crateCount = config.DEFAULT_CRATE_COUNT,
            doBurn = false, doStake = false } = opts;
    this.state.runs++;
    logger.info(this.id, `Starting cycle #${this.state.runs}`);
    await this.syncSession(); await randomDelay();
    if (doFaucet) { await this.doFaucet(); await randomDelay(); await sleep(5000); await this.syncSession(); await randomDelay(); }
    await this.doOpenCrates(crateCount); await randomDelay();
    if (doBurn)  { await this.doBurn();  await randomDelay(); }
    if (doStake) { await this.doStake(); await randomDelay(); }
    await this.reportStatus();
    logger.success(this.id, `Cycle #${this.state.runs} complete`);
  }

  async syncSession() {
    try {
      logger.info(this.id, 'Syncing session...');
      const r = await this.api.sync();
      logger.info(this.id, `Session synced: ${JSON.stringify(r).slice(0, 100)}`);
      return r;
    } catch (err) { logger.warn(this.id, `Sync failed: ${err.message}`); return null; }
  }

  async doFaucet() {
    try {
      logger.info(this.id, `Requesting faucet for ${this.account.address}...`);
      try { const s = await this.api.faucetStatus(this.account.address); logger.info(this.id, `Faucet status: ${JSON.stringify(s).slice(0, 200)}`); } catch {}
      try {
        const r = await this.api.faucet(this.account.address);
        logger.success(this.id, `Faucet claimed: ${JSON.stringify(r).slice(0, 200)}`);
        this.state.lastFaucet = Date.now(); return r;
      } catch (err) {
        const m = err.message.toLowerCase();
        if (m.includes('already') || m.includes('cooldown') || m.includes('wait') || m.includes('claimed') || m.includes('429')) {
          logger.info(this.id, `Faucet on cooldown — skipping (${err.message.slice(0, 120)})`); return null;
        }
        throw err;
      }
    } catch (err) { logger.error(this.id, `Faucet failed: ${err.message.slice(0, 200)}`); this.state.errors++; return null; }
  }

  async doOpenCrates(count = config.DEFAULT_CRATE_COUNT) {
    for (let i = 0; i < count; i++) {
      try {
        logger.info(this.id, `Opening crate ${i+1}/${count}...`);
        const r = await this.api.openCrate(1);
        logger.success(this.id, `Crate ${i+1}: ${r?.reward?.label || JSON.stringify(r).slice(0, 80)}`);
        await randomDelay(1000, 3000);
      } catch (err) {
        const m = err.message.toLowerCase();
        if (m.includes('daily limit') || m.includes('maximum') || m.includes('already')) {
          logger.info(this.id, `Open crate ${i+1}: daily limit reached — stopping`); break;
        }
        logger.error(this.id, `Open crate ${i+1} failed: ${err.message.slice(0, 120)}`); this.state.errors++;
      }
    }
    this.state.lastCrate = Date.now();
  }

  async _sendOnChain(selector, label) {
    const targetConfirmed = label === 'Burn' ? 3 : 5;
    const maxAttempts     = 20;
    let confirmed = 0, attempts = 0;

    while (confirmed < targetConfirmed && attempts < maxAttempts) {
      attempts++;
      logger.info(this.id, `${label} attempt ${attempts}/${maxAttempts} (${confirmed}/${targetConfirmed} confirmed)...`);
      try {
        // Fresh provider per attempt
        const provider = new ethers.JsonRpcProvider(config.RPC_URL);
        
        // RPC check awal
        await provider.getBlockNumber();

        const signer  = this.account.wallet.connect(provider);
        const balance = await provider.getBalance(this.account.address);
        if (balance < ethers.parseEther(MIN_BALANCE)) {
          logger.warn(this.id, `${label} stopped: low balance ${ethers.formatEther(balance)} DACC`); break;
        }

        // Gas 2× supaya tx cepat masuk
        const feeData  = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ? feeData.gasPrice * 2n : ethers.parseUnits('5', 'gwei');

        const tx = await signer.sendTransaction({
          to: DACC_CONTRACT, data: selector,
          value: ethers.parseEther(TX_VALUE),
          gasPrice, gasLimit: 100000,
        });
        logger.info(this.id, `${label} tx: ${tx.hash}`);

        // Poll receipt sendiri
        const receipt = await pollReceipt(config.RPC_URL, tx.hash);
        if (!receipt) {
          logger.warn(this.id, `${label} receipt timeout — tx mungkin on-chain, coba confirm API...`);
        } else if (receipt.status === 0) {
          logger.warn(this.id, `${label} attempt ${attempts}: tx reverted — retrying`);
          await sleep(3000); continue;
        }

        await sleep(8000); 

        let confirmOk = false;
        for (let retry = 0; retry < 3; retry++) {
          try {
            const result = label === 'Burn'
              ? await this.api.confirmBurn({ tx_hash: tx.hash })
              : await this.api.confirmStake({ tx_hash: tx.hash });
            confirmed++;
            logger.success(this.id, `${label} ${confirmed}/${targetConfirmed} confirmed: ${JSON.stringify(result).slice(0, 100)}`);
            confirmOk = true; break;
          } catch (e) {
            if (retry < 2) { logger.info(this.id, `${label} confirm retry ${retry+1}/3... (${e.message.slice(0, 60)})`); await sleep(3000); }
            else { logger.error(this.id, `${label} confirm failed: ${e.message.slice(0, 150)}`); this.state.errors++; }
          }
        }
        if (!confirmOk) logger.warn(this.id, `${label} tx on-chain tapi API confirm gagal`);
        await randomDelay(2000, 4000);

      } catch (err) {
        logger.error(this.id, `${label} attempt ${attempts} error: ${err.message.slice(0, 150)}`);
        this.state.errors++;
        
        // Exponential backoff logic
        const backoffMs = Math.min(10000 * attempts, 60000);
        logger.warn(this.id, `RPC overload — waiting ${backoffMs / 1000}s before next attempt...`);
        await sleep(backoffMs);
      }
    }

    if (confirmed >= targetConfirmed) logger.success(this.id, `${label} target reached: ${confirmed}/${targetConfirmed}`);
    else logger.warn(this.id, `${label} ended: ${confirmed}/${targetConfirmed} (${attempts} attempts)`);
    if (label === 'Burn') this.state.lastBurn = Date.now();
    else this.state.lastStake = Date.now();
  }

  async doBurn()  { return this._sendOnChain(BURN_SELECTOR,  'Burn');  }
  async doStake() { return this._sendOnChain(STAKE_SELECTOR, 'Stake'); }

  async reportStatus() {
    try { const p = await this.api.getProfile(); logger.info(this.id, `Profile: ${JSON.stringify(p).slice(0, 300)}`); }
    catch (err) { logger.warn(this.id, `Profile fetch failed: ${err.message}`); }
  }
}
