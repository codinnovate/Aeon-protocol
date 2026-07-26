import { formatEther, formatUnits, parseUnits } from "viem";
import {
  ADDRESSES,
  type AppConfig,
  createClients,
  explorerAddressUrl,
  logKv,
  logSection,
  loadConfig,
} from "./config.js";
import { analyzeFailedTransaction, formatEth } from "./decode.js";
import { collectAllowanceReport, printAllowanceReport } from "./permit2.js";
import { discoverPools, printPoolDiscovery } from "./pools.js";
import { printQuote, quoteTokenToEth, quoteTokenToUsdg } from "./quote.js";
import {
  printSwapSim,
  printTransferFromSims,
  runTransferFromDiagnostics,
  simulateV3SellViaSwapRouter02,
} from "./simulate.js";
import {
  getTokenMeta,
  inspectTokenContract,
  printTokenInspection,
  resolveTokenAddress,
} from "./token.js";

export type DiagnoseResult = {
  config: AppConfig;
  token: Awaited<ReturnType<typeof resolveTokenAddress>>;
  meta: Awaited<ReturnType<typeof getTokenMeta>>;
  testAmount: bigint;
  transferSimsOk: boolean;
  quoteOk: boolean;
  swapSimOk: boolean;
};

function pickTestAmount(
  balance: bigint,
  decimals: number,
  human: string,
): bigint {
  let requested = 0n;
  try {
    requested = parseUnits(human, decimals);
  } catch {
    requested = parseUnits("0.001", decimals);
  }
  if (balance === 0n) return requested;
  if (requested === 0n) {
    // 0.1% of balance or 1 unit, whichever larger but capped
    const tiny = balance / 1000n;
    return tiny > 0n ? tiny : 1n;
  }
  if (requested > balance) {
    console.warn(
      `[!] TEST_SELL_AMOUNT ${human} exceeds balance; using min(balance, 0.1% balance)`,
    );
    const tiny = balance / 1000n;
    return tiny > 0n && tiny < balance ? tiny : balance > 1n ? 1n : balance;
  }
  return requested;
}

export async function runDiagnose(): Promise<DiagnoseResult> {
  const config = loadConfig();
  const { publicClient } = createClients(config);

  logSection("PHASE 1 — TOKEN DIAGNOSTICS");
  logKv("chain", `Robinhood Chain (${config.rpcUrl})`);
  logKv("chain id", "4663");
  logKv("wallet (public)", config.walletAddress);
  logKv("explorer wallet", explorerAddressUrl(config.walletAddress));
  logKv("configured token/pool", config.tokenAddress);

  const resolved = await resolveTokenAddress(
    publicClient,
    config.tokenAddress,
  );
  logKv("resolved ERC-20", resolved.token);
  logKv("resolved from pool?", resolved.resolvedFromPool);
  if (resolved.pool) {
    logKv("pool address", resolved.pool.address);
    logKv("pool token0", resolved.pool.token0);
    logKv("pool token1", resolved.pool.token1);
    logKv("pool fee", resolved.pool.fee);
    logKv("pool liquidity", resolved.pool.liquidity.toString());
  }

  const meta = await getTokenMeta(
    publicClient,
    resolved.token,
    config.walletAddress,
  );
  logKv("token name", meta.name);
  logKv("token symbol", meta.symbol);
  logKv("decimals", meta.decimals);
  logKv("wallet token balance raw", meta.balance.toString());
  logKv(
    "wallet token balance",
    `${formatUnits(meta.balance, meta.decimals)} ${meta.symbol}`,
  );
  logKv("wallet ETH balance", formatEth(meta.ethBalance));

  const testAmount = pickTestAmount(
    meta.balance,
    meta.decimals,
    config.testSellAmountHuman,
  );
  logKv(
    "test amount",
    `${formatUnits(testAmount, meta.decimals)} ${meta.symbol} (${testAmount})`,
  );

  logSection("ALLOWANCES (ERC20 vs Permit2 — distinct)");
  logKv("Permit2", ADDRESSES.permit2);
  logKv("Universal Router 2.1.1", ADDRESSES.universalRouterV2_1_1);
  logKv("Permit2Proxy (failed tx)", ADDRESSES.permit2Proxy);
  const allowances = await collectAllowanceReport(
    publicClient,
    config.walletAddress,
    resolved.token,
    testAmount,
  );
  printAllowanceReport(allowances);

  logSection("TOKEN CONTRACT INSPECTION");
  const inspection = await inspectTokenContract(
    publicClient,
    resolved.token,
    config.walletAddress,
  );
  printTokenInspection(inspection);

  logSection("FAILED TRANSACTION ANALYSIS");
  const trace = await analyzeFailedTransaction();
  for (const line of trace.summary) console.log(`  ${line}`);
  if (trace.failedCall) {
    logKv("failed to", trace.failedCall.toLabel ?? trace.failedCall.to);
    logKv("error", trace.failedCall.error ?? "n/a");
  }

  const transferSims = await runTransferFromDiagnostics(
    publicClient,
    resolved.token,
    config.walletAddress,
    testAmount,
  );
  printTransferFromSims(transferSims);
  const transferSimsOk = transferSims.some((s) => s.ok);

  logSection("PHASE 2 — LIQUIDITY / ROUTER DISCOVERY");
  logKv(
    "preferred router",
    `${ADDRESSES.universalRouterV2_1_1} (Universal Router 2.1.1 — Uniswap docs/SDK)`,
  );
  logKv("also on-chain UR 2.0", ADDRESSES.universalRouterV2_0);
  logKv("SwapRouter02", ADDRESSES.v3SwapRouter02);
  logKv("QuoterV2", ADDRESSES.v3QuoterV2);
  const pools = await discoverPools(
    publicClient,
    resolved.token,
    config.walletAddress,
  );
  printPoolDiscovery(pools);

  logSection("PHASE 3 — QUOTE");
  const quoteEth = await quoteTokenToEth(
    publicClient,
    config,
    resolved.token,
    testAmount,
    pools,
  );
  printQuote(quoteEth, meta.decimals, 18);

  const quoteUsdg = await quoteTokenToUsdg(
    publicClient,
    config,
    resolved.token,
    testAmount,
    pools,
  );
  console.log("\n  --- TOKEN → USDG ---");
  printQuote(quoteUsdg, meta.decimals, 6);

  logSection("PHASE 4 — SIMULATE SELL (NOT broadcast)");
  const swapSim = await simulateV3SellViaSwapRouter02(
    publicClient,
    config,
    resolved.token,
    quoteEth,
  );
  printSwapSim("SwapRouter02 exactInputSingle TOKEN→WETH", swapSim);

  logSection("DIAGNOSE SUMMARY");
  logKv("wallet", config.walletAddress);
  logKv("token", `${meta.symbol} ${resolved.token}`);
  logKv("ETH balance", formatEther(meta.ethBalance));
  logKv("token balance", formatUnits(meta.balance, meta.decimals));
  logKv("any transferFrom sim ok?", transferSimsOk);
  logKv("ETH quote ok?", quoteEth.ok);
  logKv("swap simulation ok?", swapSim.ok);
  logKv("ERC20→Permit2 enough?", allowances.erc20EnoughForAmount);
  logKv("Permit2→UR enough?", allowances.permit2RouterEnough);

  if (!transferSimsOk) {
    console.log(
      "\n  ⇒ transferFrom simulations failed. Likely cause classes:",
    );
    console.log(
      "    - insufficient ERC20 allowance to Permit2 / router spender",
    );
    console.log("    - insufficient/expired Permit2 allowance to router");
    console.log("    - token-level restriction (unverified AEON contract)");
  }
  if (quoteEth.ok && !swapSim.ok) {
    console.log(
      "\n  ⇒ Route/quote exists but swap simulation failed — see classification above.",
    );
  }
  if (quoteEth.ok && transferSimsOk && swapSim.ok) {
    console.log(
      "\n  ⇒ Diagnostics look healthy for a tiny test sell. Run `npm run simulate` then `npm run sell` (requires CONFIRM SELL).",
    );
  }

  console.log(
    config.canSign
      ? "\n[SAFE] No transactions were broadcast. Private key was only used to derive the public address / local signer object.\n"
      : "\n[SAFE] No transactions were broadcast (read-only mode; no PRIVATE_KEY loaded).\n",
  );

  return {
    config,
    token: resolved,
    meta,
    testAmount,
    transferSimsOk,
    quoteOk: quoteEth.ok,
    swapSimOk: swapSim.ok,
  };
}

export async function runQuoteOnly(): Promise<void> {
  const config = loadConfig();
  const { publicClient } = createClients(config);
  const resolved = await resolveTokenAddress(
    publicClient,
    config.tokenAddress,
  );
  const meta = await getTokenMeta(
    publicClient,
    resolved.token,
    config.walletAddress,
  );
  const amount = pickTestAmount(
    meta.balance,
    meta.decimals,
    config.testSellAmountHuman,
  );
  const pools = await discoverPools(
    publicClient,
    resolved.token,
    config.walletAddress,
  );
  printPoolDiscovery(pools);
  const q = await quoteTokenToEth(
    publicClient,
    config,
    resolved.token,
    amount,
    pools,
  );
  printQuote(q, meta.decimals, 18);
  const q2 = await quoteTokenToUsdg(
    publicClient,
    config,
    resolved.token,
    amount,
    pools,
  );
  printQuote(q2, meta.decimals, 6);
}

export async function runSimulateOnly(): Promise<void> {
  const diag = await runDiagnose();
  if (!diag.quoteOk) {
    console.error("\nSimulate aborted: no valid quote.");
    process.exitCode = 1;
  }
  if (!diag.swapSimOk) {
    console.error("\nSwap simulation did not succeed — refusing to recommend sell.");
    process.exitCode = 1;
  }
}
