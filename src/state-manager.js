import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(import.meta.dirname, 'state.json');

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    const defaults = {
      accounts: {
        1: { address: null, lastFaucet: null, lastCrate: null, lastBurn: null, lastStake: null, totalRuns: 0, totalErrors: 0 },
        2: { address: null, lastFaucet: null, lastCrate: null, lastBurn: null, lastStake: null, totalRuns: 0, totalErrors: 0 },
      },
      lastScheduledRun: null,
    };
    saveState(defaults);
    return defaults;
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function updateAccountRun(state, acctId, runType, address) {
  const acct = state.accounts[acctId];
  if (!acct) return;
  acct.address = address || acct.address;
  if (runType) acct[`last${runType.charAt(0).toUpperCase() + runType.slice(1)}`] = new Date().toISOString();
  acct.totalRuns = (acct.totalRuns || 0) + 1;
  saveState(state);
}

export function incrementError(state, acctId) {
  const acct = state.accounts[acctId];
  if (acct) {
    acct.totalErrors = (acct.totalErrors || 0) + 1;
    saveState(state);
  }
}
