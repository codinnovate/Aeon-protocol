import { type Address, parseAbi } from "viem";
import { ADDRESSES, type PublicClient, logKv } from "./config.js";
import { getErc20Allowance } from "./token.js";

/** Uniswap Permit2 AllowanceTransfer.allowance(owner, token, spender) */
export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export type Permit2Allowance = {
  amount: bigint;
  expiration: number;
  nonce: number;
  expired: boolean;
  spender: Address;
};

export async function getPermit2Allowance(
  client: PublicClient,
  owner: Address,
  token: Address,
  spender: Address,
): Promise<Permit2Allowance> {
  const [amount, expiration, nonce] = await client.readContract({
    address: ADDRESSES.permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender],
  });
  const now = Math.floor(Date.now() / 1000);
  return {
    amount,
    expiration: Number(expiration),
    nonce: Number(nonce),
    expired: Number(expiration) !== 0 && Number(expiration) < now,
    spender,
  };
}

export type AllowanceReport = {
  erc20ToPermit2: bigint;
  permit2ToRouter: Permit2Allowance;
  permit2ToPermit2Proxy: Permit2Allowance;
  permit2ToSwapRouter02: Permit2Allowance;
  requestedAmount: bigint;
  erc20EnoughForAmount: boolean;
  permit2RouterEnough: boolean;
  notes: string[];
};

export async function collectAllowanceReport(
  client: PublicClient,
  wallet: Address,
  token: Address,
  requestedAmount: bigint,
): Promise<AllowanceReport> {
  const notes: string[] = [];

  const [
    erc20ToPermit2,
    permit2ToRouter,
    permit2ToPermit2Proxy,
    permit2ToSwapRouter02,
  ] = await Promise.all([
    getErc20Allowance(client, token, wallet, ADDRESSES.permit2),
    getPermit2Allowance(
      client,
      wallet,
      token,
      ADDRESSES.universalRouterV2_1_1,
    ),
    getPermit2Allowance(client, wallet, token, ADDRESSES.permit2Proxy),
    getPermit2Allowance(client, wallet, token, ADDRESSES.v3SwapRouter02),
  ]);

  const erc20EnoughForAmount = erc20ToPermit2 >= requestedAmount;
  const permit2RouterEnough =
    !permit2ToRouter.expired && permit2ToRouter.amount >= requestedAmount;

  if (!erc20EnoughForAmount) {
    notes.push(
      "ERC20 allowance(wallet, Permit2) is insufficient for the requested amount.",
    );
  }
  if (!permit2RouterEnough) {
    notes.push(
      "Permit2 allowance(wallet, token, UniversalRouter 2.1.1) is insufficient or expired.",
    );
  }
  notes.push(
    "These are DISTINCT allowances: ERC20→Permit2 vs Permit2→spender. Do not confuse them.",
  );

  return {
    erc20ToPermit2,
    permit2ToRouter,
    permit2ToPermit2Proxy,
    permit2ToSwapRouter02,
    requestedAmount,
    erc20EnoughForAmount,
    permit2RouterEnough,
    notes,
  };
}

export function printAllowanceReport(report: AllowanceReport): void {
  logKv("ERC20 allowance → Permit2", report.erc20ToPermit2.toString());
  logKv(
    "Permit2 → UR 2.1.1 amount",
    report.permit2ToRouter.amount.toString(),
  );
  logKv(
    "Permit2 → UR 2.1.1 expiration",
    report.permit2ToRouter.expiration === 0
      ? "0 (unset/expired semantics)"
      : `${report.permit2ToRouter.expiration} (unix)${report.permit2ToRouter.expired ? " EXPIRED" : ""}`,
  );
  logKv("Permit2 → UR 2.1.1 nonce", report.permit2ToRouter.nonce);
  logKv(
    "Permit2 → Permit2Proxy amount",
    report.permit2ToPermit2Proxy.amount.toString(),
  );
  logKv(
    "Permit2 → Permit2Proxy exp",
    report.permit2ToPermit2Proxy.expiration,
  );
  logKv(
    "Permit2 → SwapRouter02 amount",
    report.permit2ToSwapRouter02.amount.toString(),
  );
  logKv("requested amount", report.requestedAmount.toString());
  logKv("ERC20→Permit2 enough?", report.erc20EnoughForAmount);
  logKv("Permit2→UR enough?", report.permit2RouterEnough);
  for (const n of report.notes) console.log(`  note: ${n}`);
}
