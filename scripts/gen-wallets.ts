import { Wallet } from 'ethers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function upsert(file: string, key: string, value: string) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const next = lines.filter((l) => !l.startsWith(`${key}=`));
  next.push(`${key}=${value}`);
  writeFileSync(file, next.join('\n') + '\n', { mode: 0o600 });
}
function has(file: string, key: string) {
  return existsSync(file) && readFileSync(file, 'utf8').split('\n').some((l) => l.startsWith(`${key}=0x`));
}

const plan: Array<[string, string, string]> = [
  ['services/signer/.env', 'AGENT_PRIVATE_KEY', 'AGENT_ADDRESS'],
  ['services/friends/.env', 'AOI_PRIVATE_KEY', 'AOI_ADDRESS'],
  ['services/friends/.env', 'MEI_PRIVATE_KEY', 'MEI_ADDRESS'],
];
for (const [file, keyVar, addrVar] of plan) {
  if (has(file, keyVar)) continue;
  const w = Wallet.createRandom();
  upsert(file, keyVar, w.privateKey);
  upsert(file, addrVar, w.address);
  console.log(`${addrVar}=${w.address}`);
}
