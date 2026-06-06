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

function rpcUrl(): string {
  const url = process.env.ARBITRUM_RPC_URL || process.env.RPC_URL;
  if (!url) throw new Error("Set ARBITRUM_RPC_URL in .env");
  return url;
}

function deployerWallet(provider: JsonRpcProvider): Wallet {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env");
  return new Wallet(privateKey, provider);
}

async function main() {
  const provider = new JsonRpcProvider(rpcUrl());
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
