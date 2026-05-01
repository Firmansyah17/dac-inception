import 'dotenv/config';
import { Account, makeSignInMessage, makeSignInMessageAlt } from './wallet.js';
import { CookieJar } from './api.js';
import { DACBot } from './bot.js';
import config from './config.js';
import { loadState, saveState, updateAccountRun, incrementError } from './state-manager.js';
import { createInterface } from 'readline';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, range = 5000) => base + Math.floor(Math.random() * range);

// ─── CLI argument parsing ───────────────────────────────────────────
const args = process.argv.slice(2);
const cli = {
  mode: 'interval',
  accounts: [],       // empty = both, [1] or [2] for specific
  interactive: false,
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
    case '--interactive': case '-i': cli.interactive = true; break;
    case '--skip-faucet': cli.skipFaucet = true; break;
    case '--skip-crates': cli.skipCrates = true; break;
    case '--skip-burn': cli.skipBurn = true; break;
    case '--skip-stake': cli.skipStake = true; break;
  }
}

if (cli.help) {
  console.log(`DAC Inception Bot — Usage:
  node src/index.js                           # Default: both accounts, all actions, every 24h
  node src/index.js --interactive             # Choose accounts at startup (interactive menu)
  node src/index.js --once                    # Single run (auto-selects both), then exit
  node src/index.js --once -a 1               # Single run, account 1 only
  node src/index.js --once -a 2 --skip-crates # Account 2, skip crates
  node src/index.js --once -i                 # Interactive + once (pick, run, exit)
  node src/index.js --track-faucet            # Check recent faucet TX status for all accounts

Account controls (env vars, per-account):
  BURN_ENABLED=false / STAKE_ENABLED=false   # Disable for both accounts
  BURN_ENABLED_1=false                       # Disable burn for account 1 only
  CRATE_COUNT_1=3                            # Custom crate count for account 1
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

  // ─── Interactive account selection ────────────────────────────────
  if (cli.interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));
    console.log('\n=== Select Accounts ===');
    console.log('1. Account 1');
    console.log('2. Account 2');
    console.log('3. Both accounts');
    console.log('4. Track faucet status only');
    console.log('5. Exit\n');
    const choice = (await ask('Select [1-5]: ')).trim();
    if (choice === '4') {
      rl.close();
      return await checkFaucetTracker(accounts);
    }
    if (choice === '5' || !choice) {
      rl.close();
      process.exit(0);
    }
    if (choice === '3') {
      // both — cli.accounts already empty
    } else if (choice === '1' || choice === '2') {
      const acctId = parseInt(choice, 10);
      const filtered = accounts.filter(a => a.id === acctId);
      if (filtered.length === 0) {
        console.error(`Account ${acctId} not configured.`);
        rl.close();
        process.exit(1);
      }
      accounts.length = 0;
      accounts.push(...filtered);
      console.log(`Selected: Account ${acctId}\n`);
    } else {
      console.log(`Invalid choice "${choice}" — defaulting to both.`);
    }

    // Action selection
    console.log('\n=== Select Actions ===');
    console.log('Actions enabled: faucet, crates, burn, stake');
    const skipAns = (await ask('Skip any? (e.g. "burn stake" or ENTER for none): ')).trim().toLowerCase();
    if (skipAns.includes('faucet')) cli.skipFaucet = true;
    if (skipAns.includes('crate')) cli.skipCrates = true;
    if (skipAns.includes('burn')) cli.skipBurn = true;
    if (skipAns.includes('stake')) cli.skipStake = true;

    // Once or scheduled
    const schedAns = (await ask('Run once or schedule? (once/schedule, default=schedule): ')).trim().toLowerCase();
    if (schedAns === 'once') cli.mode = 'once';
    rl.close();
    console.log('\n');
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

  // Faucet dispense tracking helper
  async function checkFaucetTracker(availableAccounts) {
    console.log('\n=== Faucet Dispense Tracker ===');
    const results = [];
    for (const acct of availableAccounts) {
      console.log(`\n[Account ${acct.id}] ${acct.address}`);
      try {
        const jar = new CookieJar();
        const bot = new DACBot(acct, jar);
        await bot.api.fetchCookies();
        const loggedIn = await tryWalletLogin(bot.api, acct);
        if (!loggedIn) {
          console.log(`  ⚠️ Not logged in — fetching public info only`);
        }

        // Sync session to get latest balance + tx_count
        const session = await bot.api.sync();
        console.log(`  DACC balance: ${session.dacc_balance ?? 'N/A'}`);
        console.log(`  TX count:     ${session.tx_count ?? 'N/A'}`);
        results.push({ account: acct.id, success: true, ...session });

        // Check faucet status via API (reuse existing bot)
        console.log('  Checking recent dispenses...');
        const profile = await bot.api.getProfile();
        if (profile.dacc_balance) {
          console.log(`  Profile DACC balance: ${profile.dacc_balance}`);
        }
        if (profile.tx_count !== undefined) {
          console.log(`  Profile TX count: ${profile.tx_count}`);
        }
      } catch (err) {
        console.log(`  ❌ Session check failed: ${err.message.slice(0, 150)}`);
        results.push({ account: acct.id, success: false, error: err.message });
      }

      if (availableAccounts.indexOf(acct) < availableAccounts.length - 1) {
        await sleep(2000);
      }
    }

    console.log('\n=== Faucet Tracker Complete ===');
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
