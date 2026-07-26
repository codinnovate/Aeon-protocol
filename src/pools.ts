import {
  type Address,
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
} from "viem";
import {
  ADDRESSES,
  EXPLORER_API,
  type PublicClient,
  V3_FEE_TIERS,
  logKv,
  logSection,
} from "./config.js";

const v2FactoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
]);

const v2PairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const v3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

const erc20MetaAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

export type V2PoolInfo = {
  pair: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  quoteToken: Address;
  meaningful: boolean;
};

export type V3PoolInfo = {
  pool: Address;
  fee: number;
  token0: Address;
  token1: Address;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  token0Balance: bigint;
  token1Balance: bigint;
  quoteToken: Address;
  meaningful: boolean;
};

export type PoolDiscovery = {
  v2: V2PoolInfo[];
  v3: V3PoolInfo[];
  recentSells: {
    found: boolean;
    count: number;
    samples: { txHash: string; from: string; timestamp?: string }[];
    interpretation: string;
  };
};

async function readErc20Bal(
  client: PublicClient,
  token: Address,
  holder: Address,
): Promise<bigint> {
  try {
    return await client.readContract({
      address: token,
      abi: erc20MetaAbi,
      functionName: "balanceOf",
      args: [holder],
    });
  } catch {
    return 0n;
  }
}

export async function discoverV2Pools(
  client: PublicClient,
  token: Address,
): Promise<V2PoolInfo[]> {
  const quotes = [ADDRESSES.weth, ADDRESSES.usdg];
  const out: V2PoolInfo[] = [];

  for (const quote of quotes) {
    try {
      const pair = await client.readContract({
        address: ADDRESSES.v2Factory,
        abi: v2FactoryAbi,
        functionName: "getPair",
        args: [token, quote],
      });
      if (pair === "0x0000000000000000000000000000000000000000") continue;
      const [token0, token1, reserves] = await Promise.all([
        client.readContract({
          address: pair,
          abi: v2PairAbi,
          functionName: "token0",
        }),
        client.readContract({
          address: pair,
          abi: v2PairAbi,
          functionName: "token1",
        }),
        client.readContract({
          address: pair,
          abi: v2PairAbi,
          functionName: "getReserves",
        }),
      ]);
      const [reserve0, reserve1] = reserves;
      const wethSide =
        getAddress(token0) === getAddress(ADDRESSES.weth)
          ? reserve0
          : getAddress(token1) === getAddress(ADDRESSES.weth)
            ? reserve1
            : 0n;
      const meaningful =
        reserve0 > 0n &&
        reserve1 > 0n &&
        (quote === ADDRESSES.weth ? wethSide > 10n ** 14n : reserve0 + reserve1 > 0n);
      out.push({
        pair: getAddress(pair),
        token0: getAddress(token0),
        token1: getAddress(token1),
        reserve0,
        reserve1,
        quoteToken: getAddress(quote),
        meaningful,
      });
    } catch {
      /* pair missing / call failed */
    }
  }
  return out;
}

export async function discoverV3Pools(
  client: PublicClient,
  token: Address,
): Promise<V3PoolInfo[]> {
  const quotes = [ADDRESSES.weth, ADDRESSES.usdg];
  const out: V3PoolInfo[] = [];

  for (const quote of quotes) {
    for (const fee of V3_FEE_TIERS) {
      try {
        const pool = await client.readContract({
          address: ADDRESSES.v3Factory,
          abi: v3FactoryAbi,
          functionName: "getPool",
          args: [token, quote, fee],
        });
        if (pool === "0x0000000000000000000000000000000000000000") continue;

        const [token0, token1, liquidity, slot0] = await Promise.all([
          client.readContract({
            address: pool,
            abi: v3PoolAbi,
            functionName: "token0",
          }),
          client.readContract({
            address: pool,
            abi: v3PoolAbi,
            functionName: "token1",
          }),
          client.readContract({
            address: pool,
            abi: v3PoolAbi,
            functionName: "liquidity",
          }),
          client.readContract({
            address: pool,
            abi: v3PoolAbi,
            functionName: "slot0",
          }),
        ]);

        const t0 = getAddress(token0);
        const t1 = getAddress(token1);
        const [token0Balance, token1Balance] = await Promise.all([
          readErc20Bal(client, t0, getAddress(pool)),
          readErc20Bal(client, t1, getAddress(pool)),
        ]);

        const wethBal =
          t0 === getAddress(ADDRESSES.weth)
            ? token0Balance
            : t1 === getAddress(ADDRESSES.weth)
              ? token1Balance
              : 0n;

        out.push({
          pool: getAddress(pool),
          fee,
          token0: t0,
          token1: t1,
          liquidity,
          sqrtPriceX96: slot0[0],
          tick: slot0[1],
          token0Balance,
          token1Balance,
          quoteToken: getAddress(quote),
          meaningful: liquidity > 0n && (quote !== ADDRESSES.weth || wethBal > 10n ** 14n),
        });
      } catch {
        /* no pool */
      }
    }
  }
  return out;
}

/**
 * Look for recent token transfers that look like sells (token leaving unrelated wallets
 * into a known router/pool). Heuristic via Blockscout token transfer feed.
 */
export async function findRecentSells(
  token: Address,
  wallet: Address,
): Promise<PoolDiscovery["recentSells"]> {
  const samples: PoolDiscovery["recentSells"]["samples"] = [];
  try {
    const url = `${EXPLORER_API}/tokens/${token}/transfers?type=token_transfer`;
    const res = await fetch(url);
    if (!res.ok) {
      return {
        found: false,
        count: 0,
        samples: [],
        interpretation:
          "Could not fetch recent transfers from explorer — sellability inconclusive from history.",
      };
    }
    const body = (await res.json()) as {
      items?: {
        tx_hash?: string;
        from?: { hash?: string };
        to?: { hash?: string };
        timestamp?: string;
        total?: { value?: string };
      }[];
    };

    const routerLike = new Set(
      [
        ADDRESSES.universalRouterV2_1_1,
        ADDRESSES.universalRouterV2_0,
        ADDRESSES.v3SwapRouter02,
        ADDRESSES.v2Router,
        ADDRESSES.legacySwapRouter,
        ADDRESSES.permit2Proxy,
        ADDRESSES.weth,
      ].map((a) => a.toLowerCase()),
    );

    const walletLc = wallet.toLowerCase();
    for (const item of body.items ?? []) {
      const from = item.from?.hash?.toLowerCase();
      const to = item.to?.hash?.toLowerCase();
      if (!from || !to) continue;
      if (from === walletLc) continue;
      // token leaving an EOA/contract into router/pool-ish destination
      if (routerLike.has(to) || routerLike.has(from)) {
        samples.push({
          txHash: item.tx_hash ?? "unknown",
          from: item.from?.hash ?? "unknown",
          timestamp: item.timestamp,
        });
      }
      if (samples.length >= 8) break;
    }

    // Also count transfers from non-wallet addresses with non-zero value as weak sell signals
    const unrelatedOut = (body.items ?? []).filter((i) => {
      const from = i.from?.hash?.toLowerCase();
      return from && from !== walletLc && from !== token.toLowerCase();
    });

    if (samples.length > 0) {
      return {
        found: true,
        count: samples.length,
        samples,
        interpretation:
          "Recent transfers involving known routers/pools from OTHER wallets found — token is likely sellable; failure may be approval/route-specific.",
      };
    }
    if (unrelatedOut.length > 3) {
      return {
        found: true,
        count: unrelatedOut.length,
        samples: unrelatedOut.slice(0, 5).map((i) => ({
          txHash: i.tx_hash ?? "unknown",
          from: i.from?.hash ?? "unknown",
          timestamp: i.timestamp,
        })),
        interpretation:
          "Unrelated wallets have transferred this token recently. Not definitive sells, but activity exists.",
      };
    }
    return {
      found: false,
      count: 0,
      samples: [],
      interpretation:
        "No clear recent sells by unrelated wallets found via explorer heuristic — possible honeypot/restriction OR simply low activity. Rely on simulation.",
    };
  } catch (e) {
    return {
      found: false,
      count: 0,
      samples: [],
      interpretation: `Transfer history lookup failed: ${e instanceof Error ? e.message : e}`,
    };
  }
}

export async function discoverPools(
  client: PublicClient,
  token: Address,
  wallet: Address,
): Promise<PoolDiscovery> {
  const [v2, v3, recentSells] = await Promise.all([
    discoverV2Pools(client, token),
    discoverV3Pools(client, token),
    findRecentSells(token, wallet),
  ]);
  return { v2, v3, recentSells };
}

export function printPoolDiscovery(d: PoolDiscovery): void {
  logSection("POOL DISCOVERY (on-chain verified factories)");
  logKv("V2 factory", ADDRESSES.v2Factory);
  logKv("V3 factory", ADDRESSES.v3Factory);
  logKv("WETH", ADDRESSES.weth);
  logKv("USDG", ADDRESSES.usdg);

  if (!d.v2.length) console.log("\n  No V2 pairs found for token/WETH or token/USDG.");
  for (const p of d.v2) {
    console.log(`\n  [V2] ${p.pair}`);
    logKv("quote", p.quoteToken === ADDRESSES.weth ? "WETH" : "USDG");
    logKv("token0", p.token0);
    logKv("token1", p.token1);
    logKv("reserve0", p.reserve0.toString());
    logKv("reserve1", p.reserve1.toString());
    if (p.quoteToken === ADDRESSES.weth) {
      const wethRes =
        p.token0 === ADDRESSES.weth ? p.reserve0 : p.reserve1;
      logKv("WETH reserve", formatEther(wethRes));
    }
    logKv("meaningful liquidity", p.meaningful);
  }

  if (!d.v3.length) console.log("\n  No V3 pools found for token/WETH or token/USDG.");
  for (const p of d.v3) {
    console.log(`\n  [V3] ${p.pool} fee=${p.fee}`);
    logKv("quote", p.quoteToken === ADDRESSES.weth ? "WETH" : "USDG");
    logKv("token0", p.token0);
    logKv("token1", p.token1);
    logKv("liquidity", p.liquidity.toString());
    logKv("tick", p.tick);
    logKv("token0 balance", p.token0Balance.toString());
    logKv("token1 balance", p.token1Balance.toString());
    if (p.token0 === ADDRESSES.weth || p.token1 === ADDRESSES.weth) {
      const wethBal =
        p.token0 === ADDRESSES.weth ? p.token0Balance : p.token1Balance;
      logKv("WETH in pool", formatEther(wethBal));
    }
    logKv("meaningful liquidity", p.meaningful);
  }

  console.log("\n  Recent sell activity heuristic:");
  logKv("found", d.recentSells.found);
  logKv("sample count", d.recentSells.count);
  logKv("interpretation", d.recentSells.interpretation);
  for (const s of d.recentSells.samples) {
    console.log(`    - tx=${s.txHash} from=${s.from} at=${s.timestamp ?? "?"}`);
  }
}

export async function symbolOf(
  client: PublicClient,
  token: Address,
): Promise<string> {
  try {
    return await client.readContract({
      address: token,
      abi: erc20MetaAbi,
      functionName: "symbol",
    });
  } catch {
    return token.slice(0, 8);
  }
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals);
}
