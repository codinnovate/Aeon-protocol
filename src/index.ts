#!/usr/bin/env node
import { runDiagnose, runQuoteOnly, runSimulateOnly } from "./diagnostics.js";
import { runSellGate } from "./sell.js";

function usage(): never {
  console.log(`Aeon Protocol — Robinhood Chain token diagnostics / safe sell

Usage:
  npm run diagnose   Read-only diagnostics + transferFrom/swap simulations
  npm run quote      Discover pools and quote TOKEN→ETH / TOKEN→USDG
  npm run simulate   Full diagnose + emphasize simulation results
  npm run sell       Only after sims pass; requires typed CONFIRM SELL

Security:
  - PRIVATE_KEY is read only from local .env
  - Private key is never printed
  - No transaction is broadcast unless you type the exact confirmation phrase
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2]?.toLowerCase();
  switch (cmd) {
    case "diagnose":
      await runDiagnose();
      break;
    case "quote":
      await runQuoteOnly();
      break;
    case "simulate":
      await runSimulateOnly();
      break;
    case "sell":
      await runSellGate();
      break;
    default:
      usage();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFatal: ${msg}`);
  process.exit(1);
});
