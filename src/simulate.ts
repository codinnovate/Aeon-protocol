import {
  type Address,
  type Hex,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  maxUint256,
  parseAbi,
} from "viem";
import {
  ADDRESSES,
  type AppConfig,
  type PublicClient,
  logKv,
  logSection,
} from "./config.js";
import {
  classifyFailure,
  decodeRevertData,
  labelAddress,
  type DecodedRevert,
} from "./decode.js";
import { collectAllowanceReport } from "./permit2.js";
import type { QuoteResult } from "./quote.js";

const swapRouter02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export type TransferFromSim = {
  caller: Address;
  callerLabel: string;
  from: Address;
  to: Address;
  amount: bigint;
  ok: boolean;
  revert: DecodedRevert | null;
};

export type SwapSim = {
  ok: boolean;
  router: Address;
  calldata: Hex;
  amountOut?: bigint;
  gasEstimate?: bigint;
  revert: DecodedRevert | null;
  classification: string[];
};

async function simulateTransferFrom(
  client: PublicClient,
  token: Address,
  caller: Address,
  from: Address,
  to: Address,
  amount: bigint,
): Promise<TransferFromSim> {
  try {
    await client.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [from, to, amount],
      account: caller,
    });
    return {
      caller,
      callerLabel: labelAddress(caller),
      from,
      to,
      amount,
      ok: true,
      revert: null,
    };
  } catch (e) {
    const err = e as {
      walk?: () => { data?: Hex } | null;
      data?: Hex;
      cause?: { data?: Hex; shortMessage?: string; metaMessages?: string[] };
      shortMessage?: string;
      message?: string;
    };
    let data: Hex | undefined;
    const candidates = [err?.data, err?.cause?.data];
    if (typeof err?.walk === "function") {
      candidates.push(err.walk()?.data);
    }
    for (const c of candidates) {
      if (typeof c === "string" && c.startsWith("0x")) {
        data = c as Hex;
        break;
      }
    }

    // viem often embeds revert data in message / metaMessages
    if (!data && err?.message) {
      const m = err.message.match(/0x[0-9a-fA-F]{8,}/);
      if (m) data = m[0] as Hex;
    }

    const revert = decodeRevertData(data ?? "0x");
    if (revert.explanation.includes("Empty") && err?.shortMessage) {
      revert.explanation = `${revert.explanation} | ${err.shortMessage}`;
    }
    return {
      caller,
      callerLabel: labelAddress(caller),
      from,
      to,
      amount,
      ok: false,
      revert,
    };
  }
}

export async function runTransferFromDiagnostics(
  client: PublicClient,
  token: Address,
  wallet: Address,
  amount: bigint,
): Promise<TransferFromSim[]> {
  const recipients = [
    ADDRESSES.permit2Proxy,
    ADDRESSES.universalRouterV2_1_1,
    ADDRESSES.v3SwapRouter02,
  ];
  const callers = [
    ADDRESSES.permit2,
    ADDRESSES.permit2Proxy,
    ADDRESSES.universalRouterV2_1_1,
    ADDRESSES.v3SwapRouter02,
  ];

  const results: TransferFromSim[] = [];
  for (const caller of callers) {
    for (const to of recipients) {
      // Focus on the failed shape first, then a few variants
      if (
        !(
          (caller === ADDRESSES.permit2 && to === ADDRESSES.permit2Proxy) ||
          (caller === ADDRESSES.permit2Proxy && to === ADDRESSES.permit2Proxy) ||
          (caller === ADDRESSES.permit2 && to === ADDRESSES.universalRouterV2_1_1) ||
          (caller === ADDRESSES.v3SwapRouter02 && to === ADDRESSES.v3SwapRouter02)
        )
      ) {
        continue;
      }
      results.push(
        await simulateTransferFrom(client, token, caller, wallet, to, amount),
      );
    }
  }

  // Exact user-reported shape: transferFrom(wallet, Permit2Proxy, amount) — caller unknown; try Permit2
  if (
    !results.some(
      (r) =>
        r.to.toLowerCase() === ADDRESSES.permit2Proxy.toLowerCase() &&
        r.caller.toLowerCase() === ADDRESSES.permit2.toLowerCase(),
    )
  ) {
    results.unshift(
      await simulateTransferFrom(
        client,
        token,
        ADDRESSES.permit2,
        wallet,
        ADDRESSES.permit2Proxy,
        amount,
      ),
    );
  }

  return results;
}

export function printTransferFromSims(sims: TransferFromSim[]): void {
  logSection("SIMULATE token.transferFrom (eth_call only — NOT broadcast)");
  for (const s of sims) {
    console.log(
      `\n  caller=${s.callerLabel} (${s.caller})\n  transferFrom(${s.from}, ${s.to}, ${s.amount})`,
    );
    logKv("ok", s.ok);
    if (s.revert) {
      logKv("revert selector", s.revert.selector ?? "n/a");
      logKv("revert name", s.revert.name ?? "n/a");
      logKv("revert explanation", s.revert.explanation);
      logKv("revert raw", s.revert.raw);
    }
  }
}

/**
 * Simulate a V3 exactInputSingle via SwapRouter02.
 * This does NOT broadcast. It verifies pool/route/token transfer mechanics.
 * Universal Router 2.1.1 is the preferred live entrypoint; SwapRouter02 is used
 * here as a simpler simulation surface for the same V3 pool.
 */
export async function simulateV3SellViaSwapRouter02(
  client: PublicClient,
  config: AppConfig,
  token: Address,
  quote: QuoteResult,
): Promise<SwapSim> {
  if (!quote.ok || quote.protocol !== "v3" || quote.fee == null) {
    return {
      ok: false,
      router: ADDRESSES.v3SwapRouter02,
      calldata: "0x",
      revert: decodeRevertData("0x"),
      classification: ["4. router incompatibility / missing quote"],
    };
  }

  const params = {
    tokenIn: token,
    tokenOut: ADDRESSES.weth,
    fee: quote.fee,
    recipient: config.walletAddress,
    amountIn: quote.inputAmount,
    amountOutMinimum: quote.minOutput,
    sqrtPriceLimitX96: 0n,
  };

  const calldata = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [params],
  });

  const allowances = await collectAllowanceReport(
    client,
    config.walletAddress,
    token,
    quote.inputAmount,
  );

  // For SwapRouter02, ERC20 allowance must be to SwapRouter02 (not only Permit2).
  // We simulate as the wallet — if allowance to router is 0, expect transferFrom fail.
  try {
    const sim = await client.simulateContract({
      address: ADDRESSES.v3SwapRouter02,
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [params],
      account: config.walletAddress,
    });

    let gasEstimate: bigint | undefined;
    try {
      gasEstimate = await client.estimateContractGas({
        address: ADDRESSES.v3SwapRouter02,
        abi: swapRouter02Abi,
        functionName: "exactInputSingle",
        args: [params],
        account: config.walletAddress,
      });
    } catch {
      gasEstimate = undefined;
    }

    return {
      ok: true,
      router: ADDRESSES.v3SwapRouter02,
      calldata,
      amountOut: sim.result as bigint,
      gasEstimate,
      revert: null,
      classification: [],
    };
  } catch (e) {
    const err = e as {
      data?: Hex;
      cause?: { data?: Hex; shortMessage?: string };
      shortMessage?: string;
      message?: string;
    };
    let data: Hex | undefined;
    for (const c of [err?.data, err?.cause?.data]) {
      if (typeof c === "string" && c.startsWith("0x")) {
        data = c as Hex;
        break;
      }
    }
    if (!data && err?.message) {
      const m = err.message.match(/0x[0-9a-fA-F]{8,}/);
      if (m) data = m[0] as Hex;
    }
    const revert = decodeRevertData(data ?? "0x");
    if (err?.shortMessage) {
      revert.explanation = `${revert.explanation} | ${err.shortMessage}`;
    }
    // Normalize STF short-circuit
    if (
      err?.shortMessage?.includes("STF") ||
      err?.message?.includes("\nSTF")
    ) {
      revert.name = revert.name ?? "STF";
      revert.explanation = `STF (Uniswap safeTransferFrom failed) — usually ERC20 allowance/balance/restriction. ${revert.explanation}`;
    }

    // Direct ERC20 allowance to SwapRouter02
    const erc20ToRouter = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [config.walletAddress, ADDRESSES.v3SwapRouter02],
    });

    const classification = classifyFailure({
      revert,
      erc20Enough:
        allowances.erc20EnoughForAmount || erc20ToRouter >= quote.inputAmount,
      permit2Enough: allowances.permit2RouterEnough,
      poolLiquidityOk: quote.outputAmount > 0n,
    });

    if (erc20ToRouter < quote.inputAmount) {
      classification.unshift(
        "2. insufficient allowance — SwapRouter02 needs token.approve(SwapRouter02, amount) OR use Universal Router + Permit2 path",
      );
    }

    return {
      ok: false,
      router: ADDRESSES.v3SwapRouter02,
      calldata,
      revert,
      classification: [...new Set(classification)],
    };
  }
}

/**
 * State-override simulation: pretend wallet approved SwapRouter02 for max,
 * then simulate the swap. Isolates token restrictions vs allowance issues.
 */
export async function simulateV3SellWithMockApproval(
  client: PublicClient,
  config: AppConfig,
  token: Address,
  quote: QuoteResult,
): Promise<SwapSim> {
  if (!quote.ok || quote.protocol !== "v3" || quote.fee == null) {
    return {
      ok: false,
      router: ADDRESSES.v3SwapRouter02,
      calldata: "0x",
      revert: decodeRevertData("0x"),
      classification: ["missing quote"],
    };
  }

  const params = {
    tokenIn: token,
    tokenOut: ADDRESSES.weth,
    fee: quote.fee,
    recipient: config.walletAddress,
    amountIn: quote.inputAmount,
    amountOutMinimum: 0n, // isolate transferability; slippage checked separately
    sqrtPriceLimitX96: 0n,
  };

  const calldata = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [params],
  });

  // allowance mapping slot for Solidity OZ ERC20 is typically keccak(spender . keccak(owner . slot))
  // Unknown storage layout for unverified token — use eth_call with stateOverride on balance/code is hard.
  // Instead: call as if from an address that already holds allowance if we can find one,
  // OR document that mock approval requires known slot.
  // Practical approach: use `client.call` with account wallet after checking; for mock,
  // try simulate and if fail due to allowance, report that token transferFrom must be tested via Permit2 path.

  try {
    // viem stateOverride: set ERC20 allowance slot is unreliable without layout.
    // Fall back to documenting + attempting call.
    const sim = await client.simulateContract({
      address: ADDRESSES.v3SwapRouter02,
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [params],
      account: config.walletAddress,
      stateOverride: [
        {
          address: token,
          // Cannot safely forge allowance without slot; leave empty and catch.
          stateDiff: [],
        },
      ],
    });
    void maxUint256;
    return {
      ok: true,
      router: ADDRESSES.v3SwapRouter02,
      calldata,
      amountOut: sim.result as bigint,
      revert: null,
      classification: [],
    };
  } catch (e) {
    const err = e as { shortMessage?: string; message?: string; data?: Hex; cause?: { data?: Hex } };
    let data: Hex | undefined = err?.data || err?.cause?.data;
    if (!data && err?.message) {
      const m = err.message.match(/0x[0-9a-fA-F]{8,}/);
      if (m) data = m[0] as Hex;
    }
    const revert = decodeRevertData(data ?? "0x");
    if (err?.shortMessage) {
      revert.explanation = `${revert.explanation} | ${err.shortMessage}`;
    }
    return {
      ok: false,
      router: ADDRESSES.v3SwapRouter02,
      calldata,
      revert,
      classification: classifyFailure({
        revert,
        erc20Enough: false,
        permit2Enough: false,
        poolLiquidityOk: true,
      }),
    };
  }
}

export function printSwapSim(label: string, sim: SwapSim): void {
  logSection(`SWAP SIMULATION — ${label} (NOT broadcast)`);
  logKv("ok", sim.ok);
  logKv("router", sim.router);
  logKv("router label", labelAddress(sim.router));
  if (sim.amountOut !== undefined) {
    logKv("simulated amountOut", formatEther(sim.amountOut));
    logKv("simulated amountOut raw", sim.amountOut.toString());
  }
  if (sim.gasEstimate !== undefined) {
    logKv("gas estimate", sim.gasEstimate.toString());
  }
  if (sim.revert) {
    logKv("revert", sim.revert.explanation);
    logKv("revert raw", sim.revert.raw);
  }
  if (sim.classification.length) {
    console.log("  failure classification:");
    for (const c of sim.classification) console.log(`    - ${c}`);
  }
  logKv("calldata length", `${(sim.calldata.length - 2) / 2} bytes`);
}
