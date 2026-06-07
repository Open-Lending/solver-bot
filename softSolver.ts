import fs from "fs";
import * as https from "https";
import path from "path";
import dotenv from "dotenv";
import { Contract, formatUnits, JsonRpcProvider, parseUnits, Wallet, ZeroAddress, isAddress } from "ethers";

dotenv.config({ quiet: true });

type Direction = "down" | "up";
type SolverMode = "profitOnly" | "aggressive";
type FlashMode = "auto" | "fixed";
type ExecutionMode = "flash" | "direct";
type ProtocolKind = "aave" | "morpho";
type MarketId = "WBTC_USDT" | "WETH_USDT" | "USDT_WBTC" | "USDT_WETH";
type MarketKey =
  | MarketId
  | `AAVE_${MarketId}`
  | "MORPHO_WBTC_USDT"
  | "MORPHO_WETH_USDT";
type MarketSelection = {
  key: MarketKey;
  protocol: ProtocolKind;
  market: MarketId;
};

type RunSoftSolverOptions = {
  provider?: any;
  signer?: any;
  chainId?: number;
  flashSolverAddress?: string;
  recipient?: string;
  markets?: MarketSelection[];
  once?: boolean;
  startedAtMs?: number;
};

const AAVE_MARKETS: MarketId[] = ["WBTC_USDT", "WETH_USDT", "USDT_WBTC", "USDT_WETH"];
const MORPHO_MARKETS: MarketId[] = ["WBTC_USDT", "WETH_USDT"];
const DEFAULT_MARKETS: MarketKey[] = [
  "AAVE_WBTC_USDT",
  "AAVE_WETH_USDT",
  "AAVE_USDT_WBTC",
  "AAVE_USDT_WETH",
  "MORPHO_WBTC_USDT",
  "MORPHO_WETH_USDT",
];
const MARKET_IDS = new Set<string>(AAVE_MARKETS);
const ARBITRUM_UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

type PoolDeployment = {
  network: string;
  chainId: number;
  market: MarketId;
  kind?: string;
  pool: string;
  flashLoop?: string;
  positionNFT: string;
  oracle: string;
  aavePool?: string;
  flashLoanProvider?: string;
  morphoMarketId?: string;
  collateral: string;
  debt: string;
  owner?: string;
  collateralSymbol: string;
  debtSymbol: string;
  collateralDecimals: number;
  debtDecimals: number;
  modules: {
    auction?: string;
    position?: string;
    helper: string;
  };
};

type FlashSolverDeployment = {
  chainId: number;
  flashSolver: string;
};

type MarketRuntime = {
  key: MarketKey;
  protocol: ProtocolKind;
  deployment: PoolDeployment;
  pool: Contract;
  helper: Contract;
  oracle: Contract;
  aavePool?: Contract;
  flashSolver?: Contract;
  uniswapPool: string;
};

type AuctionQuote = {
  amountOut: bigint;
  amountIn: bigint;
  flashAmount: bigint;
  maxFillAmount: bigint;
  finalSqrtPriceX96: bigint;
  finalTick: number;
  steps: number;
};

type ExecutionPlan = {
  direction: Direction;
  params: {
    softbandsPool: string;
    collateral: string;
    debt: string;
    uniswapPool: string;
    flashAmount: bigint;
    maxFillAmount: bigint;
    softbandsSqrtLimitX96: bigint;
    swapSqrtLimitX96: bigint;
    minProfit: bigint;
    profitRecipient: string;
  };
  simulatedProfit: bigint;
  profitDecimals: number;
  profitSymbol: string;
  fillCapDecimals: number;
  fillCapSymbol: string;
};

type FillEvent = {
  direction: Direction;
  oldTick: number;
  newTick: number;
  collateralOut: bigint;
  debtIn: bigint;
  debtOut: bigint;
  collateralIn: bigint;
  lossAccrued: bigint;
};

type FlashEvent = {
  direction: Direction;
  flashAsset: string;
  flashAmount: bigint;
  flashPremium: bigint;
  swapAmountOut: bigint;
  profitAsset: string;
  profit: bigint;
};

type CursorSyncResult = {
  direction: Direction;
  oldTick: number;
  newTick: number;
  debtOut: bigint;
  collateralIn: bigint;
  collateralOut: bigint;
  debtIn: bigint;
  lossAccrued: bigint;
};

const ORACLE_ABI = [
  "function getPrice(address) view returns (uint256)",
];

const SOFTBANDS_POOL_ABI = [
  "function collateralToken() view returns (address)",
  "function debtToken() view returns (address)",
  "function oracle() view returns (address)",
  "function aavePool() view returns (address)",
  "function morphoMarketId() view returns (bytes32)",
  "function flashLoopModule() view returns (address)",
  "function morphoBorrowIndexRay() view returns (uint256)",
  "function positionNFT() view returns (address)",
  "function helper() view returns (address)",
  "function owner() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function lockedLtvBps() view returns (uint16)",
  "function convexityK() view returns (uint256)",
  "function discountMax() view returns (uint256)",
  "function protocolFeeBps() view returns (uint16)",
  "function liquidationThresholdX18() view returns (uint256)",
  "function aggregateScaledCollateral() view returns (uint256)",
  "function aggregateScaledDebt() view returns (uint256)",
  "function tickBitmap(int16) view returns (uint256)",
  "function ticks(int24) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 lossGrowthOutsideX128,uint256 scaledLossGrowthOutsideX128,uint256 scaledDebtRepaidGrowthOutsideX128,uint256 scaledDebtBorrowedGrowthOutsideX128,uint256 protocolDebtRepaidGrowthOutsideX128,uint256 protocolDebtBorrowedGrowthOutsideX128,uint256 scaledColWithdrawnGrowthOutsideX128,uint256 scaledColSuppliedGrowthOutsideX128,bool initialized)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,bool unlocked)",
  "function gapThreshold() view returns (uint256)",
  "function getHealthFactor(uint256 tokenId) view returns (uint256)",
  "function getPositionState(uint256 tokenId) view returns (uint256 collateral,uint256 debt,uint256 accumulatedLoss,uint256 collateralInterest,uint256 debtInterest,uint256 protocolFeeDebt)",
  "function fill(uint256 maxCollateralOut,uint160 maxSqrtPriceX96) returns (uint256 collateralOut,uint256 debtIn)",
  "function fillUp(uint256 maxDebtOut,uint160 minSqrtPriceX96) returns (uint256 debtOut,uint256 collateralIn)",
  "function liquidate(uint256 tokenId) returns (uint256 collateralSeized,uint128 lossWiped,uint256 debtPaid)",
  "event Filled(address indexed solver,int24 oldTick,int24 newTick,uint256 collateralOut,uint256 debtIn,uint256 lossAccrued)",
  "event FilledUp(address indexed solver,int24 oldTick,int24 newTick,uint256 debtOut,uint256 collateralIn,uint256 lossAccrued)",
  "event PositionLiquidated(uint256 indexed tokenId,address indexed owner,address indexed liquidator,uint256 collateralSeized,uint256 debtPaid,uint128 lossWiped,uint256 healthFactorX18)",
];

const POSITION_NFT_ABI = [
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

const SOFTBANDS_HELPER_ABI = [
  "function priceToSqrtPriceX96(uint256 colPrice,uint256 debtPrice,uint8 collateralDecimals,uint8 debtDecimals) pure returns (uint160)",
  "function computeGap(uint160 lowerSqrtX96,uint160 upperSqrtX96) pure returns (uint256)",
  "function getTickAtSqrtRatio(uint160 sqrtPriceX96) pure returns (int24)",
  "function getSqrtRatioAtTick(int24 tick) pure returns (uint160)",
  "function computeAuctionStep((bool down,uint160 currentSqrt,uint160 nextSqrt,uint128 currentLiquidity,uint256 remainingBudget,uint256 currentDebt,uint256 currentCollateral,uint256 colPrice,uint256 debtPrice,uint8 collateralDecimals,uint8 debtDecimals,uint16 lockedLtvBps,uint256 gapThreshold,uint256 convexityK,uint256 discountMax)) pure returns (uint256 stepOut,uint256 stepIdealIn,uint256 stepActualIn,uint160 newNextSqrt,bool isPartial,bool stopAfterThisStep)",
];

const AAVE_POOL_ABI = [
  "function getReserveNormalizedIncome(address asset) view returns (uint256)",
  "function getReserveNormalizedVariableDebt(address asset) view returns (uint256)",
];

const UNIV3_FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB,uint24 fee) external view returns (address)",
];

const FLASH_SOLVER_ABI = [
  "function owner() view returns (address)",
  "function aavePool() view returns (address)",
  "function executeFillDown((address softbandsPool,address collateral,address debt,address uniswapPool,uint256 flashAmount,uint256 maxFillAmount,uint160 softbandsSqrtLimitX96,uint160 swapSqrtLimitX96,uint256 minProfit,address profitRecipient)) external returns (uint256 profit)",
  "function executeFillUp((address softbandsPool,address collateral,address debt,address uniswapPool,uint256 flashAmount,uint256 maxFillAmount,uint160 softbandsSqrtLimitX96,uint160 swapSqrtLimitX96,uint256 minProfit,address profitRecipient)) external returns (uint256 profit)",
  "event FlashFillExecuted(uint8 indexed direction,address indexed softbandsPool,address indexed profitRecipient,address flashAsset,uint256 flashAmount,uint256 flashPremium,uint256 collateralOut,uint256 debtIn,uint256 debtOut,uint256 collateralIn,uint256 swapAmountOut,address profitAsset,uint256 profit)",
  "error InvalidAddress()",
  "error InvalidCallback()",
  "error InvalidTokens()",
  "error InvalidDirection()",
  "error InsufficientProfit()",
  "error SwapSlippage()",
  "error TransferFailed()",
  "error ReentrantFlash()",
  "error FlashAmountMismatch()",
];

const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MAX_UINT256 = (1n << 256n) - 1n;
const RAY = 10n ** 27n;
const HALF_RAY = RAY / 2n;
const DEFAULT_HEARTBEAT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FLASH_AMOUNTS: Record<MarketId, Record<Direction, string>> = {
  WBTC_USDT: {
    down: "100",
    up: "0.001",
  },
  WETH_USDT: {
    down: "100",
    up: "0.05",
  },
  USDT_WBTC: {
    down: "0.001",
    up: "100",
  },
  USDT_WETH: {
    down: "0.05",
    up: "100",
  },
};

function envFlag(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function envDurationMs(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    throw new Error(`${name} must be a duration in milliseconds, at least 1000`);
  }
  return Math.floor(parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMarketSelection(rawMarket: string): MarketSelection {
  const raw = rawMarket.trim().toUpperCase();
  let protocol: ProtocolKind = "aave";
  let market = raw;

  if (raw.startsWith("AAVE_")) {
    protocol = "aave";
    market = raw.slice("AAVE_".length);
  } else if (raw.startsWith("MORPHO_")) {
    protocol = "morpho";
    market = raw.slice("MORPHO_".length);
  }

  if (!MARKET_IDS.has(market)) {
    throw new Error(`Unsupported market in SOLVER_MARKETS: ${rawMarket}`);
  }
  if (protocol === "morpho" && !MORPHO_MARKETS.includes(market as MarketId)) {
    throw new Error(`Unsupported Morpho market in SOLVER_MARKETS: ${rawMarket}`);
  }

  const baseMarket = market as MarketId;
  const key = protocol === "morpho"
    ? (`MORPHO_${baseMarket}` as MarketKey)
    : (`AAVE_${baseMarket}` as MarketKey);
  return { key, protocol, market: baseMarket };
}

function parseMarkets(): MarketSelection[] {
  const raw = process.env.SOLVER_MARKETS ?? DEFAULT_MARKETS.join(",");
  const markets = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (markets.length === 0) throw new Error("SOLVER_MARKETS is empty");
  return markets.map(parseMarketSelection);
}

function solverMode(): SolverMode {
  const raw = process.env.SOLVER_MODE ?? "profitOnly";
  if (raw !== "profitOnly" && raw !== "aggressive") {
    throw new Error("SOLVER_MODE must be profitOnly or aggressive");
  }
  return raw;
}

function flashMode(): FlashMode {
  const raw = process.env.SOLVER_FLASH_MODE ?? "auto";
  if (raw !== "auto" && raw !== "fixed") {
    throw new Error("SOLVER_FLASH_MODE must be auto or fixed");
  }
  return raw;
}

function executionMode(): ExecutionMode {
  const raw = process.env.SOLVER_EXECUTION_MODE ?? "flash";
  if (raw !== "flash" && raw !== "direct") {
    throw new Error("SOLVER_EXECUTION_MODE must be flash or direct");
  }
  return raw;
}

function scopedEnv(base: string, market: string, direction?: Direction): string | undefined {
  const withDirection = direction ? process.env[`${base}_${direction.toUpperCase()}_${market}`] : undefined;
  if (withDirection != null && withDirection !== "") return withDirection;
  const withMarket = process.env[`${base}_${market}`];
  if (withMarket != null && withMarket !== "") return withMarket;
  const genericDirection = direction ? process.env[`${base}_${direction.toUpperCase()}`] : undefined;
  if (genericDirection != null && genericDirection !== "") return genericDirection;
  const generic = process.env[base];
  return generic != null && generic !== "" ? generic : undefined;
}

function scopedEnvForNames(base: string, markets: string[], direction?: Direction): string | undefined {
  for (const market of markets) {
    const value = scopedEnv(base, market, direction);
    if (value != null && value !== "") return value;
  }
  return scopedEnv(base, "", direction);
}

function marketEnv(base: string, market: MarketRuntime, direction?: Direction): string | undefined {
  const names = market.key === market.deployment.market
    ? [market.key]
    : [market.key, market.deployment.market];
  return scopedEnvForNames(base, names, direction);
}

function marketLabel(market: MarketRuntime): string {
  return market.key;
}

function configuredFillCap(market: MarketRuntime, direction: Direction): bigint | null {
  const raw = marketEnv("SOLVER_MAX_FILL", market, direction);
  if (!raw || raw.toLowerCase() === "max") return null;
  const decimals = direction === "down"
    ? market.deployment.collateralDecimals
    : market.deployment.debtDecimals;
  return parseUnits(raw, decimals);
}

function configuredMaxFlash(market: MarketRuntime, direction: Direction): bigint | null {
  const raw = marketEnv("SOLVER_MAX_FLASH", market, direction);
  if (!raw || raw.toLowerCase() === "max") return null;
  const decimals = direction === "down"
    ? market.deployment.debtDecimals
    : market.deployment.collateralDecimals;
  return parseUnits(raw, decimals);
}

function flashAmountFor(
  market: MarketRuntime,
  direction: Direction,
  colPrice: bigint,
  debtPrice: bigint
): bigint {
  const d = market.deployment;
  const raw = marketEnv("SOLVER_FLASH_AMOUNT", market, direction);
  const decimals = direction === "down" ? d.debtDecimals : d.collateralDecimals;
  if (raw && raw !== "") return parseUnits(raw, decimals);

  const cap = configuredFillCap(market, direction);
  if (cap != null) {
    return direction === "down"
      ? colToDebt(market, cap, colPrice, debtPrice)
      : debtToCol(market, cap, colPrice, debtPrice);
  }

  return parseUnits(DEFAULT_FLASH_AMOUNTS[d.market][direction], decimals);
}

function flashBufferBpsFor(market: MarketRuntime, direction: Direction): bigint {
  const raw = marketEnv("SOLVER_FLASH_BUFFER_BPS", market, direction) ?? "5";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("SOLVER_FLASH_BUFFER_BPS must be between 0 and 10000");
  }
  return BigInt(Math.ceil(parsed));
}

function fillCapForFlash(
  market: MarketRuntime,
  direction: Direction,
  flashAmount: bigint,
  colPrice: bigint,
  debtPrice: bigint
): bigint {
  const derived = direction === "down"
    ? debtToCol(market, flashAmount, colPrice, debtPrice)
    : colToDebt(market, flashAmount, colPrice, debtPrice);
  const configured = configuredFillCap(market, direction);
  if (configured == null) return derived;
  return configured < derived ? configured : derived;
}

function minProfitDebtFor(market: MarketRuntime): bigint {
  const raw = marketEnv("SOLVER_MIN_PROFIT_DEBT", market) ?? "0.000001";
  return parseUnits(raw, market.deployment.debtDecimals);
}

function emptyCursorSyncEnabled(market: MarketRuntime): boolean {
  const raw = marketEnv("SOLVER_ENABLE_EMPTY_CURSOR_SYNC", market);
  if (raw == null || raw === "") return true;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function emptyCursorSyncMaxTicks(market: MarketRuntime): number {
  const raw = marketEnv("SOLVER_EMPTY_CURSOR_SYNC_MAX_TICKS", market);
  if (raw == null || raw === "") return 5000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("SOLVER_EMPTY_CURSOR_SYNC_MAX_TICKS must be a non-negative integer");
  }
  return parsed;
}

function uniswapFeeFor(markets: string[]): number {
  return Number(scopedEnvForNames("UNISWAP_FEE", markets) ?? "500");
}

function profitRecipient(defaultRecipient: string): string {
  const raw = process.env.SOLVER_PROFIT_RECIPIENT;
  return raw && raw !== "" ? raw : defaultRecipient;
}

function colToDebt(market: MarketRuntime, colAmount: bigint, colPrice: bigint, debtPrice: bigint): bigint {
  return (
    colAmount *
    colPrice *
    10n ** BigInt(market.deployment.debtDecimals)
  ) / (
    debtPrice *
    10n ** BigInt(market.deployment.collateralDecimals)
  );
}

function debtToCol(market: MarketRuntime, debtAmount: bigint, colPrice: bigint, debtPrice: bigint): bigint {
  return (
    debtAmount *
    debtPrice *
    10n ** BigInt(market.deployment.collateralDecimals)
  ) / (
    colPrice *
    10n ** BigInt(market.deployment.debtDecimals)
  );
}

function colToDebtRoundingUp(
  market: MarketRuntime,
  colAmount: bigint,
  colPrice: bigint,
  debtPrice: bigint
): bigint {
  return mulDivRoundingUp(
    colAmount * colPrice * 10n ** BigInt(market.deployment.debtDecimals),
    1n,
    debtPrice * 10n ** BigInt(market.deployment.collateralDecimals)
  );
}

function debtToColRoundingUp(
  market: MarketRuntime,
  debtAmount: bigint,
  colPrice: bigint,
  debtPrice: bigint
): bigint {
  return mulDivRoundingUp(
    debtAmount * debtPrice * 10n ** BigInt(market.deployment.collateralDecimals),
    1n,
    colPrice * 10n ** BigInt(market.deployment.debtDecimals)
  );
}

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  if (a === 0n || b === 0n) return 0n;
  return ((a * b) - 1n) / denominator + 1n;
}

function rayMul(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a * b + HALF_RAY) / RAY;
}

function protocolFee(amount: bigint, feeBps: bigint): bigint {
  return feeBps === 0n ? 0n : mulDivRoundingUp(amount, feeBps, 10_000n);
}

function applyBpsBuffer(amount: bigint, bufferBps: bigint): bigint {
  return amount + mulDivRoundingUp(amount, bufferBps, 10_000n);
}

function parseBigIntList(raw: string): bigint[] {
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const parsed = BigInt(x);
      if (parsed <= 0n) throw new Error(`Invalid token id: ${x}`);
      return parsed;
    });
}

function addSigned(value: bigint, delta: bigint): bigint {
  return delta < 0n ? value - (-delta) : value + delta;
}

function solidityMod(value: number, divisor: number): number {
  return value - Math.trunc(value / divisor) * divisor;
}

function tickBitmapPosition(tick: number): { wordPos: number; bitPos: number } {
  const wordPos = tick >> 8;
  const remainder = solidityMod(tick, 256);
  const bitPos = remainder < 0 ? remainder + 256 : remainder;
  return { wordPos, bitPos };
}

function mostSignificantBit(value: bigint): number {
  if (value <= 0n) throw new Error("msb undefined for zero");
  return value.toString(2).length - 1;
}

function leastSignificantBit(value: bigint): number {
  if (value <= 0n) throw new Error("lsb undefined for zero");
  let bit = 0;
  let x = value;
  while ((x & 1n) === 0n) {
    x >>= 1n;
    bit++;
  }
  return bit;
}

async function nextInitializedTickWithinOneWord(
  market: MarketRuntime,
  tick: number,
  down: boolean
): Promise<{ nextTick: number; initialized: boolean }> {
  const tickSpacing = Number(await market.pool.tickSpacing());
  let compressed = Math.trunc(tick / tickSpacing);
  if (tick < 0 && solidityMod(tick, tickSpacing) !== 0) compressed--;

  if (down) {
    const { wordPos, bitPos } = tickBitmapPosition(compressed);
    const word = BigInt(await market.pool.tickBitmap(wordPos));
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = word & mask;
    if (masked !== 0n) {
      return {
        nextTick: (compressed - (bitPos - mostSignificantBit(masked))) * tickSpacing,
        initialized: true,
      };
    }
    return {
      nextTick: (compressed - bitPos) * tickSpacing,
      initialized: false,
    };
  }

  const { wordPos, bitPos } = tickBitmapPosition(compressed + 1);
  const word = BigInt(await market.pool.tickBitmap(wordPos));
  const mask = MAX_UINT256 ^ ((1n << BigInt(bitPos)) - 1n);
  const masked = word & mask;
  if (masked !== 0n) {
    return {
      nextTick: (compressed + 1 + (leastSignificantBit(masked) - bitPos)) * tickSpacing,
      initialized: true,
    };
  }
  return {
    nextTick: (compressed + 1 + (255 - bitPos)) * tickSpacing,
    initialized: false,
  };
}

async function aggregateAaveBalances(market: MarketRuntime): Promise<{
  currentCollateral: bigint;
  currentDebt: bigint;
}> {
  const d = market.deployment;
  if (!market.aavePool) throw new Error(`${marketLabel(market)} has no Aave pool runtime`);
  if (!d.aavePool) throw new Error(`${marketLabel(market)} deployment has no aavePool`);
  const [scaledCollateralRaw, scaledDebtRaw, liquidityIndexRaw, borrowIndexRaw] = await Promise.all([
    market.pool.aggregateScaledCollateral(),
    market.pool.aggregateScaledDebt(),
    market.aavePool.getReserveNormalizedIncome(d.collateral),
    market.aavePool.getReserveNormalizedVariableDebt(d.debt),
  ]);
  return {
    currentCollateral: rayMul(BigInt(scaledCollateralRaw), BigInt(liquidityIndexRaw)),
    currentDebt: rayMul(BigInt(scaledDebtRaw), BigInt(borrowIndexRaw)),
  };
}

async function aggregateMorphoBalances(market: MarketRuntime): Promise<{
  currentCollateral: bigint;
  currentDebt: bigint;
}> {
  const [scaledCollateralRaw, scaledDebtRaw, borrowIndexRaw] = await Promise.all([
    market.pool.aggregateScaledCollateral(),
    market.pool.aggregateScaledDebt(),
    market.pool.morphoBorrowIndexRay(),
  ]);
  return {
    currentCollateral: BigInt(scaledCollateralRaw),
    currentDebt: rayMul(BigInt(scaledDebtRaw), BigInt(borrowIndexRaw)),
  };
}

async function aggregateBalances(market: MarketRuntime): Promise<{
  currentCollateral: bigint;
  currentDebt: bigint;
}> {
  return market.protocol === "morpho"
    ? aggregateMorphoBalances(market)
    : aggregateAaveBalances(market);
}

function formatToken(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

function formatBpsX18(value: bigint): string {
  return `${formatUnits(value * 10_000n, 18)} bps`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function errorMessage(e: unknown): string {
  const err = e as { shortMessage?: string; reason?: string; message?: string };
  return err?.shortMessage || err?.reason || err?.message || String(e);
}

function debugErrorDetails(e: unknown): unknown {
  const err = e as {
    name?: string;
    code?: string;
    data?: unknown;
    reason?: string;
    shortMessage?: string;
    message?: string;
    action?: string;
    transaction?: unknown;
    error?: { data?: unknown; message?: string };
    info?: unknown;
  };
  return {
    name: err?.name,
    code: err?.code,
    action: err?.action,
    data: err?.data,
    reason: err?.reason,
    shortMessage: err?.shortMessage,
    message: err?.message,
    errorData: err?.error?.data,
    errorMessage: err?.error?.message,
    info: err?.info,
    transaction: err?.transaction,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function assertSameAddress(label: string, actual: string, expected: string): void {
  if (!sameAddress(actual, expected)) {
    throw new Error(`${label} mismatch: live=${actual}, expected=${expected}`);
  }
}

function rpcUrls(): string[] {
  const raw = process.env.ARBITRUM_RPC_URLS
    || process.env.RPC_URLS
    || process.env.ARBITRUM_RPC_URL
    || process.env.RPC_URL;
  if (!raw) throw new Error("Set ARBITRUM_RPC_URLS or ARBITRUM_RPC_URL in .env");

  const urls = raw
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (urls.length === 0) throw new Error("ARBITRUM_RPC_URLS is empty");
  return urls;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class SequentialJsonRpcProvider extends JsonRpcProvider {
  private readonly backends: JsonRpcProvider[];
  private activeIndex = 0;

  constructor(urls: string[]) {
    super(urls[0]);
    this.backends = urls.map((url) => new JsonRpcProvider(url));
  }

  async _send(payload: any): Promise<any[]> {
    const timeoutMs = envInt("RPC_REQUEST_TIMEOUT_MS", 15_000);
    let lastError: unknown;
    const startIndex = this.activeIndex;

    for (let offset = 0; offset < this.backends.length; offset++) {
      const index = (startIndex + offset) % this.backends.length;
      try {
        const result = await withTimeout(
          this.backends[index]._send(payload),
          timeoutMs,
          `RPC endpoint ${index + 1}/${this.backends.length}`,
        );
        this.activeIndex = index;
        return result;
      } catch (error) {
        lastError = error;
        this.activeIndex = (index + 1) % this.backends.length;
        console.warn(`[rpc] endpoint ${index + 1}/${this.backends.length} failed, trying next: ${errorMessage(error)}`);
      }
    }

    throw lastError;
  }

  destroy(): void {
    for (const backend of this.backends) backend.destroy();
    super.destroy();
  }
}

function buildProvider(): JsonRpcProvider {
  const urls = rpcUrls();
  if (urls.length === 1) return new JsonRpcProvider(urls[0]);
  return new SequentialJsonRpcProvider(urls);
}

function solverWallet(provider: JsonRpcProvider): Wallet {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env");
  return new Wallet(privateKey, provider);
}

async function postJson(url: string, body: unknown): Promise<void> {
  const payload = Buffer.from(JSON.stringify(body));
  await new Promise<void>((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Telegram HTTP ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function sendTelegramWithRetry(message: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendTelegram(message);
      return;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await sleep(1_500 * attempt);
    }
  }
  throw lastError;
}

function operationalNotificationsEnabled(): boolean {
  return !envFlag("DRY_RUN") &&
    !envFlag("TELEGRAM_DISABLED") &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function validateTelegramConfig(): void {
  if (envFlag("DRY_RUN") || envFlag("TELEGRAM_DISABLED")) return;
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required in live mode. " +
      "Set TELEGRAM_DISABLED=1 only if trade notifications are intentionally disabled."
    );
  }
}

function repoRoot(): string {
  if (process.env.SOLVER_REPO_ROOT) return process.env.SOLVER_REPO_ROOT;
  const candidates = [
    process.cwd(),
    __dirname,
    path.join(__dirname, "../.."),
  ];
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "deployedPool-WBTC_USDT-arbitrum.json")) ||
      fs.existsSync(path.join(candidate, "deployedMorphoPool-WBTC_USDT-arbitrum.json"))
    ) {
      return candidate;
    }
  }
  return process.cwd();
}

function deploymentSuffix(chainId: number): string {
  return chainId === 42161 ? "arbitrum" : String(chainId);
}

function marketDeploymentFilename(prefix: string, market: MarketId, chainId: number): string {
  return `${prefix}-${market}-${deploymentSuffix(chainId)}.json`;
}

function readMarketDeployment(prefix: string, market: MarketId, chainId: number): PoolDeployment {
  const preferred = marketDeploymentFilename(prefix, market, chainId);
  const preferredPath = path.join(repoRoot(), preferred);
  if (fs.existsSync(preferredPath)) {
    console.log(`Reading ${preferred}`);
    return JSON.parse(fs.readFileSync(preferredPath, "utf8")) as PoolDeployment;
  }

  const fallback = marketDeploymentFilename(prefix, market, 42161);
  const fallbackPath = path.join(repoRoot(), fallback);
  if (fs.existsSync(fallbackPath)) {
    console.log(`Reading ${fallback}`);
    return JSON.parse(fs.readFileSync(fallbackPath, "utf8")) as PoolDeployment;
  }

  throw new Error(`Missing deployment metadata for ${prefix} ${market}`);
}

function readFlashSolverAddress(chainId: number): string {
  if (process.env.FLASH_SOLVER_ADDRESS) return process.env.FLASH_SOLVER_ADDRESS;

  const filename = `deployedFlashSolver-${deploymentSuffix(chainId)}.json`;
  const filePath = path.join(repoRoot(), filename);
  if (!fs.existsSync(filePath)) {
    throw new Error("Missing FLASH_SOLVER_ADDRESS and deployedFlashSolver metadata");
  }
  const deployment = JSON.parse(fs.readFileSync(filePath, "utf8")) as FlashSolverDeployment;
  return deployment.flashSolver;
}

function deploymentFlashLoanProvider(market: MarketRuntime): string {
  const provider = market.protocol === "morpho"
    ? market.deployment.flashLoanProvider
    : market.deployment.aavePool;
  if (!provider) throw new Error(`${marketLabel(market)} deployment has no flash loan provider`);
  return provider;
}

async function resolveUniswapPool(market: PoolDeployment, signer: any, envNames: string[]): Promise<string> {
  const factoryAddress = process.env.UNISWAP_V3_FACTORY || ARBITRUM_UNIV3_FACTORY;
  const factory = new Contract(factoryAddress, UNIV3_FACTORY_ABI, signer);
  const fee = uniswapFeeFor(envNames);
  const pool = await factory.getPool(market.collateral, market.debt, fee);
  if (pool === ZeroAddress) {
    throw new Error(`No Uniswap V3 pool for ${market.market} fee=${fee}`);
  }
  return pool;
}

async function loadMarket(
  selection: MarketSelection,
  chainId: number,
  signer: any,
  flashSolver?: Contract
): Promise<MarketRuntime> {
  const deploymentPrefix = selection.protocol === "morpho" ? "deployedMorphoPool" : "deployedPool";
  const deployment = readMarketDeployment(deploymentPrefix, selection.market, chainId);
  const pool = new Contract(deployment.pool, SOFTBANDS_POOL_ABI, signer);
  const helper = new Contract(deployment.modules.helper, SOFTBANDS_HELPER_ABI, signer);
  const oracle = new Contract(deployment.oracle, ORACLE_ABI, signer);
  const aavePool = selection.protocol === "aave" && deployment.aavePool
    ? new Contract(deployment.aavePool, AAVE_POOL_ABI, signer)
    : undefined;
  const uniswapPool = await resolveUniswapPool(deployment, signer, [selection.key, selection.market]);

  await validateMarketDeployment(selection, deployment, pool);

  return {
    key: selection.key,
    protocol: selection.protocol,
    deployment,
    pool,
    helper,
    oracle,
    aavePool,
    flashSolver,
    uniswapPool,
  };
}

async function validateMarketDeployment(
  selection: MarketSelection,
  deployment: PoolDeployment,
  pool: Contract
): Promise<void> {
  const [collateral, debt, oracle, positionNFT, helper, owner, slot0] = await Promise.all([
    pool.collateralToken(),
    pool.debtToken(),
    pool.oracle(),
    pool.positionNFT(),
    pool.helper(),
    pool.owner(),
    pool.slot0(),
  ]);

  assertSameAddress(`${deployment.market} collateralToken`, String(collateral), deployment.collateral);
  assertSameAddress(`${deployment.market} debtToken`, String(debt), deployment.debt);
  assertSameAddress(`${deployment.market} oracle`, String(oracle), deployment.oracle);
  assertSameAddress(`${deployment.market} positionNFT`, String(positionNFT), deployment.positionNFT);
  assertSameAddress(`${deployment.market} helper`, String(helper), deployment.modules.helper);
  if (selection.protocol === "aave") {
    if (!deployment.aavePool) throw new Error(`${selection.key} deployment has no aavePool`);
    const aavePool = await pool.aavePool();
    assertSameAddress(`${selection.key} aavePool`, String(aavePool), deployment.aavePool);
  } else {
    if (!deployment.morphoMarketId) throw new Error(`${selection.key} deployment has no morphoMarketId`);
    const morphoMarketId = String(await pool.morphoMarketId());
    if (morphoMarketId.toLowerCase() !== deployment.morphoMarketId.toLowerCase()) {
      throw new Error(`${selection.key} morphoMarketId mismatch: live=${morphoMarketId}, expected=${deployment.morphoMarketId}`);
    }
    if (deployment.flashLoop) {
      assertSameAddress(`${selection.key} flashLoopModule`, String(await pool.flashLoopModule()), deployment.flashLoop);
    }
  }
  if (deployment.owner) {
    assertSameAddress(`${deployment.market} owner`, String(owner), deployment.owner);
  }

  console.log(
    `[${selection.key}] validated pool=${shortAddress(deployment.pool)} ` +
    `nft=${shortAddress(deployment.positionNFT)} oracle=${shortAddress(deployment.oracle)} ` +
    `helper=${shortAddress(deployment.modules.helper)} owner=${shortAddress(String(owner))} ` +
    `tick=${Number(slot0.tick)}`
  );
}

async function quoteAutoFill(
  market: MarketRuntime,
  direction: Direction,
  colPrice: bigint,
  debtPrice: bigint,
  oracleSqrt: bigint,
  softbandsSqrtLimitX96: bigint,
  maxAmountOverride?: bigint
): Promise<AuctionQuote | null> {
  const down = direction === "down";
  const slot0 = await market.pool.slot0();
  const currentSqrtStart = BigInt(slot0.sqrtPriceX96);
  const solverLimit = softbandsSqrtLimitX96;
  const limit = down
    ? (oracleSqrt > solverLimit ? oracleSqrt : solverLimit)
    : (oracleSqrt < solverLimit ? oracleSqrt : solverLimit);
  if (down ? limit >= currentSqrtStart : limit <= currentSqrtStart) return null;

  const configuredMaxAmount = configuredFillCap(market, direction);
  let maxAmount = maxAmountOverride ?? configuredMaxAmount ?? MAX_UINT256;
  if (configuredMaxAmount != null && configuredMaxAmount < maxAmount) {
    maxAmount = configuredMaxAmount;
  }
  if (maxAmount === 0n) return null;

  const [
    gapThresholdRaw,
    convexityKRaw,
    discountMaxRaw,
    lockedLtvBpsRaw,
    feeBpsRaw,
    liquidityRaw,
    balances,
  ] = await Promise.all([
    market.pool.gapThreshold(),
    market.pool.convexityK(),
    market.pool.discountMax(),
    market.pool.lockedLtvBps(),
    market.pool.protocolFeeBps(),
    market.pool.liquidity(),
    aggregateBalances(market),
  ]);

  let currentSqrt = currentSqrtStart;
  let currentTick = Number(slot0.tick);
  let currentLiquidity = BigInt(liquidityRaw);
  let currentCollateral = balances.currentCollateral;
  let currentDebt = balances.currentDebt;
  let amountOut = 0n;
  let amountIn = 0n;
  let steps = 0;
  const maxSteps = envInt("SOLVER_AUTO_QUOTE_MAX_STEPS", 4096);

  while ((down ? currentSqrt > limit : currentSqrt < limit) && amountOut < maxAmount) {
    if (steps >= maxSteps) {
      throw new Error(`auto quote exceeded SOLVER_AUTO_QUOTE_MAX_STEPS=${maxSteps}`);
    }
    steps++;

    const { nextTick, initialized: initializedAtWord } =
      await nextInitializedTickWithinOneWord(market, currentTick, down);
    const boundarySqrt = BigInt(await market.helper.getSqrtRatioAtTick(nextTick));
    let nextSqrt = down
      ? (boundarySqrt < limit ? limit : boundarySqrt)
      : (boundarySqrt > limit ? limit : boundarySqrt);
    let initialized = initializedAtWord;

    if (currentLiquidity > 0n) {
      const step = await market.helper.computeAuctionStep({
        down,
        currentSqrt,
        nextSqrt,
        currentLiquidity,
        remainingBudget: maxAmount - amountOut,
        currentDebt,
        currentCollateral,
        colPrice,
        debtPrice,
        collateralDecimals: market.deployment.collateralDecimals,
        debtDecimals: market.deployment.debtDecimals,
        lockedLtvBps: Number(lockedLtvBpsRaw),
        gapThreshold: BigInt(gapThresholdRaw),
        convexityK: BigInt(convexityKRaw),
        discountMax: BigInt(discountMaxRaw),
      });
      const stepOut = BigInt(step.stepOut);
      const stepActualIn = BigInt(step.stepActualIn);
      const newNextSqrt = BigInt(step.newNextSqrt);
      const isPartial = Boolean(step.isPartial);
      const stopAfterThisStep = Boolean(step.stopAfterThisStep);

      if (stopAfterThisStep) initialized = false;
      const stepTargetSqrt = isPartial ? newNextSqrt : nextSqrt;

      if (stepOut === 0n && stepActualIn === 0n) {
        if (stopAfterThisStep) {
          if (amountOut === 0n) return null;
          break;
        }
        if (stepTargetSqrt === currentSqrt) return null;
        nextSqrt = stepTargetSqrt;
      } else {
        if (stepOut > 0n && stepActualIn === 0n) return null;

        amountOut += stepOut;
        amountIn += stepActualIn;
        if (down) {
          currentDebt = stepActualIn >= currentDebt ? 0n : currentDebt - stepActualIn;
          currentCollateral = stepOut >= currentCollateral ? 0n : currentCollateral - stepOut;
        } else {
          currentDebt += stepOut;
          currentCollateral += stepActualIn;
        }

        if (isPartial) {
          nextSqrt = stepTargetSqrt;
          initialized = false;
        }
        if (stopAfterThisStep) {
          nextSqrt = stepTargetSqrt;
        }
      }
    }

    if (initialized && nextSqrt === boundarySqrt) {
      const tickInfo = await market.pool.ticks(nextTick);
      const liquidityNet = BigInt(tickInfo.liquidityNet);
      currentLiquidity = addSigned(currentLiquidity, down ? -liquidityNet : liquidityNet);
    }

    currentSqrt = nextSqrt;
    currentTick = nextSqrt === boundarySqrt
      ? (down ? nextTick - 1 : nextTick)
      : Number(await market.helper.getTickAtSqrtRatio(nextSqrt));
  }

  if (amountOut === 0n || amountIn === 0n) return null;

  const fee = protocolFee(amountIn, BigInt(feeBpsRaw));
  const flashAmount = applyBpsBuffer(amountIn + fee, flashBufferBpsFor(market, direction));
  const maxFlash = configuredMaxFlash(market, direction);
  if (maxFlash != null && flashAmount > maxFlash) {
    throw new Error(
      `auto flash ${formatToken(
        flashAmount,
        down ? market.deployment.debtDecimals : market.deployment.collateralDecimals,
        down ? market.deployment.debtSymbol : market.deployment.collateralSymbol,
      )} exceeds SOLVER_MAX_FLASH`
    );
  }

  return {
    amountOut,
    amountIn,
    flashAmount,
    maxFillAmount: amountOut,
    finalSqrtPriceX96: currentSqrt,
    finalTick: currentTick,
    steps,
  };
}

async function estimateAutoQuote(
  market: MarketRuntime,
  direction: Direction,
  colPrice: bigint,
  debtPrice: bigint,
  maxFillAmount: bigint
): Promise<AuctionQuote | null> {
  if (maxFillAmount === 0n) return null;
  const down = direction === "down";
  const feeBps = BigInt(await market.pool.protocolFeeBps());
  const amountIn = down
    ? colToDebtRoundingUp(market, maxFillAmount, colPrice, debtPrice)
    : debtToColRoundingUp(market, maxFillAmount, colPrice, debtPrice);
  if (amountIn === 0n) return null;

  const configuredBuffer = flashBufferBpsFor(market, direction);
  const fallbackBuffer = configuredBuffer > 500n ? configuredBuffer : 500n;
  const flashAmount = applyBpsBuffer(amountIn + protocolFee(amountIn, feeBps), fallbackBuffer);
  const maxFlash = configuredMaxFlash(market, direction);
  if (maxFlash != null && flashAmount > maxFlash) return null;

  return {
    amountOut: maxFillAmount,
    amountIn,
    flashAmount,
    maxFillAmount,
    finalSqrtPriceX96: 0n,
    finalTick: 0,
    steps: 0,
  };
}

async function simulateFlashExecution(
  market: MarketRuntime,
  direction: Direction,
  params: ExecutionPlan["params"]
): Promise<bigint> {
  if (executionMode() === "direct" || envFlag("SOLVER_SKIP_FLASH_SIMULATION")) return 0n;
  if (!market.flashSolver) throw new Error("Flash solver is required in flash execution mode");
  const fn = direction === "down"
    ? (market.flashSolver as any).executeFillDown
    : (market.flashSolver as any).executeFillUp;
  return BigInt(await fn.staticCall(params, {
    gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
  }));
}

async function buildExecutionPlan(
  market: MarketRuntime,
  direction: Direction,
  colPrice: bigint,
  debtPrice: bigint,
  oracleSqrt: bigint,
  recipient: string
): Promise<ExecutionPlan | null> {
  const d = market.deployment;
  const minProfitDebt = minProfitDebtFor(market);
  const softbandsSqrtLimitX96 = direction === "down" ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  const minProfit = direction === "down"
    ? minProfitDebt
    : debtToCol(market, minProfitDebt, colPrice, debtPrice);
  const profitDecimals = direction === "down" ? d.debtDecimals : d.collateralDecimals;
  const profitSymbol = direction === "down" ? d.debtSymbol : d.collateralSymbol;
  const fillCapDecimals = direction === "down" ? d.collateralDecimals : d.debtDecimals;
  const fillCapSymbol = direction === "down" ? d.collateralSymbol : d.debtSymbol;

  const buildParams = (flashAmount: bigint, maxFillAmount: bigint): ExecutionPlan["params"] => ({
    softbandsPool: d.pool,
    collateral: d.collateral,
    debt: d.debt,
    uniswapPool: market.uniswapPool,
    flashAmount,
    maxFillAmount,
    softbandsSqrtLimitX96,
    swapSqrtLimitX96: 0n,
    minProfit,
    profitRecipient: recipient,
  });

  const isAcceptableProfit = (profit: bigint) => solverMode() === "aggressive" || profit > 0n;

  let params: ExecutionPlan["params"];
  let simulatedProfit: bigint;

  if (flashMode() === "auto") {
    const fullQuote = await quoteAutoFill(
      market,
      direction,
      colPrice,
      debtPrice,
      oracleSqrt,
      softbandsSqrtLimitX96
    );
    if (!fullQuote) return null;

    type AutoAttempt = {
      quote: AuctionQuote;
      params: ExecutionPlan["params"];
      profit: bigint;
    };

    const tryQuote = async (quote: AuctionQuote): Promise<AutoAttempt | null> => {
      const candidateParams = buildParams(quote.flashAmount, quote.maxFillAmount);
      try {
        const profit = await simulateFlashExecution(market, direction, candidateParams);
        if (!isAcceptableProfit(profit)) return null;
        return { quote, params: candidateParams, profit };
      } catch (e) {
        if (envFlag("SOLVER_DEBUG_ERRORS")) {
          console.log(
            `[${marketLabel(market)}] auto candidate failed ` +
            `maxFill=${formatToken(quote.maxFillAmount, fillCapDecimals, fillCapSymbol)}: ` +
            errorMessage(e)
          );
        }
        return null;
      }
    };

    const quoteCandidate = async (candidateMax: bigint): Promise<AuctionQuote | null> => {
      return estimateAutoQuote(market, direction, colPrice, debtPrice, candidateMax);
    };

    let selected = await tryQuote(fullQuote);
    if (!selected) {
      console.log(
        `[${marketLabel(market)}] auto full quote not executable/profitable; searching smaller size ` +
        `fullOut=${formatToken(fullQuote.amountOut, fillCapDecimals, fillCapSymbol)} ` +
        `fullIn=${formatToken(fullQuote.amountIn, profitDecimals, profitSymbol)}`
      );

      let upperBad = fullQuote.maxFillAmount;
      let lowerGood = 0n;
      let lowerGoodAttempt: AutoAttempt | null = null;

      while (upperBad > 1n && !lowerGoodAttempt) {
        const candidateMax = upperBad / 2n;
        const quote = await quoteCandidate(candidateMax);
        if (!quote) {
          upperBad = candidateMax;
          continue;
        }

        const attempt = await tryQuote(quote);
        if (attempt) {
          lowerGood = quote.maxFillAmount;
          lowerGoodAttempt = attempt;
        } else {
          upperBad = candidateMax;
        }
      }

      if (!lowerGoodAttempt) return null;

      selected = lowerGoodAttempt;
      const searchSteps = envInt("SOLVER_AUTO_SEARCH_STEPS", 18);
      for (let i = 0; i < searchSteps && upperBad > lowerGood + 1n; i++) {
        const candidateMax = (lowerGood + upperBad) / 2n;
        const quote = await quoteCandidate(candidateMax);
        if (!quote || quote.maxFillAmount <= lowerGood) break;

        const attempt = await tryQuote(quote);
        if (attempt) {
          lowerGood = quote.maxFillAmount;
          selected = attempt;
        } else {
          upperBad = candidateMax;
        }
      }
    }

    params = selected.params;
    simulatedProfit = selected.profit;
    console.log(
      `[${marketLabel(market)}] auto selected ${direction} steps=${selected.quote.steps} ` +
      `quotedOut=${formatToken(selected.quote.amountOut, fillCapDecimals, fillCapSymbol)} ` +
      `quotedIn=${formatToken(selected.quote.amountIn, profitDecimals, profitSymbol)} ` +
      `targetTick=${selected.quote.finalTick}`
    );
  } else {
    const flashAmount = flashAmountFor(market, direction, colPrice, debtPrice);
    if (flashAmount === 0n) return null;

    const maxFillAmount = fillCapForFlash(market, direction, flashAmount, colPrice, debtPrice);
    if (maxFillAmount === 0n) return null;

    params = buildParams(flashAmount, maxFillAmount);
    simulatedProfit = await simulateFlashExecution(market, direction, params);
  }

  return {
    direction,
    params,
    simulatedProfit,
    profitDecimals,
    profitSymbol,
    fillCapDecimals,
    fillCapSymbol,
  };
}

function parseFillEvent(market: MarketRuntime, receipt: { logs: readonly unknown[] }): FillEvent | null {
  for (const log of receipt.logs) {
    try {
      const parsed = market.pool.interface.parseLog(log as any);
      if (parsed?.name === "Filled") {
        return {
          direction: "down",
          oldTick: Number(parsed.args.oldTick),
          newTick: Number(parsed.args.newTick),
          collateralOut: BigInt(parsed.args.collateralOut),
          debtIn: BigInt(parsed.args.debtIn),
          debtOut: 0n,
          collateralIn: 0n,
          lossAccrued: BigInt(parsed.args.lossAccrued),
        };
      }
      if (parsed?.name === "FilledUp") {
        return {
          direction: "up",
          oldTick: Number(parsed.args.oldTick),
          newTick: Number(parsed.args.newTick),
          collateralOut: 0n,
          debtIn: 0n,
          debtOut: BigInt(parsed.args.debtOut),
          collateralIn: BigInt(parsed.args.collateralIn),
          lossAccrued: BigInt(parsed.args.lossAccrued),
        };
      }
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null;
}

function parseFlashEvent(market: MarketRuntime, receipt: { logs: readonly unknown[] }): FlashEvent | null {
  if (!market.flashSolver) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = market.flashSolver.interface.parseLog(log as any);
      if (parsed?.name !== "FlashFillExecuted") continue;
      const direction = Number(parsed.args.direction) === 0 ? "down" : "up";
      return {
        direction,
        flashAsset: parsed.args.flashAsset,
        flashAmount: BigInt(parsed.args.flashAmount),
        flashPremium: BigInt(parsed.args.flashPremium),
        swapAmountOut: BigInt(parsed.args.swapAmountOut),
        profitAsset: parsed.args.profitAsset,
        profit: BigInt(parsed.args.profit),
      };
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null;
}

function buildTelegramMessage(
  market: MarketRuntime,
  fill: FillEvent,
  flash: FlashEvent | null,
  plan: ExecutionPlan,
  txHash: string,
  gap: bigint
): string {
  const d = market.deployment;
  const txUrl = d.chainId === 42161
    ? `https://arbiscan.io/tx/${txHash}`
    : `tx:${txHash}`;
  const title = fill.direction === "down" ? "flash soft liquidation fill" : "flash de-liquidation fillUp";
  const flow = fill.direction === "down"
    ? [
        `fill out: ${formatToken(fill.collateralOut, d.collateralDecimals, d.collateralSymbol)}`,
        `fill in: ${formatToken(fill.debtIn, d.debtDecimals, d.debtSymbol)}`,
      ]
    : [
        `fill out: ${formatToken(fill.debtOut, d.debtDecimals, d.debtSymbol)}`,
        `fill in: ${formatToken(fill.collateralIn, d.collateralDecimals, d.collateralSymbol)}`,
      ];
  const flashAmount = flash?.flashAmount ?? plan.params.flashAmount;
  const flashPremium = flash?.flashPremium ?? 0n;
  const profit = flash?.profit ?? plan.simulatedProfit;

  return [
    `<b>OpenLend ${htmlEscape(marketLabel(market))} ${title}</b>`,
    `pool: <code>${htmlEscape(shortAddress(d.pool))}</code>`,
    market.flashSolver
      ? `flash executor: <code>${htmlEscape(shortAddress(String((market.flashSolver as any).target)))}</code>`
      : `executor: <code>direct</code>`,
    `ticks: <code>${fill.oldTick} -> ${fill.newTick}</code>`,
    `gap: <code>${htmlEscape(formatBpsX18(gap))}</code>`,
    ...flow.map((line) => htmlEscape(line)),
    `flash: ${htmlEscape(formatToken(flashAmount, plan.profitDecimals, plan.profitSymbol))}`,
    `premium: ${htmlEscape(formatToken(flashPremium, plan.profitDecimals, plan.profitSymbol))}`,
    `loss: ${htmlEscape(formatToken(fill.lossAccrued, d.debtDecimals, d.debtSymbol))}`,
    `profit: ${htmlEscape(formatToken(profit, plan.profitDecimals, plan.profitSymbol))}`,
    `<a href="${htmlEscape(txUrl)}">transaction</a>`,
  ].join("\n");
}

function buildCursorSyncTelegramMessage(
  market: MarketRuntime,
  sync: CursorSyncResult,
  txHash: string,
  gap: bigint
): string {
  const d = market.deployment;
  const txUrl = d.chainId === 42161
    ? `https://arbiscan.io/tx/${txHash}`
    : `tx:${txHash}`;
  const action = sync.direction === "down" ? "empty cursor sync fill" : "empty cursor sync fillUp";
  const flow = sync.direction === "down"
    ? [
        `fill out: ${formatToken(sync.collateralOut, d.collateralDecimals, d.collateralSymbol)}`,
        `fill in: ${formatToken(sync.debtIn, d.debtDecimals, d.debtSymbol)}`,
      ]
    : [
        `fill out: ${formatToken(sync.debtOut, d.debtDecimals, d.debtSymbol)}`,
        `fill in: ${formatToken(sync.collateralIn, d.collateralDecimals, d.collateralSymbol)}`,
      ];

  return [
    `<b>OpenLend ${htmlEscape(marketLabel(market))} ${action}</b>`,
    `pool: <code>${htmlEscape(shortAddress(d.pool))}</code>`,
    `executor: <code>direct</code>`,
    `ticks: <code>${sync.oldTick} -> ${sync.newTick}</code>`,
    `gap: <code>${htmlEscape(formatBpsX18(gap))}</code>`,
    ...flow.map((line) => htmlEscape(line)),
    `loss: ${htmlEscape(formatToken(sync.lossAccrued, d.debtDecimals, d.debtSymbol))}`,
    `<a href="${htmlEscape(txUrl)}">transaction</a>`,
  ].join("\n");
}

function buildStatusTelegramMessage(
  status: "started" | "alive",
  address: string,
  chainId: number,
  flashSolverAddress: string | null,
  recipient: string,
  markets: MarketRuntime[],
  pollMs: number,
  uptimeMs: number
): string {
  const title = status === "started" ? "bot started" : "bot alive";
  return [
    `<b>OpenLend soft solver ${title}</b>`,
    `chainId: <code>${chainId}</code>`,
    `signer: <code>${htmlEscape(shortAddress(address))}</code>`,
    flashSolverAddress
      ? `flash executor: <code>${htmlEscape(shortAddress(flashSolverAddress))}</code>`
      : `executor: <code>direct</code>`,
    `profit recipient: <code>${htmlEscape(shortAddress(recipient))}</code>`,
    `markets: <code>${htmlEscape(markets.map(marketLabel).join(","))}</code>`,
    `mode: <code>${htmlEscape(solverMode())}</code>`,
    `flash mode: <code>${htmlEscape(flashMode())}</code>`,
    `poll: <code>${pollMs}ms</code>`,
    `uptime: <code>${htmlEscape(formatDuration(uptimeMs))}</code>`,
  ].join("\n");
}

async function sendOperationalNotification(
  status: "started" | "alive",
  address: string,
  chainId: number,
  flashSolverAddress: string | null,
  recipient: string,
  markets: MarketRuntime[],
  pollMs: number,
  startedAtMs: number
): Promise<void> {
  if (!operationalNotificationsEnabled()) return;

  const message = buildStatusTelegramMessage(
    status,
    address,
    chainId,
    flashSolverAddress,
    recipient,
    markets,
    pollMs,
    Date.now() - startedAtMs
  );
  try {
    await sendTelegramWithRetry(message);
  } catch (e) {
    console.error(`[telegram] ${status} notification failed: ${errorMessage(e)}`);
  }
}

async function forceApproveErc20(
  token: Contract,
  owner: string,
  spender: string,
  amount: bigint
): Promise<void> {
  const allowance = BigInt(await token.allowance(owner, spender));
  if (allowance >= amount) return;
  if (allowance > 0n) {
    await (await token.approve(spender, 0n)).wait();
  }
  await (await token.approve(spender, amount)).wait();
}

async function hardLiquidationTokenIds(market: MarketRuntime): Promise<bigint[]> {
  const configured = marketEnv("SOLVER_LIQUIDATION_TOKEN_IDS", market);
  if (configured && configured.toLowerCase() !== "all") {
    return parseBigIntList(configured);
  }

  const nft = new Contract(market.deployment.positionNFT, POSITION_NFT_ABI, (market.pool as any).runner);
  const nextTokenId = BigInt(await nft.nextTokenId());
  const maxScan = BigInt(envInt("SOLVER_LIQUIDATION_MAX_SCAN", 5000));
  const start = BigInt(envInt("SOLVER_LIQUIDATION_START_TOKEN_ID", 1));
  const endExclusive = nextTokenId < start + maxScan ? nextTokenId : start + maxScan;
  const ids: bigint[] = [];
  for (let tokenId = start; tokenId < endExclusive; tokenId++) ids.push(tokenId);
  return ids;
}

async function positionExists(market: MarketRuntime, tokenId: bigint): Promise<boolean> {
  const nft = new Contract(market.deployment.positionNFT, POSITION_NFT_ABI, (market.pool as any).runner);
  try {
    await nft.ownerOf(tokenId);
    return true;
  } catch {
    return false;
  }
}

async function processHardLiquidations(market: MarketRuntime, liquidator: string): Promise<void> {
  if (!envFlag("SOLVER_ENABLE_HARD_LIQUIDATION")) return;

  const ids = await hardLiquidationTokenIds(market);
  const maxPerMarket = envInt("SOLVER_LIQUIDATION_MAX_PER_MARKET", 3);
  const debtBufferBps = BigInt(envInt("SOLVER_LIQUIDATION_DEBT_BUFFER_BPS", 100));
  const threshold = BigInt(await market.pool.liquidationThresholdX18());
  const debtToken = new Contract(market.deployment.debt, ERC20_ABI, (market.pool as any).runner);
  let executed = 0;

  for (const tokenId of ids) {
    if (executed >= maxPerMarket) break;
    try {
      if (!(await positionExists(market, tokenId))) continue;

      const hf = BigInt(await market.pool.getHealthFactor(tokenId));
      if (hf >= threshold) continue;

      const state = await market.pool.getPositionState(tokenId);
      const debtPayment =
        BigInt(state.debt) +
        BigInt(state.debtInterest) +
        BigInt(state.protocolFeeDebt);
      if (debtPayment === 0n) {
        console.log(`[${marketLabel(market)}] skip liquidation tokenId=${tokenId} zero debt payment`);
        continue;
      }

      const approvalAmount = applyBpsBuffer(debtPayment, debtBufferBps);
      const debtBalance = BigInt(await debtToken.balanceOf(liquidator));
      if (debtBalance < approvalAmount) {
        console.log(
          `[${marketLabel(market)}] skip liquidation tokenId=${tokenId} ` +
          `hf=${formatBpsX18(hf)} threshold=${formatBpsX18(threshold)} ` +
          `debtBalance=${formatToken(debtBalance, market.deployment.debtDecimals, market.deployment.debtSymbol)} ` +
          `needed=${formatToken(approvalAmount, market.deployment.debtDecimals, market.deployment.debtSymbol)}`
        );
        continue;
      }

      await forceApproveErc20(debtToken, liquidator, market.deployment.pool, approvalAmount);
      console.log(
        `[${marketLabel(market)}] liquidate tokenId=${tokenId} ` +
        `hf=${formatBpsX18(hf)} threshold=${formatBpsX18(threshold)} ` +
        `maxDebtPayment=${formatToken(approvalAmount, market.deployment.debtDecimals, market.deployment.debtSymbol)}`
      );

      const tx = await market.pool.liquidate(tokenId, {
        gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
      });
      console.log(`[${marketLabel(market)}] liquidation tx=${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`${marketLabel(market)} liquidation failed: ${tx.hash}`);
      }
      executed++;
    } catch (e) {
      console.error(`[${marketLabel(market)}] liquidation tokenId=${tokenId} error: ${errorMessage(e)}`);
      if (envFlag("SOLVER_DEBUG_ERRORS")) console.error(debugErrorDetails(e));
    }
  }
}

async function processEmptyCursorSync(
  market: MarketRuntime,
  direction: Direction,
  cursorTick: number,
  oracleTick: number,
  oracleSqrt: bigint,
  gap: bigint
): Promise<boolean> {
  if (!emptyCursorSyncEnabled(market)) return false;

  const label = marketLabel(market);
  const currentLiquidity = BigInt(await market.pool.liquidity());
  if (currentLiquidity !== 0n) return false;

  const tickDistance = Math.abs(oracleTick - cursorTick);
  const maxTicks = emptyCursorSyncMaxTicks(market);
  if (maxTicks > 0 && tickDistance > maxTicks) {
    console.log(`[${label}] skip empty cursor sync tickDistance=${tickDistance} maxTicks=${maxTicks}`);
    return false;
  }

  const fn = direction === "down"
    ? (market.pool as any).fill
    : (market.pool as any).fillUp;

  let zeroSettlement: boolean;
  try {
    const simulated = await fn.staticCall(1n, oracleSqrt, {
      gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
    });
    const first = BigInt(simulated[0]);
    const second = BigInt(simulated[1]);
    zeroSettlement = first === 0n && second === 0n;
    if (!zeroSettlement) {
      console.log(
        `[${label}] skip empty cursor sync non-zero settlement ` +
        `${direction === "down" ? "collateralOut" : "debtOut"}=${first} ` +
        `${direction === "down" ? "debtIn" : "collateralIn"}=${second}`
      );
      return false;
    }
  } catch (e) {
    console.log(`[${label}] skip empty cursor sync static call failed: ${errorMessage(e)}`);
    if (envFlag("SOLVER_DEBUG_ERRORS")) console.error(debugErrorDetails(e));
    return false;
  }

  const action = direction === "down" ? "fill" : "fillUp";
  console.log(
    `[${label}] ${envFlag("DRY_RUN") ? "dry-run " : ""}empty cursor sync ${action} ` +
    `gap=${formatBpsX18(gap)} ticks=${cursorTick}->${oracleTick}`
  );

  if (envFlag("DRY_RUN")) return true;

  const tx = await fn(1n, oracleSqrt, {
    gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
  });
  console.log(`[${label}] empty cursor sync tx=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} empty cursor sync failed: ${tx.hash}`);
  }

  const fillEvent = parseFillEvent(market, receipt);
  if (!fillEvent) throw new Error(`${label} empty cursor sync receipt has no fill event: ${tx.hash}`);
  if (fillEvent.direction !== direction) {
    throw new Error(`${label} empty cursor sync emitted unexpected direction: ${tx.hash}`);
  }

  const sync: CursorSyncResult = {
    direction,
    oldTick: fillEvent.oldTick,
    newTick: fillEvent.newTick,
    debtOut: fillEvent.debtOut,
    collateralIn: fillEvent.collateralIn,
    collateralOut: fillEvent.collateralOut,
    debtIn: fillEvent.debtIn,
    lossAccrued: fillEvent.lossAccrued,
  };
  const message = buildCursorSyncTelegramMessage(market, sync, tx.hash, gap);
  try {
    await sendTelegramWithRetry(message);
  } catch (e) {
    console.error(`[${label}] Telegram notification failed: ${errorMessage(e)}`);
  }
  return true;
}

async function processMarket(market: MarketRuntime, recipient: string): Promise<void> {
  const d = market.deployment;
  const label = marketLabel(market);
  const slot0 = await market.pool.slot0();
  const cursorSqrt = BigInt(slot0.sqrtPriceX96);
  const cursorTick = Number(slot0.tick);
  const [colPriceRaw, debtPriceRaw, thresholdRaw] = await Promise.all([
    market.oracle.getPrice(d.collateral),
    market.oracle.getPrice(d.debt),
    market.pool.gapThreshold(),
  ]);
  const colPrice = BigInt(colPriceRaw);
  const debtPrice = BigInt(debtPriceRaw);
  const threshold = BigInt(thresholdRaw);
  const oracleSqrt = BigInt(await market.helper.priceToSqrtPriceX96(
    colPrice,
    debtPrice,
    d.collateralDecimals,
    d.debtDecimals,
  ));

  let direction: Direction | null = null;
  let gap = 0n;
  if (oracleSqrt < cursorSqrt) {
    direction = "down";
    gap = BigInt(await market.helper.computeGap(oracleSqrt, cursorSqrt));
  } else if (oracleSqrt > cursorSqrt) {
    direction = "up";
    gap = BigInt(await market.helper.computeGap(cursorSqrt, oracleSqrt));
  }

  if (!direction || gap <= threshold) {
    console.log(`[${label}] skip gap=${formatBpsX18(gap)} threshold=${formatBpsX18(threshold)}`);
    return;
  }

  const oracleTick = Number(await market.helper.getTickAtSqrtRatio(oracleSqrt));
  const minActionTicks = envInt("SOLVER_MIN_ACTION_TICKS", 0);
  const tickDistance = Math.abs(oracleTick - cursorTick);
  if (tickDistance < minActionTicks) {
    console.log(`[${label}] skip tickDistance=${tickDistance} minActionTicks=${minActionTicks}`);
    return;
  }

  if (direction === "down" && !envFlag("SOLVER_ENABLE_FILL_DOWN", true)) {
    console.log(`[${label}] skip fill disabled`);
    return;
  }
  if (direction === "up" && !envFlag("SOLVER_ENABLE_FILL_UP", true)) {
    console.log(`[${label}] skip fillUp disabled`);
    return;
  }

  if (await processEmptyCursorSync(market, direction, cursorTick, oracleTick, oracleSqrt, gap)) {
    return;
  }

  let plan: ExecutionPlan | null;
  try {
    plan = await buildExecutionPlan(market, direction, colPrice, debtPrice, oracleSqrt, recipient);
  } catch (e) {
    console.log(`[${label}] flash simulation reverted/not profitable: ${errorMessage(e)}`);
    if (envFlag("SOLVER_DEBUG_ERRORS")) console.error(e);
    return;
  }
  if (!plan) {
    console.log(`[${label}] skip zero flash amount`);
    return;
  }

  if (solverMode() === "profitOnly" && plan.simulatedProfit <= 0n) {
    console.log(`[${label}] skip zero flash profit`);
    return;
  }

  const mode = executionMode();
  const action = direction === "down"
    ? (mode === "direct" ? "fill" : "executeFillDown")
    : (mode === "direct" ? "fillUp" : "executeFillUp");
  console.log(
    `[${label}] ${envFlag("DRY_RUN") ? "dry-run " : ""}${action} ` +
    `gap=${formatBpsX18(gap)} ticks=${cursorTick}->${oracleTick} ` +
    `flash=${formatToken(plan.params.flashAmount, plan.profitDecimals, plan.profitSymbol)} ` +
    `fillCap=${formatToken(plan.params.maxFillAmount, plan.fillCapDecimals, plan.fillCapSymbol)} ` +
    `flashProfit=${formatToken(plan.simulatedProfit, plan.profitDecimals, plan.profitSymbol)}`
  );

  if (envFlag("DRY_RUN")) return;

  let tx: { hash: string; wait: () => Promise<any> };
  if (mode === "direct") {
    tx = direction === "down"
      ? await (market.pool as any).fill(plan.params.maxFillAmount, plan.params.softbandsSqrtLimitX96, {
          gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
        })
      : await (market.pool as any).fillUp(plan.params.maxFillAmount, plan.params.softbandsSqrtLimitX96, {
          gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
        });
  } else {
    const fn = direction === "down"
      ? (market.flashSolver as any).executeFillDown
      : (market.flashSolver as any).executeFillUp;
    tx = await fn(plan.params, {
      gasLimit: envInt("SOLVER_GAS_LIMIT", 30_000_000),
    });
  }
  console.log(`[${label}] tx=${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} ${action} failed: ${tx.hash}`);

  const fillEvent = parseFillEvent(market, receipt);
  if (!fillEvent) throw new Error(`${label} ${action} receipt has no fill event: ${tx.hash}`);
  const flashEvent = parseFlashEvent(market, receipt);

  const message = buildTelegramMessage(market, fillEvent, flashEvent, plan, tx.hash, gap);
  try {
    await sendTelegramWithRetry(message);
  } catch (e) {
    console.error(`[${label}] Telegram notification failed: ${errorMessage(e)}`);
  }
}

export async function runSoftSolver(options: RunSoftSolverOptions = {}) {
  const startedAtMs = options.startedAtMs ?? Date.now();
  const provider = options.provider ?? buildProvider();
  const solver = options.signer ?? solverWallet(provider);
  const network = await provider.getNetwork();
  const chainId = options.chainId ?? Number(network.chainId);

  const address = await solver.getAddress();
  const recipient = options.recipient ?? profitRecipient(address);
  if (!isAddress(recipient)) throw new Error(`Invalid SOLVER_PROFIT_RECIPIENT: ${recipient}`);

  const mode = executionMode();
  let flashSolverAddress: string | null = null;
  let flashSolver: Contract | undefined;
  if (mode === "flash") {
    flashSolverAddress = options.flashSolverAddress ?? readFlashSolverAddress(chainId);
    if (!isAddress(flashSolverAddress)) throw new Error(`Invalid FLASH_SOLVER_ADDRESS: ${flashSolverAddress}`);

    flashSolver = new Contract(flashSolverAddress, FLASH_SOLVER_ABI, solver);
    const flashOwner = String(await flashSolver.owner());
    if (flashOwner.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`PRIVATE_KEY signer ${address} is not SoftbandsFlashSolver owner ${flashOwner}`);
    }
  } else if (options.flashSolverAddress || process.env.FLASH_SOLVER_ADDRESS) {
    flashSolverAddress = options.flashSolverAddress ?? process.env.FLASH_SOLVER_ADDRESS ?? null;
    if (flashSolverAddress && !isAddress(flashSolverAddress)) {
      throw new Error(`Invalid FLASH_SOLVER_ADDRESS: ${flashSolverAddress}`);
    }
    if (flashSolverAddress) flashSolver = new Contract(flashSolverAddress, FLASH_SOLVER_ABI, solver);
  }

  const requestedMarkets = options.markets ?? parseMarkets();
  const markets = await Promise.all(
    requestedMarkets.map((market) => loadMarket(market, chainId, solver, flashSolver))
  );
  if (mode === "flash" && flashSolver) {
    const flashAavePool = String(await flashSolver.aavePool());
    for (const market of markets) {
      assertSameAddress(
        `${marketLabel(market)} flash solver aavePool`,
        flashAavePool,
        deploymentFlashLoanProvider(market)
      );
    }
  }
  console.log(
    `OpenLend solver starting: address=${address}, chainId=${chainId}, ` +
    `executor=${flashSolverAddress ?? "direct"}, profitRecipient=${recipient}, ` +
    `markets=${markets.map(marketLabel).join(",")}, mode=${solverMode()}, ` +
    `flashMode=${flashMode()}, executionMode=${executionMode()}, ` +
    `dryRun=${envFlag("DRY_RUN")}, rpcEndpoints=${options.provider ? "custom" : rpcUrls().length}`
  );
  for (const market of markets) {
    console.log(`[${marketLabel(market)}] uniswapPool=${market.uniswapPool}`);
  }
  validateTelegramConfig();
  if (operationalNotificationsEnabled()) {
    console.log("Telegram notifications enabled");
  }

  const pollMs = envInt("SOLVER_POLL_MS", 10_000);
  const heartbeatMs = envDurationMs("SOLVER_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS);
  const once = options.once ?? envFlag("SOLVER_ONCE");
  await sendOperationalNotification(
    "started",
    address,
    chainId,
    flashSolverAddress,
    recipient,
    markets,
    pollMs,
    startedAtMs
  );

  let nextHeartbeatAtMs = startedAtMs + heartbeatMs;
  do {
    for (const market of markets) {
      try {
        await processHardLiquidations(market, address);
        await processMarket(market, recipient);
      } catch (e) {
        console.error(`[${marketLabel(market)}] error: ${errorMessage(e)}`);
        if (envFlag("SOLVER_DEBUG_ERRORS")) console.error(debugErrorDetails(e));
      }
    }
    if (!once && Date.now() >= nextHeartbeatAtMs) {
      await sendOperationalNotification(
        "alive",
        address,
        chainId,
        flashSolverAddress,
        recipient,
        markets,
        pollMs,
        startedAtMs
      );
      while (nextHeartbeatAtMs <= Date.now()) nextHeartbeatAtMs += heartbeatMs;
    }
    if (!once) await sleep(pollMs);
  } while (!once);
}

if (require.main === module) {
  runSoftSolver()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
