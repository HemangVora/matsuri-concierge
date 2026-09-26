import { readFileSync } from 'node:fs';
import type { Deployments } from '@mc/core';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const deployments = JSON.parse(readFileSync(new URL('../../../deployments.json', import.meta.url), 'utf8')) as Deployments;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  chainId: deployments.chainId,
  deployments,
  mbBaseUrl: need('MB_BASE_URL'),
  mbApiKey: need('MB_API_KEY'),
  interceptaKey: process.env.INTERCEPTA_API_KEY ?? '',
  agentAddress: need('AGENT_ADDRESS'),
  approverAddress: need('APPROVER_ADDRESS'),
  signerUrl: process.env.SIGNER_URL ?? 'http://127.0.0.1:8788',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
  anthropicModel: process.env.AGENT_MODEL ?? 'claude-opus-5',
  agentEffort: (process.env.AGENT_EFFORT ?? 'medium') as 'low' | 'medium' | 'high',
};
