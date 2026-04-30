import 'dotenv/config';
import { Account, makeSignInMessage, makeSignInMessageAlt } from './wallet.js';
import { CookieJar } from './api.js';
import { DACBot } from './bot.js';
import config from './config.js';
import { loadState, saveState, updateAccountRun, incrementError } from './state-manager.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, range = 5000) => base + Math.floor(Math.random() * range);

// ─── CLI argument parsing ───────────────────────────────────────────
const args = process.argv.slice(2);
const cli = {
  mode: 'interval',
  accounts: [],       // empty = both, [1] or [2] for specific
  skipFaucet: false,
  skipCrates: false,
  skipBurn: false,
  skipStake: false,
  help: false,
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--help': case '-h':
      cli.help = true;
      break;
    case '--once': case '-o':
      cli.mode = 'once';
      break;
    case '--account': case '-a':
      if (args[i + 1] && /^[12]$/.test(args[i + 1])) {
        cli.accounts.push(parseInt(args[++i], 10));
      } else {
        console.error(`Invalid --account value: ${args[i + 1]} (use 1 or 2)`);
        process.exit(1);
      }
      break;
    case '--skip-faucet': cli.skipFaucet = true; break;
    case '--skip-crates': cli.skipCrates = true; break;
    case '--skip-burn': cli.skipBurn = true; break;
    case '--skip-stake': cli.skipStake = true; break;
  }
}

if (cli.help) {
  console.log(`DAC Inception Bot — Usage:
  node src/index.js                    # Default: both accounts, all actions, every 24h
  node src/index.js --once             # Single run, then exit
  node src/index.js --once -a 1        # Single run, account 1 only
  node src/index.js --skip-burn        # Run without burn/stake (good when daily limit hit)
  node src/index.js --once -a 2 --skip-crates  # Account 2, skip crates

Account controls (env vars, per-account):
  BURN_ENABLED=false / STAKE_ENABLED=false   # Disable for both accounts
  BURN_ENABLED_1=false                       # Disable burn for account 1 only
  STAKE_ENABLED_2=false                      # Disable stake for account 2 only
  CRATE_COUNT_1=3                            # Custom crate count for account 1
  CRATE_COUNT_2=5                            # Custom crate count for account 2
`);
  process.exit(0);
}

async function tryWalletLogin(api, account) {
  const ts = Date.now().toString();

  // Try format 1: standard sign-in message
  const msg1 = makeSignInMessage(account.address, '0', ts);
  console.log(`  [Account ${account.id}] Signing message: ${msg1.slice(0, 80)}...`);
  const sig1 = await account.signMessage(msg1);
  try {
    const result = await api.walletLogin(account.address, msg1, sig1);
    console.log(`  [Account ${account.id}] Login success: ${JSON.stringify(result).slice(0, 100)}`);
    return true;
  } catch (err) {
    console.log(`  [Account ${account.id}] Format 1 failed (${err.message.slice(0, 80)}), trying alt...`);
  }

  // Try format 2: alternative message
  const msg2 = makeSignInMessageAlt(account.address, '0');
  const sig2 = await account.signMessage(msg2);
  try {
    const result = await api.walletLogin(account.address, msg2, sig2);
    console.log(`  [Account ${account.id}] Login success (alt): ${JSON.stringify(result).slice(0, 100)}`);
    return true;
  } catch (err2) {
    console.warn(`  [Account ${account.id}] Login failed: ${err2.message.slice(0, 150)}`);
    return false;
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

  // Filter accounts based on CLI --account flags
  if (cli.accounts.length > 0) {
    const filtered = accounts.filter(a => cli.accounts.includes(a.id));
    if (filtered.length === 0) {
      console.error(`No matching accounts for --account ${cli.accounts.join(',')}`);
      process.exit(1);
    }
    accounts.length = 0;
    accounts.push(...filtered);
    console.log(`Filtered to accounts: ${accounts.map(a => a.id).join(', ')}\n`);
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

  // Per-account options helper
  const getPerAccountBool = (envKey, id, globalDefault) => {
    const perAcct = process.env[`${envKey}_${id}`];
    if (perAcct !== undefined) return perAcct === 'true';
    const global = process.env[envKey];
    if (global !== undefined) return global === 'true';
    return globalDefault;
  };
  const getPerAccountValue = (envKey, id, globalDefault) => {
    return process.env[`${envKey}_${id}`] || process.env[envKey] || globalDefault;
  };

  // Helper to build cycle opts per account
  const buildOpts = (acct) => ({
    doFaucet: !cli.skipFaucet,
    crateCount: parseInt(getPerAccountValue('CRATE_COUNT', acct.id, process.env.CRATE_OPEN_COUNT || config.DEFAULT_CRATE_COUNT), 10),
    doBurn: !cli.skipBurn && getPerAccountBool('BURN_ENABLED', acct.id, false),
    doStake: !cli.skipStake && getPerAccountBool('STAKE_ENABLED', acct.id, false),
    burnAmount: getPerAccountValue('BURN_AMOUNT', acct.id, '0'),
    stakeAmount: getPerAccountValue('STAKE_AMOUNT', acct.id, '0'),
  });

  // Run cycle function
  const runAll = async () => {
    const ts = new Date().toISOString();
    if (cli.mode !== 'once') {
      console.log(`\n${ts} — Cycle`);
      state.lastScheduledRun = ts;
      saveState(state);
    }
    for (const acct of accounts) {
      console.log(`\n[Account ${acct.id}] ${acct.address}`);
      try {
        await runSingleCycle(acct, buildOpts(acct));
        updateAccountRun(state, acct.id, 'faucet', acct.address);
      } catch (err) {
        console.error(`  [Account ${acct.id}] Cycle failed: ${err.message}`);
        incrementError(state, acct.id);
      }
      if (accounts.indexOf(acct) < accounts.length - 1) {
        await sleep(jitter(30000, 15000));
      }
    }
  };

  await runAll();

  // Schedule recurring (skip if --once)
  if (cli.mode !== 'once') {
    const intervalMs = parseInt(process.env.FAUCET_INTERVAL_HOURS || '24', 10) * 60 * 60 * 1000;
    console.log(`\nNext cycle in ${intervalMs / 3600000} hours...`);
    setInterval(runAll, intervalMs);
  } else {
    console.log('\n--once mode: exiting after single cycle.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
