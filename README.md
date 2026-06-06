# OpenLend Solver Bot

Public solver for OpenLend Softbands markets on Arbitrum.

The bot watches the Softbands oracle/cursor gap and executes:

- soft liquidation fills: `fill`
- soft de-liquidation fills: `fillUp`
- optional hard liquidations: `liquidate`

The recommended live path is flash mode. Each operator must deploy their own
`SoftbandsFlashSolver`, because the flash executor is owner-gated.

## Requirements

- Node.js 20+
- An Arbitrum RPC URL
- An Arbitrum wallet with ETH for gas
- A personal `SoftbandsFlashSolver` for flash mode

Hard liquidation is disabled by default. If enabled, the wallet must also hold
the relevant debt tokens, because hard liquidation pays user debt directly.

## Install

```bash
git clone https://github.com/Open-Lending/solver-bot.git
cd solver-bot
npm install
cp .env.example .env
```

Edit `.env`:

```bash
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xYOUR_SOLVER_WALLET_PRIVATE_KEY
TELEGRAM_DISABLED=1
```

## Deploy Your Flash Solver

Flash mode requires a solver contract owned by your bot wallet.

```bash
npm run deploy:flash-solver
```

This writes a local `deployedFlashSolver-arbitrum.json`. The file is ignored by
git because it is operator-specific.

## Dry Run

After deploying the flash solver:

```bash
npm run dry
```

Dry run validates deployments, quotes markets once, and does not send
transactions.

## Live Run

```bash
npm run start
```

Useful environment variables:

```bash
SOLVER_MARKETS=AAVE_WBTC_USDT,AAVE_WETH_USDT,AAVE_USDT_WBTC,AAVE_USDT_WETH,MORPHO_WBTC_USDT,MORPHO_WETH_USDT
SOLVER_MODE=profitOnly
SOLVER_FLASH_MODE=auto
SOLVER_EXECUTION_MODE=flash
SOLVER_POLL_MS=10000
SOLVER_MIN_PROFIT_DEBT=0.000001
```

`profitOnly` skips fills that do not produce positive simulated flash profit.
`aggressive` allows non-profitable fills and is mostly useful for testing,
operations, or direct mode.

## Direct Mode

Direct mode does not use flash loans. It calls pool `fill` / `fillUp` directly
and uses the wallet's own token balances.

```bash
SOLVER_EXECUTION_MODE=direct
SOLVER_MODE=aggressive
npm run start
```

Direct mode is useful as a fallback, but public operators should prefer flash
mode because it does not require pre-funding large token balances.

## Hard Liquidations

Hard liquidations are opt-in:

```bash
SOLVER_ENABLE_HARD_LIQUIDATION=1
SOLVER_LIQUIDATION_TOKEN_IDS=all
SOLVER_LIQUIDATION_MAX_SCAN=5000
SOLVER_LIQUIDATION_MAX_PER_MARKET=3
```

The bot scans NFT token ids, checks `healthFactor < liquidationThreshold`, and
calls `liquidate(tokenId)` when the wallet has enough debt token balance.

Keep this disabled until the wallet is funded and you understand the market debt
tokens required for each position.

## Telegram Notifications

Telegram is optional:

```bash
TELEGRAM_DISABLED=0
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Live mode requires either valid Telegram settings or `TELEGRAM_DISABLED=1`.

## Safety Notes

- Never commit `.env` or private keys.
- Run `npm run dry` after every config change.
- Use a dedicated wallet with limited funds.
- Deploy a personal flash solver; do not reuse another operator's solver.
- Keep `SOLVER_ENABLE_HARD_LIQUIDATION=0` unless intentionally running hard
  liquidations with funded debt-token balances.

## Included Arbitrum Markets

- Aave `WBTC/USDT`
- Aave `WETH/USDT`
- Aave reverse `USDT/WBTC`
- Aave reverse `USDT/WETH`
- Morpho `WBTC/USDT`
- Morpho `WETH/USDT`
