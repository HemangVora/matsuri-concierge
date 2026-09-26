export function createSignerClient(url: string) {
  return {
    async sign(proposalId: string): Promise<{ txHashes: string[] }> {
      const res = await fetch(`${url}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId }) });
      const body = await res.json() as { txHashes?: string[]; error?: string };
      if (!res.ok || !body.txHashes) throw new Error(body.error ?? `signer HTTP ${res.status}`);
      return { txHashes: body.txHashes };
    },
  };
}
