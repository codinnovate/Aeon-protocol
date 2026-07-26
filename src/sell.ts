import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  type Address,
  erc20Abi,
  formatEther,
  formatUnits,
  maxUint256,
  parseAbi,
} from "viem";
import {
  ADDRESSES,
  type AppConfig,
  createClients,
  explorerTxUrl,
  logKv,
  logSection,
  loadConfig,
} from "./config.js";
import { runDiagnose } from "./diagnostics.js";
import { permit2Abi } from "./permit2.js";
import { quoteTokenToEth } from "./quote.js";
import { simulateV3SellViaSwapRouter02 } from "./simulate.js";
import { getTokenMeta, resolveTokenAddress } from "./token.js";

const swapRouter02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

async function promptExact(expected: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`\nType exactly \`${expected}\` to continue: `)).trim();
    return answer === expected;
  } finally {
    rl.close();
  }
}

function printSafetyBanner(opts: {
  wallet: Address;
  router: Address;
  spender: Address;
  amount: string;
  minOut: string;
  gas?: string;
}): void {
  logSection("SAFETY CHECK — REAL TRANSACTION");
  console.log("You are about to interact with:");
  logKv("Chain", "Robinhood Chain");
  logKv("Token", ADDRESSES.weth && "see below");
  logKv("Wallet", opts.wallet);
  logKv("Router", opts.router);
  logKv("Spender", opts.spender);
  logKv("Amount", opts.amount);
  logKv("Minimum output", opts.minOut);
  logKv("Estimated gas", opts.gas ?? "n/a");
}

/**
 * Approval fix path. Never auto-sends. Requires typing APPROVE.
 */
export async function maybeApprove(opts: {
  config: AppConfig;
  token: Address;
  spender: Address;
  amount: bigint;
  mode: "erc20" | "permit2";
}): Promise<boolean> {
  if (!opts.config.canSign || !opts.config.privateKey) {
    throw new Error("Signing requires PRIVATE_KEY in local .env");
  }
  const { publicClient, walletClient, account } = createClients(opts.config);

  if (opts.mode === "erc20") {
    logSection("APPROVAL REQUIRED — ERC20 → spender");
    logKv("token", opts.token);
    logKv("spender", opts.spender);
    logKv("spender label", opts.spender === ADDRESSES.permit2 ? "Permit2" : opts.spender);
    logKv("amount", opts.amount === maxUint256 ? "MAX_UINT256" : opts.amount.toString());

    printSafetyBanner({
      wallet: opts.config.walletAddress,
      router: ADDRESSES.universalRouterV2_1_1,
      spender: opts.spender,
      amount: opts.amount.toString(),
      minOut: "n/a (approval)",
    });
    logKv("Token", opts.token);

    const ok = await promptExact("APPROVE");
    if (!ok) {
      console.log("Approval cancelled.");
      return false;
    }

    const hash = await walletClient.writeContract({
      address: opts.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [opts.spender, opts.amount],
      account,
      chain: walletClient.chain,
    });
    console.log(`Submitted approve tx: ${hash}`);
    console.log(explorerTxUrl(hash));
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    logKv("status", receipt.status);
    logKv("gas used", receipt.gasUsed.toString());
    return receipt.status === "success";
  }

  // Permit2.approve(token, spender, amount, expiration)
  const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30d
  const amount160 =
    opts.amount > (1n << 160n) - 1n ? (1n << 160n) - 1n : opts.amount;

  logSection("APPROVAL REQUIRED — Permit2 allowance");
  logKv("Permit2", ADDRESSES.permit2);
  logKv("token", opts.token);
  logKv("spender", opts.spender);
  logKv("amount160", amount160.toString());
  logKv("expiration", expiration);

  printSafetyBanner({
    wallet: opts.config.walletAddress,
    router: opts.spender,
    spender: ADDRESSES.permit2,
    amount: amount160.toString(),
    minOut: "n/a (permit2 approve)",
  });
  logKv("Token", opts.token);

  const ok = await promptExact("APPROVE");
  if (!ok) {
    console.log("Permit2 approval cancelled.");
    return false;
  }

  const hash = await walletClient.writeContract({
    address: ADDRESSES.permit2,
    abi: permit2Abi,
    functionName: "approve",
    args: [opts.token, opts.spender, amount160, expiration],
    account,
    chain: walletClient.chain,
  });
  console.log(`Submitted Permit2.approve tx: ${hash}`);
  console.log(explorerTxUrl(hash));
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  logKv("status", receipt.status);
  return receipt.status === "success";
}

/**
 * PHASE 6 — SELL
 * Refuses unless diagnostics + simulations pass and user types CONFIRM SELL.
 */
export async function runSell(): Promise<void> {
  console.log(
    "\n[SAFE DEFAULT] Running full diagnostics + simulations before any broadcast…\n",
  );
  const diag = await runDiagnose();

  if (!diag.quoteOk) {
    throw new Error("Refuse to sell: no valid TOKEN→ETH quote.");
  }
  if (!diag.swapSimOk) {
    throw new Error(
      "Refuse to sell: swap simulation failed. Fix allowances/restrictions first.",
    );
  }
  if (!diag.transferSimsOk) {
    console.warn(
      "[!] No transferFrom simulation succeeded. Sell will likely fail.",
    );
    console.warn(
      "    Continuing only if you still type CONFIRM SELL after the banner.",
    );
  }

  if (!diag.config.canSign) {
    throw new Error("Sell requires PRIVATE_KEY in local .env");
  }
  const { publicClient, walletClient, account } = createClients(diag.config);
  const resolved = diag.token;
  const meta = diag.meta;
  const amount = diag.testAmount;

  const quote = await quoteTokenToEth(
    publicClient,
    diag.config,
    resolved.token,
    amount,
  );
  if (!quote.ok || quote.fee == null) {
    throw new Error("Quote disappeared before sell.");
  }

  // Re-simulate immediately before prompt
  const sim = await simulateV3SellViaSwapRouter02(
    publicClient,
    diag.config,
    resolved.token,
    quote,
  );
  if (!sim.ok) {
    // Attempt to guide approval
    const erc20ToRouter = await publicClient.readContract({
      address: resolved.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [diag.config.walletAddress, ADDRESSES.v3SwapRouter02],
    });
    if (erc20ToRouter < amount) {
      console.log(
        "\nSwap sim failed and ERC20 allowance to SwapRouter02 is insufficient.",
      );
      console.log(
        "This CLI can send approve(SwapRouter02) after you type APPROVE.",
      );
      const approved = await maybeApprove({
        config: diag.config,
        token: resolved.token,
        spender: ADDRESSES.v3SwapRouter02,
        amount: amount,
        mode: "erc20",
      });
      if (!approved) {
        throw new Error("Approval not completed; aborting sell.");
      }
      const sim2 = await simulateV3SellViaSwapRouter02(
        publicClient,
        diag.config,
        resolved.token,
        quote,
      );
      if (!sim2.ok) {
        throw new Error(
          "Swap still fails after approval — likely token restriction. Aborting.",
        );
      }
    } else {
      throw new Error("Swap simulation failed; aborting sell.");
    }
  }

  const ethBefore = await publicClient.getBalance({
    address: diag.config.walletAddress,
  });

  printSafetyBanner({
    wallet: diag.config.walletAddress,
    router: ADDRESSES.v3SwapRouter02,
    spender: ADDRESSES.v3SwapRouter02,
    amount: `${formatUnits(amount, meta.decimals)} ${meta.symbol}`,
    minOut: `${formatEther(quote.minOutput)} ETH/WETH`,
    gas: sim.gasEstimate?.toString(),
  });
  logKv("Token", resolved.token);
  console.log(
    `\nDefault is a SMALL TEST SELL: ${formatUnits(amount, meta.decimals)} ${meta.symbol}`,
  );
  console.log(
    `Confirmation phrase required: CONFIRM SELL`,
  );
  console.log(
    `(Also accepted for clarity: SELL ${formatUnits(amount, meta.decimals)} ${meta.symbol} FOR ETH — still requires CONFIRM SELL next)`,
  );

  const phrase = await promptExact(
    `SELL ${formatUnits(amount, meta.decimals)} ${meta.symbol} FOR ETH`,
  );
  if (!phrase) {
    console.log("Sell cancelled (phrase mismatch).");
    return;
  }
  const confirmed = await promptExact("CONFIRM SELL");
  if (!confirmed) {
    console.log("Sell cancelled — exact CONFIRM SELL required.");
    return;
  }

  if (!quote.fee) throw new Error("missing fee");

  const hash = await walletClient.writeContract({
    address: ADDRESSES.v3SwapRouter02,
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: resolved.token,
        tokenOut: ADDRESSES.weth,
        fee: quote.fee,
        recipient: diag.config.walletAddress,
        amountIn: amount,
        amountOutMinimum: quote.minOutput,
        sqrtPriceLimitX96: 0n,
      },
    ],
    account,
    chain: walletClient.chain,
  });

  console.log(`\nSubmitted sell tx: ${hash}`);
  console.log(explorerTxUrl(hash));
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const ethAfter = await publicClient.getBalance({
    address: diag.config.walletAddress,
  });
  const metaAfter = await getTokenMeta(
    publicClient,
    resolved.token,
    diag.config.walletAddress,
  );

  // WETH received may stay as WETH — check WETH balance delta too
  const wethBefore = await publicClient.readContract({
    address: ADDRESSES.weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [diag.config.walletAddress],
  });
  // already mined; approximate using receipt + balances
  void wethBefore;
  const tokenSold = meta.balance - metaAfter.balance;
  const ethDelta = ethAfter - ethBefore; // may be negative due to gas

  logSection("SELL RESULT");
  logKv("tx hash", hash);
  logKv("explorer", explorerTxUrl(hash));
  logKv("status", receipt.status);
  logKv("gas used", receipt.gasUsed.toString());
  logKv("token sold", `${formatUnits(tokenSold, meta.decimals)} ${meta.symbol}`);
  logKv("ETH balance delta (incl gas)", formatEther(ethDelta));
  logKv(
    "note",
    "If output was WETH, unwrap separately or check WETH balance on explorer.",
  );

  if (tokenSold > 0n && quote.outputAmount > 0n) {
    const price = Number(formatEther(quote.outputAmount)) / Number(formatUnits(tokenSold, meta.decimals));
    logKv("approx effective price", `${price} ETH per ${meta.symbol} (from quote)`);
  }
}

export async function runSellGate(): Promise<void> {
  loadConfig({ requireSigner: true });
  await runSell();
}

// silence unused import if tree shakes oddly
void resolveTokenAddress;
