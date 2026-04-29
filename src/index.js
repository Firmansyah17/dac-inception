import 'dotenv/config';
import { Account, makeSignInMessage, makeSignInMessageAlt } from './wallet.js';
import { CookieJar } from './api.js';
import { DACBot } from './bot.js';
import config from './config.js';
import { loadState, saveState, updateAccountRun, incrementError } from './state-manager.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, range = 5000) => base + Math.floor(Math.random() * range);

async function tryWalletLogin(api, account) {
  // Step 1: GET the auth endpoint to get a nonce
  // The site likely exposes a nonce via the profile or sync endpoint
  let nonce = null;
  
  // Try sync first — it may return nonce or session data
  try {
    const syncResult = await api.sync();
    if (syncResult?.nonce) nonce = syncResult.nonce;
    if (syncResult?.authChallenge) nonce = syncResult.authChallenge;
  } catch {}

  // If no nonce from sync, try the profile endpoint
  if (!nonce) {
    try {
      const profile = await api.getProfile();
      if (profile?.nonce) nonce = profile.nonce;
    } catch {}
  }

  const ts = Date.now().toString();
  // Format message — try most common dApp format first
  const msg = nonce
    ? makeSignInMessage(account.address, nonce, ts)
    : makeSignInMessage(account.address, '0', ts);

  console.log(`  [Account ${account.id}] Signing message: ${msg.slice(0, 80)}...`);
  const signature = await account.signMessage(msg);

  // Try wallet login
  try {
    const result = await api.walletLogin(account.address, msg, signature);
    console.log(`  [Account ${account.id}] Login success: ${JSON.stringify(result).slice(0, 100)}`);
    return true;
  } catch (err) {
    // Try alternative message format
    console.log(`  [Account ${account.id}] First login attempt failed, trying alt format...`);
    const altMsg = nonce
      ? makeSignInMessageAlt(account.address, nonce)
      : makeSignInMessageAlt(account.address, '0');
    const altSig = await account.signMessage(altMsg);
    try {
      const result = await api.walletLogin(account.address, altMsg, altSig);
      console.log(`  [Account ${account.id}] Login success (alt): ${JSON.stringify(result).slice(0, 100)}`);
      return true;
    } catch (err2) {
      console.warn(`  [Account ${account.id}] Login failed: ${err2.message}`);
      return false;
    }
  }
}

async function runSingleCycle(account, opts = {}) {
  const jar = new CookieJar();
  const bot = new DACBot(account, jar);

  // Fetch cookies + CSRF token BEFORE any POST
  try {
    await bot.api.fetchCookies();
  } catch {}

  // Attempt wallet login
  const loggedIn = await tryWalletLogin(bot.api, account);
  if (!loggedIn) {
    console.warn(`  [Account ${account.id}] Could not authenticate — will try API calls anyway`);
  }

  return bot.runCycle(opts);
}

async function main() {
  const state = loadState();

  // Load accounts
  const accounts = [];
  for (let i = 1; i <= 2; i++) {
    const key = process.env[`ACCOUNT_${i}_PRIVATE_KEY`];
    const addr = process.env[`ACCOUNT_${i}_ADDRESS`];
    if (key && addr && key !== `0xYOUR_PRIVATE_KEY_${i}`) {
      accounts.push(new Account(i, key, addr));
    } else if (key && !addr) {
      // Address not set — derive from private key
      try {
        const acct = new Account(i, key, '');
        accounts.push(acct);
        console.log(`Account ${i}: derived address ${acct.address}`);
      } catch (err) {
        console.error(`Account ${i}: invalid key — ${err.message}`);
      }
    } else {
      console.log(`Account ${i}: not configured (skipping)`);
    }
  }

  if (accounts.length === 0) {
    console.error('No accounts configured. Edit .env and set ACCOUNT_1_PRIVATE_KEY at minimum.');
    console.log('  cp .env.example .env  # then edit .env with your actual keys');
    process.exit(1);
  }

  console.log('\n=== DAC Inception Bot ===');
  console.log(`Accounts loaded: ${accounts.length}`);
  console.log(`Interval: ${process.env.FAUCET_INTERVAL_HOURS || 24}h`);
  console.log(`Crates per run: ${process.env.CRATE_OPEN_COUNT || config.DEFAULT_CRATE_COUNT}`);
  console.log('---\n');

  // Initial cycle
  for (const acct of accounts) {
    console.log(`\n[Account ${acct.id}] ${acct.address}`);
    try {
      await runSingleCycle(acct, {
        doFaucet: true,
        crateCount: parseInt(process.env.CRATE_OPEN_COUNT || config.DEFAULT_CRATE_COUNT, 10),
        doBurn: process.env.BURN_ENABLED === 'true',
        doStake: process.env.STAKE_ENABLED === 'true',
        burnAmount: process.env.BURN_AMOUNT || '0',
        stakeAmount: process.env.STAKE_AMOUNT || '0',
      });
      updateAccountRun(state, acct.id, 'faucet', acct.address);
    } catch (err) {
      console.error(`  [Account ${acct.id}] Cycle failed: ${err.message}`);
      incrementError(state, acct.id);
    }
    if (accounts.indexOf(acct) < accounts.length - 1) {
      await sleep(jitter(30000, 15000));
    }
  }

  // Schedule recurring
  const intervalMs = parseInt(process.env.FAUCET_INTERVAL_HOURS || '24', 10) * 60 * 60 * 1000;
  console.log(`\nNext cycle in ${intervalMs / 3600000} hours...`);
  setInterval(async () => {
    const ts = new Date().toISOString();
    console.log(`\n${ts} — Scheduled cycle`);
    state.lastScheduledRun = ts;
    saveState(state);

    for (const acct of accounts) {
      try {
        await runSingleCycle(acct, {
          doFaucet: true,
          crateCount: parseInt(process.env.CRATE_OPEN_COUNT || config.DEFAULT_CRATE_COUNT, 10),
          doBurn: process.env.BURN_ENABLED === 'true',
          doStake: process.env.STAKE_ENABLED === 'true',
          burnAmount: process.env.BURN_AMOUNT || '0',
          stakeAmount: process.env.STAKE_AMOUNT || '0',
        });
        updateAccountRun(state, acct.id, 'faucet', acct.address);
      } catch (err) {
        console.error(`  [Account ${acct.id}] Scheduled cycle failed: ${err.message}`);
        incrementError(state, acct.id);
      }
      if (accounts.indexOf(acct) < accounts.length - 1) {
        await sleep(jitter(30000, 15000));
      }
    }
  }, intervalMs);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
