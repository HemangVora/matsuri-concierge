import { useEffect, useState } from 'react';
import { BrowserProvider } from 'ethers';
import { ApiError, approve, getProposal } from './api.ts';

export default function Approve({ id }: { id: string }) {
  const [p, setP] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);
  const [msg, setMsg] = useState('');
  const [signing, setSigning] = useState(false);
  useEffect(() => {
    void getProposal(id)
      .then(setP)
      .catch(() => setNotFound(true));
  }, [id]);
  if (notFound) return <div className="panel approve-page"><h1>Proposal not found</h1><p>This approval link is invalid or has already been used.</p></div>;
  if (!p) return <p className="panel">Loading…</p>;

  async function sign() {
    setSigning(true);
    try {
      const eth = (window as any).ethereum;
      if (!eth) { setMsg('No wallet found — install MetaMask to approve.'); return; }
      // Ask the wallet to switch to the same chain the typed-data domain is bound to before signing,
      // so a wallet left on the wrong network can't produce a signature that verifyApproval (bound to
      // that exact chainId) will refuse. Sepolia is 11155111 -> 0xaa36a7.
      const chainIdHex = `0x${Number(p.typedData.domain.chainId).toString(16)}`;
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
      } catch (switchErr: any) {
        setMsg(`Switch MetaMask to chain ${chainIdHex} to continue: ${switchErr?.message ?? 'network switch failed'}`);
        return;
      }
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      if ((await signer.getAddress()).toLowerCase() !== p.approver.toLowerCase()) { setMsg(`Switch MetaMask to ${p.approver}`); return; }
      const expiresAt = Math.floor(Date.now() / 1000) + 600;
      setMsg('Signing…');
      const signature = await signer.signTypedData(p.typedData.domain, p.typedData.types, { proposalHash: p.hash, totalYen: p.totalYen, expiresAt });
      setMsg('Waiting for the signer…');
      const r = await approve(id, { signature, totalYen: p.totalYen, expiresAt });
      setMsg(`Approved · ${r.execution.status}`);
    } catch (e: any) {
      // An ApiError is a structured rejection from the api (e.g. "totalYen does not match" from a
      // 400); anything else is a wallet/MetaMask failure (no provider, wrong network, user rejected
      // the signature request) and gets its own message instead of being mislabeled "Rejected".
      setMsg(e instanceof ApiError ? `Rejected: ${e.message}` : (e?.message ?? 'Signing failed'));
    } finally {
      setSigning(false);
    }
  }
  return (
    <div className="panel approve-page">
      <h1>✋ Approve ¥{p.totalYen}?</h1>
      {(p.decision.lines ?? [p.decision]).map((l: any, i: number) => <div key={i} className={`verdict ${l.action.toLowerCase()}`}>{l.action} {l.stallName ?? l.to} ×{l.qty ?? ''} ¥{l.subtotalYen ?? l.amountYen}</div>)}
      <p>Why you're asked: {p.decision.approvalReasons?.join('; ')}</p>
      <p className="hash">Proposal hash {p.hash}</p>
      <button onClick={sign} disabled={signing || p.status !== 'awaiting_approval'}>{signing ? (msg || 'Signing…') : 'Sign approval'}</button>
      <p>{msg}</p>
    </div>
  );
}
