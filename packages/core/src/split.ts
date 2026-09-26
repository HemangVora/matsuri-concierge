export function splitBill(input: {
  organizer: string; participants: string[]; payments: { name: string; amountYen: number }[];
}) {
  const { organizer, participants } = input;
  if (!participants.includes(organizer)) throw new Error('Organizer must be a participant');
  for (const p of input.payments) {
    if (!participants.includes(p.name)) throw new Error(`${p.name} is not a participant`);
    if (!Number.isInteger(p.amountYen) || p.amountYen < 0) throw new Error('Payments must be whole yen');
  }
  const totalYen = input.payments.reduce((s, p) => s + p.amountYen, 0);
  const base = Math.floor(totalYen / participants.length);
  const remainder = totalYen - base * participants.length;
  const shares: Record<string, number> = {};
  participants.forEach((name, i) => { shares[name] = base + (i < remainder ? 1 : 0); });

  const paid: Record<string, number> = Object.fromEntries(participants.map((p) => [p, 0]));
  for (const p of input.payments) paid[p.name] += p.amountYen;

  const transfers: { from: string; to: string; amountYen: number }[] = [];
  for (const name of participants) {
    if (name === organizer) continue;
    const balance = paid[name] - shares[name];
    if (balance < 0) transfers.push({ from: name, to: organizer, amountYen: -balance });
  }
  for (const name of participants) {
    if (name === organizer) continue;
    const balance = paid[name] - shares[name];
    if (balance > 0) transfers.push({ from: organizer, to: name, amountYen: balance });
  }
  return { totalYen, shares, transfers };
}
