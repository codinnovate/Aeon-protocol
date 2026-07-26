import {
  type Address,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
} from "viem";
import {
  ADDRESSES,
  type AppConfig,
  type PublicClient,
  logKv,
  logSection,
} from "./config.js";
import { discoverPools, type PoolDiscovery, type V3PoolInfo } from "./pools.js";

const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const v2RouterAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);

export type QuoteResult = {
  ok: boolean;
  protocol: "v3" | "v2" | "none";
  inputToken: Address;
  outputToken: Address;
  inputAmount: bigint;
  outputAmount: bigint;
  minOutput: bigint;
  fee?: number;
  pool?: Address;
  route: string;
  router: Address;
  permit2Required: boolean;
  gasEstimate: bigint | null;
  error?: string;
};

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

async function quoteV3ExactIn(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  amountIn: bigint,
): Promise<{ amountOut: bigint; gasEstimate: bigint } | null> {
  try {
    // QuoterV2 uses a revert-based return; viem simulate/call handles via eth_call
    const data = encodeFunctionData({
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const res = await client.call({
      to: ADDRESSES.v3QuoterV2,
      data,
    });
    if (!res.data || res.data === "0x") return null;
    // Manual decode: amountOut (uint256), sqrtPriceX96After (uint160), ticks (uint32), gasEstimate (uint256)
    const raw = res.data.slice(2);
    if (raw.length < 256) return null;
    const amountOut = BigInt(`0x${raw.slice(0, 64)}`);
    const gasEstimate = BigInt(`0x${raw.slice(192, 256)}`);
    return { amountOut, gasEstimate };
  } catch (e) {
    // Some nodes return revert data for Quoter — try simulateContract
    try {
      const sim = await client.simulateContract({
        address: ADDRESSES.v3QuoterV2,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const [amountOut, , , gasEstimate] = sim.result as unknown as [
        bigint,
        bigint,
        number,
        bigint,
      ];
      return { amountOut, gasEstimate };
    } catch (e2) {
      void e;
      void e2;
      return null;
    }
  }
}

async function quoteV2ExactIn(
  client: PublicClient,
  amountIn: bigint,
  path: Address[],
): Promise<bigint | null> {
  try {
    const amounts = await client.readContract({
      address: ADDRESSES.v2Router,
      abi: v2RouterAbi,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    });
    return amounts[amounts.length - 1] ?? null;
  } catch {
    return null;
  }
}

function bestV3Pool(
  pools: V3PoolInfo[],
  quoteToken: Address,
): V3PoolInfo | null {
  const candidates = pools
    .filter((p) => getAddress(p.quoteToken) === getAddress(quoteToken))
    .filter((p) => p.meaningful)
    .sort((a, b) => {
      const aW =
        a.token0 === ADDRESSES.weth
          ? a.token0Balance
          : a.token1 === ADDRESSES.weth
            ? a.token1Balance
            : a.liquidity;
      const bW =
        b.token0 === ADDRESSES.weth
          ? b.token0Balance
          : b.token1 === ADDRESSES.weth
            ? b.token1Balance
            : b.liquidity;
      return aW === bW ? 0 : aW > bW ? -1 : 1;
    });
  return candidates[0] ?? null;
}

export async function quoteTokenToEth(
  client: PublicClient,
  config: AppConfig,
  token: Address,
  amountIn: bigint,
  discovery?: PoolDiscovery,
): Promise<QuoteResult> {
  const pools = discovery ?? (await discoverPools(client, token, config.walletAddress));
  const v3 = bestV3Pool(pools.v3, ADDRESSES.weth);

  if (v3) {
    const q = await quoteV3ExactIn(
      client,
      token,
      ADDRESSES.weth,
      v3.fee,
      amountIn,
    );
    if (q && q.amountOut > 0n) {
      return {
        ok: true,
        protocol: "v3",
        inputToken: token,
        outputToken: ADDRESSES.weth,
        inputAmount: amountIn,
        outputAmount: q.amountOut,
        minOutput: applySlippage(q.amountOut, config.slippageBps),
        fee: v3.fee,
        pool: v3.pool,
        route: `${token} --v3(${v3.fee})--> WETH (unwrap to ETH)`,
        router: ADDRESSES.universalRouterV2_1_1,
        permit2Required: true,
        gasEstimate: q.gasEstimate,
      };
    }
  }

  const v2 = pools.v2.find(
    (p) => getAddress(p.quoteToken) === getAddress(ADDRESSES.weth) && p.meaningful,
  );
  if (v2) {
    const out = await quoteV2ExactIn(client, amountIn, [token, ADDRESSES.weth]);
    if (out && out > 0n) {
      return {
        ok: true,
        protocol: "v2",
        inputToken: token,
        outputToken: ADDRESSES.weth,
        inputAmount: amountIn,
        outputAmount: out,
        minOutput: applySlippage(out, config.slippageBps),
        pool: v2.pair,
        route: `${token} --v2--> WETH (unwrap to ETH)`,
        router: ADDRESSES.universalRouterV2_1_1,
        permit2Required: true,
        gasEstimate: null,
      };
    }
  }

  return {
    ok: false,
    protocol: "none",
    inputToken: token,
    outputToken: ADDRESSES.weth,
    inputAmount: amountIn,
    outputAmount: 0n,
    minOutput: 0n,
    route: "no route",
    router: ADDRESSES.universalRouterV2_1_1,
    permit2Required: true,
    gasEstimate: null,
    error: "No quotable TOKEN→WETH/ETH route found on verified Uniswap factories.",
  };
}

export async function quoteTokenToUsdg(
  client: PublicClient,
  config: AppConfig,
  token: Address,
  amountIn: bigint,
  discovery?: PoolDiscovery,
): Promise<QuoteResult> {
  const pools = discovery ?? (await discoverPools(client, token, config.walletAddress));
  const v3 = bestV3Pool(pools.v3, ADDRESSES.usdg);
  if (v3) {
    const q = await quoteV3ExactIn(
      client,
      token,
      ADDRESSES.usdg,
      v3.fee,
      amountIn,
    );
    if (q && q.amountOut > 0n) {
      return {
        ok: true,
        protocol: "v3",
        inputToken: token,
        outputToken: ADDRESSES.usdg,
        inputAmount: amountIn,
        outputAmount: q.amountOut,
        minOutput: applySlippage(q.amountOut, config.slippageBps),
        fee: v3.fee,
        pool: v3.pool,
        route: `${token} --v3(${v3.fee})--> USDG`,
        router: ADDRESSES.universalRouterV2_1_1,
        permit2Required: true,
        gasEstimate: q.gasEstimate,
      };
    }
  }

  // Multi-hop TOKEN -> WETH -> USDG via v3 if direct missing
  const toWeth = await quoteTokenToEth(client, config, token, amountIn, pools);
  if (toWeth.ok) {
    const wethUsdg = bestV3Pool(
      await discoverPools(client, ADDRESSES.weth, config.walletAddress).then(
        (d) => d.v3,
      ),
      ADDRESSES.usdg,
    );
    // Simpler: try quote WETH->USDG with amount from first hop
    if (wethUsdg) {
      const q2 = await quoteV3ExactIn(
        client,
        ADDRESSES.weth,
        ADDRESSES.usdg,
        wethUsdg.fee,
        toWeth.outputAmount,
      );
      if (q2 && q2.amountOut > 0n) {
        return {
          ok: true,
          protocol: "v3",
          inputToken: token,
          outputToken: ADDRESSES.usdg,
          inputAmount: amountIn,
          outputAmount: q2.amountOut,
          minOutput: applySlippage(q2.amountOut, config.slippageBps),
          fee: toWeth.fee,
          pool: toWeth.pool,
          route: `${token} --v3--> WETH --v3--> USDG`,
          router: ADDRESSES.universalRouterV2_1_1,
          permit2Required: true,
          gasEstimate: q2.gasEstimate,
        };
      }
    }
  }

  return {
    ok: false,
    protocol: "none",
    inputToken: token,
    outputToken: ADDRESSES.usdg,
    inputAmount: amountIn,
    outputAmount: 0n,
    minOutput: 0n,
    route: "no route",
    router: ADDRESSES.universalRouterV2_1_1,
    permit2Required: true,
    gasEstimate: null,
    error: "No quotable TOKEN→USDG route found.",
  };
}

export function printQuote(q: QuoteResult, decimalsIn: number, decimalsOut: number): void {
  logSection("QUOTE");
  logKv("ok", q.ok);
  logKv("protocol", q.protocol);
  logKv("input token", q.inputToken);
  logKv("input amount raw", q.inputAmount.toString());
  logKv("input amount", formatUnits(q.inputAmount, decimalsIn));
  logKv("route", q.route);
  logKv("pool", q.pool ?? "n/a");
  logKv("fee tier", q.fee ?? "n/a");
  logKv("estimated output raw", q.outputAmount.toString());
  logKv(
    "estimated output",
    q.outputToken === ADDRESSES.weth
      ? `${formatEther(q.outputAmount)} WETH/ETH`
      : formatUnits(q.outputAmount, decimalsOut),
  );
  logKv(
    "min output (slippage)",
    q.outputToken === ADDRESSES.weth
      ? `${formatEther(q.minOutput)} WETH/ETH`
      : formatUnits(q.minOutput, decimalsOut),
  );
  logKv("gas estimate", q.gasEstimate?.toString() ?? "n/a");
  logKv("router", q.router);
  logKv("router label", "Universal Router 2.1.1 (official for chain 4663)");
  logKv("Permit2 required", q.permit2Required);
  if (q.error) logKv("error", q.error);
}
