import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { erc20Iface, yenToWei } from '@mc/core';
import deployments from '../../../deployments.json' with { type: 'json' };

const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', deployments.chainId);
for (const key of [process.env.AOI_PRIVATE_KEY!, process.env.MEI_PRIVATE_KEY!]) {
  const w = new Wallet(key, provider);
  const coin = new Contract(deployments.stablecoin, erc20Iface, w);
  await (await coin.approve(deployments.settlement, yenToWei(5000))).wait(1);
  console.log(`${w.address} approved settlement for ¥5000`);
}
