import {
  type Address,
  type Hex,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";
import {
  ADDRESSES,
  EXPLORER_API,
  type PublicClient,
  logKv,
} from "./config.js";

const v3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function liquidity() view returns (uint128)",
]);

const probeAbi = parseAbi([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function tradingEnabled() view returns (bool)",
  "function tradingActive() view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
  "function blacklisted(address) view returns (bool)",
  "function isExcludedFromFee(address) view returns (bool)",
  "function maxTxAmount() view returns (uint256)",
  "function maxTransactionAmount() view returns (uint256)",
  "function maxWallet() view returns (uint256)",
  "function maxWalletAmount() view returns (uint256)",
  "function buyTax() view returns (uint256)",
  "function sellTax() view returns (uint256)",
  "function totalFees() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
]);

/** Common selectors used to heuristically classify unverified token bytecode. */
const SELECTOR_HINTS: Record<string, string> = {
  "0x8da5cb5b": "owner()",
  "0x893d20e8": "getOwner()",
  "0x5c975abb": "paused()",
  "0x4ada218b": "tradingEnabled()",
  "0x48e51041": "isBlacklisted(address)",
  "0xfe575a87": "isBlacklisted(address)",
  "0x9cd441da": "maxTxAmount()",
  "0x8f70ccf7": "setTrading(bool)",
  "0xc49b9a80": "setSwapEnabled(bool)",
  "0x8a8c523c": "enableTrading()",
  "0x18160ddd": "totalSupply()",
  "0x70a08231": "balanceOf(address)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0xdd62ed3e": "allowance(address,address)",
  "0x313ce567": "decimals()",
  "0x06fdde03": "name()",
  "0x95d89b41": "symbol()",
};

export type TokenMeta = {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  ethBalance: bigint;
};

export type ResolvedToken = {
  /** Address used for ERC-20 reads / sells. */
  token: Address;
  /** Original configured address (may be a pool). */
  configuredAddress: Address;
  resolvedFromPool: boolean;
  pool?: {
    address: Address;
    token0: Address;
    token1: Address;
    fee: number;
    factory: Address;
    liquidity: bigint;
  };
};

export async function tryReadV3Pool(
  client: PublicClient,
  address: Address,
): Promise<ResolvedToken["pool"] | null> {
  try {
    const [token0, token1, fee, factory, liquidity] = await Promise.all([
      client.readContract({ address, abi: v3PoolAbi, functionName: "token0" }),
      client.readContract({ address, abi: v3PoolAbi, functionName: "token1" }),
      client.readContract({ address, abi: v3PoolAbi, functionName: "fee" }),
      client.readContract({ address, abi: v3PoolAbi, functionName: "factory" }),
      client.readContract({
        address,
        abi: v3PoolAbi,
        functionName: "liquidity",
      }),
    ]);
    const factoryNorm = getAddress(factory);
    if (factoryNorm !== getAddress(ADDRESSES.v3Factory)) {
      // Still looks like a V3 pool interface — accept if token0/token1 readable.
    }
    return {
      address: getAddress(address),
      token0: getAddress(token0),
      token1: getAddress(token1),
      fee: Number(fee),
      factory: factoryNorm,
      liquidity,
    };
  } catch {
    return null;
  }
}

export async function resolveTokenAddress(
  client: PublicClient,
  configuredAddress: Address,
): Promise<ResolvedToken> {
  const configured = getAddress(configuredAddress);
  const pool = await tryReadV3Pool(client, configured);
  if (!pool) {
    return {
      token: configured,
      configuredAddress: configured,
      resolvedFromPool: false,
    };
  }

  const weth = getAddress(ADDRESSES.weth);
  const nonWeth =
    getAddress(pool.token0) === weth
      ? getAddress(pool.token1)
      : getAddress(pool.token1) === weth
        ? getAddress(pool.token0)
        : getAddress(pool.token1);

  console.warn(
    `\n[!] Configured address ${configured} is a Uniswap V3 pool, not an ERC-20.`,
  );
  console.warn(
    `    Pool: token0=${pool.token0} token1=${pool.token1} fee=${pool.fee}`,
  );
  console.warn(`    Using non-WETH side as sell token: ${nonWeth}\n`);

  return {
    token: nonWeth,
    configuredAddress: configured,
    resolvedFromPool: true,
    pool,
  };
}

export async function getTokenMeta(
  client: PublicClient,
  token: Address,
  wallet: Address,
): Promise<TokenMeta> {
  const [name, symbol, decimals, balance, ethBalance] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    }),
    client.getBalance({ address: wallet }),
  ]);
  return {
    address: token,
    name,
    symbol,
    decimals,
    balance,
    ethBalance,
  };
}

export async function getErc20Allowance(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

async function safeRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export type TokenInspection = {
  looksLikeErc20: boolean;
  isProxy: boolean | "unknown";
  proxyType: string | null;
  implementation: Address | null;
  verified: boolean | "unknown";
  contractName: string | null;
  sourceAvailable: boolean;
  bytecodeSize: number;
  hasDelegatecallOpcode: boolean;
  selectorsFound: string[];
  restrictionHints: string[];
  owner: Address | null;
  paused: boolean | null;
  tradingEnabled: boolean | null;
  blacklistedWallet: boolean | null;
  maxTx: bigint | null;
  maxWallet: bigint | null;
  buyTax: bigint | null;
  sellTax: bigint | null;
  notes: string[];
};

export async function inspectTokenContract(
  client: PublicClient,
  token: Address,
  wallet: Address,
): Promise<TokenInspection> {
  const notes: string[] = [];
  const restrictionHints: string[] = [];

  const bytecode = await client.getBytecode({ address: token });
  const code = (bytecode ?? "0x") as Hex;
  const bytecodeSize = Math.max(0, (code.length - 2) / 2);
  const hasDelegatecallOpcode = code.toLowerCase().includes("f4"); // rough: DELEGATECALL opcode

  const selectorsFound = Object.entries(SELECTOR_HINTS)
    .filter(([sel]) => code.toLowerCase().includes(sel.slice(2)))
    .map(([, name]) => name);

  // Confirm ERC20 by calling standard views
  const decimals = await safeRead(() =>
    client.readContract({
      address: token,
      abi: probeAbi,
      functionName: "decimals",
    }),
  );
  const hasStandardViews = decimals !== null;
  const looksLikeErc20 = hasStandardViews;

  let verified: boolean | "unknown" = "unknown";
  let contractName: string | null = null;
  let sourceAvailable = false;
  let isProxy: boolean | "unknown" = "unknown";
  let proxyType: string | null = null;
  let implementation: Address | null = null;

  try {
    const res = await fetch(`${EXPLORER_API}/addresses/${token}`);
    if (res.ok) {
      const data = (await res.json()) as {
        is_verified?: boolean;
        name?: string | null;
        proxy_type?: string | null;
        implementations?: { address?: string; address_hash?: string }[];
      };
      verified = Boolean(data.is_verified);
      contractName = data.name ?? null;
      proxyType = data.proxy_type ?? null;
      isProxy = Boolean(data.proxy_type);
      const impl =
        data.implementations?.[0]?.address_hash ||
        data.implementations?.[0]?.address;
      if (impl) implementation = getAddress(impl);
    }
  } catch {
    notes.push("Could not reach Blockscout for verification metadata.");
  }

  if (verified === true) {
    try {
      const res = await fetch(`${EXPLORER_API}/smart-contracts/${token}`);
      if (res.ok) {
        const data = (await res.json()) as {
          source_code?: string;
          is_verified?: boolean;
          name?: string;
        };
        sourceAvailable = Boolean(data.source_code && data.source_code.length);
        if (data.name) contractName = data.name;
        const src = (data.source_code || "").toLowerCase();
        const checks: [string, string][] = [
          ["blacklist", "Possible blacklist logic in verified source"],
          ["whitelist", "Possible whitelist logic in verified source"],
          ["trading", "Possible trading-enabled gate in verified source"],
          ["maxtx", "Possible maxTx restriction in verified source"],
          ["maxwallet", "Possible maxWallet restriction in verified source"],
          ["tax", "Possible tax/fee logic in verified source"],
          ["onlyowner", "Owner/admin controls present in verified source"],
          ["transferfrom", "Custom transferFrom present (inspect source)"],
        ];
        for (const [needle, msg] of checks) {
          if (src.includes(needle)) restrictionHints.push(msg);
        }
      }
    } catch {
      notes.push("Verified-source fetch failed.");
    }
  } else {
    notes.push(
      "Token is unverified on Blockscout — restriction analysis is heuristic (bytecode selectors + view probes).",
    );
  }

  const owner =
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "owner",
      }),
    )) ??
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "getOwner",
      }),
    ));

  const paused = await safeRead(() =>
    client.readContract({
      address: token,
      abi: probeAbi,
      functionName: "paused",
    }),
  );

  const tradingEnabled =
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "tradingEnabled",
      }),
    )) ??
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "tradingActive",
      }),
    ));

  const blacklistedWallet =
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "isBlacklisted",
        args: [wallet],
      }),
    )) ??
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "blacklisted",
        args: [wallet],
      }),
    ));

  const maxTx =
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "maxTxAmount",
      }),
    )) ??
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "maxTransactionAmount",
      }),
    ));

  const maxWallet =
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "maxWallet",
      }),
    )) ??
    (await safeRead(() =>
      client.readContract({
        address: token,
        abi: probeAbi,
        functionName: "maxWalletAmount",
      }),
    ));

  const buyTax = await safeRead(() =>
    client.readContract({
      address: token,
      abi: probeAbi,
      functionName: "buyTax",
    }),
  );
  const sellTax = await safeRead(() =>
    client.readContract({
      address: token,
      abi: probeAbi,
      functionName: "sellTax",
    }),
  );

  if (selectorsFound.some((s) => s.includes("Blacklist"))) {
    restrictionHints.push("Bytecode contains blacklist-related selector(s)");
  }
  if (selectorsFound.some((s) => s.toLowerCase().includes("trading"))) {
    restrictionHints.push("Bytecode contains trading-gate selector(s)");
  }
  if (hasDelegatecallOpcode) {
    notes.push(
      "Bytecode contains DELEGATECALL opcode (0xf4) — may be proxy/custom logic (heuristic; false positives possible).",
    );
  }

  return {
    looksLikeErc20,
    isProxy,
    proxyType,
    implementation,
    verified,
    contractName,
    sourceAvailable,
    bytecodeSize,
    hasDelegatecallOpcode,
    selectorsFound,
    restrictionHints,
    owner: owner ? getAddress(owner) : null,
    paused,
    tradingEnabled,
    blacklistedWallet,
    maxTx,
    maxWallet,
    buyTax,
    sellTax,
    notes,
  };
}

export function printTokenInspection(insp: TokenInspection): void {
  logKv("standard ERC20 views", insp.looksLikeErc20);
  logKv("verified on explorer", insp.verified);
  logKv("contract name", insp.contractName ?? "n/a");
  logKv("source available", insp.sourceAvailable);
  logKv("proxy", insp.isProxy === "unknown" ? "unknown" : insp.isProxy);
  logKv("proxy type", insp.proxyType ?? "n/a");
  logKv("implementation", insp.implementation ?? "n/a");
  logKv("bytecode size (bytes)", insp.bytecodeSize);
  logKv("delegatecall opcode hint", insp.hasDelegatecallOpcode);
  logKv("owner", insp.owner ?? "n/a / not exposed");
  logKv("paused()", insp.paused === null ? "n/a" : insp.paused);
  logKv(
    "tradingEnabled()",
    insp.tradingEnabled === null ? "n/a" : insp.tradingEnabled,
  );
  logKv(
    "wallet blacklisted?",
    insp.blacklistedWallet === null ? "n/a" : insp.blacklistedWallet,
  );
  logKv("maxTx", insp.maxTx === null ? "n/a" : insp.maxTx.toString());
  logKv("maxWallet", insp.maxWallet === null ? "n/a" : insp.maxWallet.toString());
  logKv("buyTax", insp.buyTax === null ? "n/a" : insp.buyTax.toString());
  logKv("sellTax", insp.sellTax === null ? "n/a" : insp.sellTax.toString());
  if (insp.selectorsFound.length) {
    console.log("  selectors (heuristic):");
    for (const s of insp.selectorsFound) console.log(`    - ${s}`);
  }
  if (insp.restrictionHints.length) {
    console.log("  restriction hints:");
    for (const h of insp.restrictionHints) console.log(`    - ${h}`);
  }
  if (insp.notes.length) {
    console.log("  notes:");
    for (const n of insp.notes) console.log(`    - ${n}`);
  }
}
