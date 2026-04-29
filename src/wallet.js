import { ethers } from 'ethers';

export class Account {
  constructor(id, privateKey, address) {
    this.id = id;
    this.privateKey = privateKey;
    // Derive address from private key if not provided
    try {
      const wallet = new ethers.Wallet(privateKey);
      this.address = (address || wallet.address).toLowerCase();
      this.wallet = wallet;
    } catch (err) {
      throw new Error(`Account ${id}: invalid private key — ${err.message}`);
    }
  }

  // EIP-191 personal sign
  async signMessage(message) {
    return await this.wallet.signMessage(message);
  }

  // Get balance from RPC
  async getBalance(rpcUrl) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    return await provider.getBalance(this.address);
  }
}

// Standard sign-in messages seen in similar dApps
export function makeSignInMessage(address, nonce, timestamp) {
  return `Sign in to DAC Inception\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
}

// Alternative formats the site might use
export function makeSignInMessageAlt(address, nonce) {
  return `Connect your wallet to DAC Inception\n\nNonce: ${nonce}\nAddress: ${address}`;
}
