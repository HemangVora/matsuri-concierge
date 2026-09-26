import { Contract } from 'ethers';
import { erc20Iface, yenToWei } from '@mc/core';
import { env } from './env.ts';
import { wallet } from './chain.ts';

const coin = new Contract(env.deployments.stablecoin, erc20Iface, wallet);
const budget = yenToWei(env.policy.dailyBudgetYen);
await (await coin.approve(env.deployments.voucher, budget)).wait(1);
console.log(`voucher allowance for ${wallet.address} set to ¥${env.policy.dailyBudgetYen}`);
