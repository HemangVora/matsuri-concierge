import { useEffect, useState } from 'react';
import { BrowserProvider } from 'ethers';
import { approve, getProposal } from './api.ts';

export default function Approve({ id }: { id: string }) {
  const [p, setP] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    void getProposal(id)
      .then((r) => (r?.error ? setNotFound(true) : setP(r)))
      .catch(() => setNotFound(true));
  }, [id]);
  if (notFound) return <div className="panel approve-page"><h1>Proposal not found</h1><p>This approval link is invalid or has already been used.</p></div>;
  if (!p) return <p className="panel">Loading…</p>;

  async function sign() {
    try {
      const eth = (window as any).ethereum;
      if (!eth) { setMsg('No wallet found — install MetaMask to approve.'); return; }
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      if ((await signer.getAddress()).toLowerCase() !== p.approver.toLowerCase()) { setMsg(`Switch MetaMask to ${p.approver}`); return; }
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      const signature = await signer.signTypedData(p.typedData.domain, p.typedData.types, { proposalHash: p.hash, totalYen: p.totalYen, expiresAt });
      const r = await approve(id, { signature, totalYen: p.totalYen, expiresAt });
      setMsg(r.ok ? `Approved · ${r.execution.status}` : `Rejected: ${r.reason}`);
    } catch (e: any) {
      setMsg(e?.message ?? 'Signing failed');
    }
  }
  return (
    <div className="panel approve-page">
      <h1>✋ Approve ¥{p.totalYen}?</h1>
      {(p.decision.lines ?? [p.decision]).map((l: any, i: number) => <div key={i} className={`verdict ${l.action.toLowerCase()}`}>{l.action} {l.stallName ?? l.to} ×{l.qty ?? ''} ¥{l.subtotalYen ?? l.amountYen}</div>)}
      <p>Why you're asked: {p.decision.approvalReasons?.join('; ')}</p>
      <p className="hash">Proposal hash {p.hash}</p>
      <button onClick={sign} disabled={p.status !== 'awaiting_approval'}>Sign approval</button>
      <p>{msg}</p>
    </div>
  );
}
