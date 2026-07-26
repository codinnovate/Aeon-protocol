import {
  type Address,
  type Hex,
  decodeErrorResult,
  decodeFunctionData,
  erc20Abi,
  formatEther,
  getAddress,
  hexToString,
  isHex,
  parseAbi,
  slice,
} from "viem";
import { ADDRESSES, EXPLORER_API, EXPLORER_URL } from "./config.js";

const knownErrors = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
  "error TransferFromFailed()",
  "error STF()",
  "error TRANSFER_FROM_FAILED()",
  "error InsufficientAllowance()",
  "error InsufficientBalance()",
  "error AllowanceExpired(uint256)",
  "error InsufficientAllowance(uint256 amount)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidSpender(address spender)",
  "error ERC20InvalidReceiver(address receiver)",
]);

const KNOWN_LABELS: Record<string, string> = {
  [ADDRESSES.permit2.toLowerCase()]: "Permit2",
  [ADDRESSES.permit2Proxy.toLowerCase()]: "Permit2Proxy",
  [ADDRESSES.universalRouterV2_1_1.toLowerCase()]: "UniversalRouter v2.1.1",
  [ADDRESSES.universalRouterV2_0.toLowerCase()]: "UniversalRouter v2.0",
  [ADDRESSES.v3SwapRouter02.toLowerCase()]: "SwapRouter02",
  [ADDRESSES.legacySwapRouter.toLowerCase()]: "Legacy SwapRouter",
  [ADDRESSES.weth.toLowerCase()]: "WETH",
  [ADDRESSES.v3Factory.toLowerCase()]: "UniswapV3Factory",
  [ADDRESSES.v2Factory.toLowerCase()]: "UniswapV2Factory",
  [ADDRESSES.v2Router.toLowerCase()]: "UniswapV2Router02",
};

export function labelAddress(address: Address | string): string {
  const key = address.toLowerCase();
  return KNOWN_LABELS[key] ?? address;
}

export type DecodedRevert = {
  raw: Hex;
  selector: Hex | null;
  name: string | null;
  args: unknown[] | null;
  explanation: string;
};

export function decodeRevertData(data: Hex | undefined | null): DecodedRevert {
  if (!data || data === "0x") {
    return {
      raw: "0x",
      selector: null,
      name: null,
      args: null,
      explanation: "Empty revert data (generic revert / assert).",
    };
  }

  const selector = data.length >= 10 ? (slice(data, 0, 4) as Hex) : null;

  // Common string-encoded TransferFromFailed / TRANSFER_FROM_FAILED
  try {
    const decoded = decodeErrorResult({ abi: knownErrors, data });
    return {
      raw: data,
      selector,
      name: decoded.errorName,
      args: (decoded.args ? [...decoded.args] : null) as unknown[] | null,
      explanation: `Decoded error ${decoded.errorName}(${(decoded.args ?? [])
        .map(String)
        .join(", ")})`,
    };
  } catch {
    // fall through
  }

  // Solidity Error(string) sometimes not matched — try manual string extract
  if (selector === "0x08c379a0") {
    try {
      // ABI-encoded string after selector
      const str = hexToString(`0x${data.slice(138)}`.replace(/00+$/, "") as Hex);
      return {
        raw: data,
        selector,
        name: "Error",
        args: [str],
        explanation: `Error(string): ${str}`,
      };
    } catch {
      /* ignore */
    }
  }

  // Custom error selector dictionary for Uniswap / Permit2 / OZ
  const SELECTORS: Record<string, string> = {
    "0x7939f424": "TransferFromFailed()",
    "0x3b99b53d": "STF() (Uniswap: safeTransferFrom failed)",
    "0xd81b2f2e": "AllowanceExpired(uint256)",
    "0xd4e0f5a3": "InsufficientPermit2Allowance-like",
    "0xfb8f41b2": "ERC20InsufficientAllowance(address,uint256,uint256)",
    "0xe450d38c": "ERC20InsufficientBalance(address,uint256,uint256)",
    "0x2ce93b59": "MaxWalletExceeded()",
  };
  if (selector && SELECTORS[selector]) {
    return {
      raw: data,
      selector,
      name: SELECTORS[selector],
      args: null,
      explanation: SELECTORS[selector],
    };
  }

  return {
    raw: data,
    selector,
    name: null,
    args: null,
    explanation: `Unrecognized revert data ${data}`,
  };
}

export function classifyFailure(opts: {
  revert: DecodedRevert;
  erc20Enough: boolean;
  permit2Enough: boolean;
  poolLiquidityOk: boolean | null;
}): string[] {
  const reasons: string[] = [];
  const blob = `${opts.revert.name ?? ""} ${opts.revert.explanation} ${opts.revert.raw}`.toUpperCase();

  if (blob.includes("TRANSFER_FROM_FAILED") || blob.includes("TRANSFERFROMFAILED") || blob.includes("STF")) {
    if (!opts.erc20Enough) {
      reasons.push("2. insufficient ERC20 allowance (token → Permit2 or spender)");
    } else if (!opts.permit2Enough) {
      reasons.push("3. Permit2 allowance insufficient/expired for router spender");
    } else {
      reasons.push(
        "1/9. token restriction or non-standard transferFrom (blacklist/tax/trading gate/custom logic) — allowance appears present",
      );
    }
  }
  if (!opts.erc20Enough) reasons.push("2. insufficient allowance");
  if (!opts.permit2Enough) reasons.push("3. Permit2 allowance");
  if (opts.poolLiquidityOk === false) reasons.push("5. liquidity");
  if (blob.includes("SPLIPPAGE") || blob.includes("TOO LITTLE") || blob.includes("STF")) {
    /* keep generic */
  }
  if (reasons.length === 0) reasons.push("10. something else — see revert decode above");
  return [...new Set(reasons)];
}

export type TraceInsight = {
  txHash: string | null;
  summary: string[];
  failedCall?: {
    from?: string;
    to?: string;
    toLabel?: string;
    functionName?: string;
    error?: string;
  };
};

/**
 * Best-effort decode of a failed transaction via Blockscout APIs.
 * Pass FAILED_TX_HASH in env to analyze a specific hash.
 */
export async function analyzeFailedTransaction(
  txHash?: string,
): Promise<TraceInsight> {
  const hash = txHash || process.env.FAILED_TX_HASH?.trim();
  if (!hash || !isHex(hash as Hex)) {
    return {
      txHash: null,
      summary: [
        "No FAILED_TX_HASH provided. Based on the call details you supplied:",
        `  ERC20.transferFrom(wallet, ${ADDRESSES.permit2Proxy}, amount)`,
        `  Recipient ${labelAddress(ADDRESSES.permit2Proxy)} is Permit2Proxy.`,
        "  Revert: TRANSFER_FROM_FAILED — the token's transferFrom reverted while Permit2/Permit2Proxy pulled tokens.",
        "  Note: address 0xE132… is a UniswapV3Pool; the ERC-20 that reverted is 0x31FF… (AEON).",
        `  Explorer search tip: ${EXPLORER_URL}`,
      ],
    };
  }

  const summary: string[] = [`Analyzing tx ${hash}`];
  try {
    const res = await fetch(`${EXPLORER_API}/transactions/${hash}`);
    if (!res.ok) {
      summary.push(`Blockscout tx fetch failed: HTTP ${res.status}`);
      return { txHash: hash, summary };
    }
    const tx = (await res.json()) as {
      status?: string;
      revert_reason?: string | null;
      to?: { hash?: string } | string | null;
      method?: string | null;
      decoded_input?: { method_call?: string; parameters?: unknown } | null;
      transaction_types?: string[];
    };
    summary.push(`status: ${tx.status}`);
    summary.push(`method: ${tx.method ?? "unknown"}`);
    summary.push(`revert_reason: ${tx.revert_reason ?? "n/a"}`);
    if (tx.decoded_input?.method_call) {
      summary.push(`decoded: ${tx.decoded_input.method_call}`);
    }

    // Try internal txs / logs for the transferFrom frame
    const intRes = await fetch(
      `${EXPLORER_API}/transactions/${hash}/internal-transactions`,
    );
    let failedCall: TraceInsight["failedCall"];
    if (intRes.ok) {
      const body = (await intRes.json()) as {
        items?: {
          success?: boolean;
          error?: string | null;
          to?: { hash?: string } | string;
          from?: { hash?: string } | string;
          type?: string;
        }[];
      };
      const failed = (body.items ?? []).find((i) => i.success === false);
      if (failed) {
        const to =
          typeof failed.to === "string" ? failed.to : failed.to?.hash;
        failedCall = {
          from:
            typeof failed.from === "string" ? failed.from : failed.from?.hash,
          to,
          toLabel: to ? labelAddress(to) : undefined,
          error: failed.error ?? undefined,
        };
        summary.push(
          `First failed internal call → ${failedCall.toLabel ?? failedCall.to}: ${failedCall.error ?? "unknown"}`,
        );
      }
    }

    return { txHash: hash, summary, failedCall };
  } catch (e) {
    summary.push(`Trace analysis error: ${e instanceof Error ? e.message : e}`);
    return { txHash: hash, summary };
  }
}

export function tryDecodeErc20Call(data: Hex): string | null {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    return `${decoded.functionName}(${(decoded.args ?? []).map(String).join(", ")})`;
  } catch {
    return null;
  }
}

export function formatEth(wei: bigint): string {
  return `${formatEther(wei)} ETH`;
}

export function shortAddr(address: Address): string {
  const a = getAddress(address);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
