import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ContractFactory, JsonRpcProvider, Wallet, isAddress } from "ethers";
import solc from "solc";

dotenv.config({ quiet: true });

type PoolDeployment = {
  chainId: number;
  network: string;
  aavePool: string;
};

function repoRoot(): string {
  return __dirname;
}

function deploymentSuffix(chainId: number): string {
  return chainId === 42161 ? "arbitrum" : String(chainId);
}

function readPoolDeployment(chainId: number): PoolDeployment {
  const suffix = deploymentSuffix(chainId);
  const filename = `deployedPool-WBTC_USDT-${suffix}.json`;
  const fallback = "deployedPool-WBTC_USDT-arbitrum.json";
  const preferredPath = path.join(repoRoot(), filename);
  const fallbackPath = path.join(repoRoot(), fallback);
  const filePath = fs.existsSync(preferredPath) ? preferredPath : fallbackPath;
  if (!fs.existsSync(filePath)) throw new Error("Missing WBTC_USDT pool deployment metadata");
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PoolDeployment;
}

function compileFlashSolver(): { abi: unknown[]; bytecode: string } {
  const sourceName = "contracts/SoftbandsFlashSolver.sol";
  const sourcePath = path.join(repoRoot(), sourceName);
  const input = {
    language: "Solidity",
    sources: {
      [sourceName]: {
        content: fs.readFileSync(sourcePath, "utf8"),
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      viaIR: true,
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length > 0) {
    for (const error of errors) console.error(error.formattedMessage || error.message);
    throw new Error("SoftbandsFlashSolver solc compilation failed");
  }

  const contract = output.contracts?.[sourceName]?.SoftbandsFlashSolver;
  if (!contract?.abi || !contract?.evm?.bytecode?.object) {
    throw new Error("SoftbandsFlashSolver compilation output missing");
  }
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  };
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

function rpcRequestTimeoutMs(): number {
  const value = process.env.RPC_REQUEST_TIMEOUT_MS;
  if (value == null || value === "") return 15_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("RPC_REQUEST_TIMEOUT_MS must be a non-negative integer");
  }
  return parsed;
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
    const timeoutMs = rpcRequestTimeoutMs();
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
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[rpc] endpoint ${index + 1}/${this.backends.length} failed, trying next: ${message}`);
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

function deployerWallet(provider: JsonRpcProvider): Wallet {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env");
  return new Wallet(privateKey, provider);
}

async function main() {
  const provider = buildProvider();
  const deployer = deployerWallet(provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  const poolDeployment = readPoolDeployment(chainId);
  const aavePool = process.env.AAVE_POOL || poolDeployment.aavePool;
  const owner = process.env.FLASH_SOLVER_OWNER || await deployer.getAddress();

  if (!isAddress(aavePool)) throw new Error(`Invalid AAVE_POOL: ${aavePool}`);
  if (!isAddress(owner)) throw new Error(`Invalid FLASH_SOLVER_OWNER: ${owner}`);

  console.log(`Deploying SoftbandsFlashSolver on chainId=${chainId}`);
  console.log(`Aave pool: ${aavePool}`);
  console.log(`Owner: ${owner}`);

  const compiled = compileFlashSolver();
  const Factory = new ContractFactory(compiled.abi, compiled.bytecode, deployer);
  const solver = await Factory.deploy(aavePool, owner);
  await solver.waitForDeployment();
  const address = await solver.getAddress();
  const deploymentTx = solver.deploymentTransaction();

  const output = {
    network: chainId === 42161 ? "arbitrum-one" : `chain-${chainId}`,
    chainId,
    flashSolver: address,
    aavePool,
    owner,
    deployedAt: new Date().toISOString(),
    deployer: await deployer.getAddress(),
    txHash: deploymentTx?.hash ?? null,
  };
  const filename = `deployedFlashSolver-${deploymentSuffix(chainId)}.json`;
  fs.writeFileSync(path.join(repoRoot(), filename), JSON.stringify(output, null, 2) + "\n");

  console.log(`SoftbandsFlashSolver: ${address}`);
  console.log(`Wrote ${filename}`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
