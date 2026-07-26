import "dotenv/config";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  isHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Robinhood Chain mainnet — verified Uniswap deployments (official docs + SDK). */
export const ROBINHOOD_CHAIN_ID = 4663;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

/**
 * Official Uniswap addresses for Robinhood Chain (4663).
 * Sources:
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
 * - @uniswap/universal-router-sdk CHAIN_CONFIGS[4663]
 * - Uniswap contracts deployment PRs for v2 factory / UR 2.0 companion
 */
export const ADDRESSES = {
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  /** Canonical Robinhood USDG (6 decimals) — preferred stable quote asset. */
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  v2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f" as Address,
  v2Router: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba" as Address,
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  v3SwapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,
  v3QuoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address,
  v3NftPositionManager:
    "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3" as Address,
  v4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
  v4PositionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as Address,
  /**
   * Universal Router 2.1.1 — preferred entrypoint per Uniswap docs/SDK for 4663.
   */
  universalRouterV2_1_1:
    "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  /**
   * Universal Router 2.0 also exists on-chain (no Across SpokePool). Kept for
   * comparison / fallback discovery only — prefer 2.1.1.
   */
  universalRouterV2_0:
    "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77" as Address,
  /** Seen in failed swap path (Permit2 proxy helper). Verified on Blockscout. */
  permit2Proxy: "0x8eabb4e117fb70b346592e013855f6d825f50af1" as Address,
  /** Older SwapRouter observed in successful transfer path — not the preferred UR. */
  legacySwapRouter: "0x10d876bb2279c73199f93e74739845a70176bd24" as Address,
} as const;

/**
 * User-supplied address from the failed tx. On-chain this is a UniswapV3Pool
 * (WETH/AEON 1%), not the ERC-20 itself. Diagnostics will resolve the real token.
 */
export const USER_SUPPLIED_TOKEN_OR_POOL =
  "0xE1321e41a5A7205a1fa73cd50E2139eAD98ed2EF" as Address;

/** Actual AEON ERC-20 (token1 of the V3 pool above). */
export const AEON_TOKEN =
  "0x31FFc4beed5A292b9264286118c190174d955212" as Address;

export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const EXPLORER_API = "https://robinhoodchain.blockscout.com/api/v2";

export type AppConfig = {
  rpcUrl: string;
  tokenAddress: Address;
  testSellAmountHuman: string;
  slippageBps: number;
  privateKey: Hex | null;
  walletAddress: Address;
  canSign: boolean;
};

function parsePrivateKey(): Hex | null {
  let raw = process.env.PRIVATE_KEY?.trim();
  if (!raw || raw.includes("your_private_key")) return null;

  // Common .env mistakes: quotes, trailing semicolon/comma, accidental whitespace.
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  raw = raw.replace(/[;,]+$/g, "").trim();

  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!isHex(key) || key.length !== 66) {
    throw new Error(
      "PRIVATE_KEY must be a 32-byte hex string (0x + 64 hex chars). Tip: remove quotes/trailing semicolons; do not use a seed phrase here.",
    );
  }
  return key;
}

/**
 * Load config. Prefer PRIVATE_KEY (never printed).
 * For read-only diagnose/quote/simulate, WALLET_ADDRESS may be used if PRIVATE_KEY is absent.
 * sell always requires PRIVATE_KEY.
 */
export function loadConfig(opts?: { requireSigner?: boolean }): AppConfig {
  const requireSigner = opts?.requireSigner ?? false;
  const privateKey = parsePrivateKey();

  const tokenRaw =
    process.env.TOKEN_ADDRESS?.trim() || USER_SUPPLIED_TOKEN_OR_POOL;
  if (!isAddress(tokenRaw)) {
    throw new Error(`TOKEN_ADDRESS is not a valid address: ${tokenRaw}`);
  }

  const slippageRaw = process.env.SLIPPAGE_BPS?.trim();
  const slippageBps = slippageRaw ? Number(slippageRaw) : 100;
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new Error("SLIPPAGE_BPS must be between 0 and 5000");
  }

  let walletAddress: Address;
  let key: Hex | null = null;
  let canSign = false;

  if (privateKey) {
    key = privateKey;
    walletAddress = privateKeyToAccount(privateKey).address;
    canSign = true;
  } else {
    const wal = process.env.WALLET_ADDRESS?.trim();
    if (!wal || !isAddress(wal)) {
      throw new Error(
        "Set PRIVATE_KEY in local .env (recommended), or WALLET_ADDRESS for read-only diagnose/quote/simulate. Never paste secrets into chat.",
      );
    }
    if (requireSigner) {
      throw new Error(
        "This command requires PRIVATE_KEY in local .env to sign (still never printed).",
      );
    }
    walletAddress = wal as Address;
    console.warn(
      "[!] Read-only mode: using WALLET_ADDRESS (no PRIVATE_KEY). Signing/sell disabled.",
    );
  }

  return {
    rpcUrl:
      process.env.RPC_URL?.trim() ||
      "https://rpc.mainnet.chain.robinhood.com",
    tokenAddress: tokenRaw as Address,
    testSellAmountHuman: process.env.TEST_SELL_AMOUNT?.trim() || "0.001",
    slippageBps,
    privateKey: key,
    walletAddress,
    canSign,
  };
}

export function createClients(config: AppConfig) {
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport,
  });
  if (!config.privateKey || !config.canSign) {
    return {
      publicClient,
      walletClient: null as unknown as ReturnType<typeof createWalletClient>,
      account: null as unknown as ReturnType<typeof privateKeyToAccount>,
    };
  }
  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport,
  });
  return { publicClient, walletClient, account };
}

export type PublicClient = ReturnType<typeof createClients>["publicClient"];
export type WalletClient = ReturnType<typeof createClients>["walletClient"];

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function logSection(title: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

export function logKv(key: string, value: unknown): void {
  console.log(`  ${key.padEnd(28)} ${String(value)}`);
}
