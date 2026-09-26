import { formatUnits, parseUnits } from 'ethers';

export const yenToWei = (yen: number): bigint => parseUnits(String(Math.trunc(yen)), 18);
export const weiToYen = (wei: bigint): number => Number(formatUnits(wei, 18));
