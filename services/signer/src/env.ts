import { readFileSync } from 'node:fs';
import type { Deployments, PolicyConfig } from '@mc/core';
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
export const env = {
  port: Number(process.env.PORT ?? 8788),
  apiUrl: process.env.API_URL ?? 'http://127.0.0.1:8787',
  rpcUrl: need('RPC_URL'),
  interceptaKey: process.env.INTERCEPTA_API_KEY ?? '',
  approver: need('APPROVER_ADDRESS'),
  agentKey: need('AGENT_PRIVATE_KEY'),
  deployments: JSON.parse(readFileSync(new URL('../../../deployments.json', import.meta.url), 'utf8')) as Deployments,
  // The signer loads its own copy of the policy; the api cannot loosen it.
  policy: JSON.parse(readFileSync(new URL('../../../config/policy.json', import.meta.url), 'utf8')) as PolicyConfig,
};
