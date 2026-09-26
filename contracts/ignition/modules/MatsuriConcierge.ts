import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { ethers } from 'ethers';
import { mb } from 'hardhat-multibaas-plugin/ignition';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load config/stalls.json via readFileSync instead of a JSON import attribute:
// Hardhat's module loader doesn't reliably resolve `with { type: 'json' }` here.
// Hardhat のモジュールローダーが `with { type: 'json' }` を確実に解決できないため、
// JSON インポート属性の代わりに readFileSync で config/stalls.json を読み込む。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stalls = JSON.parse(readFileSync(path.join(__dirname, '../../../config/stalls.json'), 'utf-8'));

export default buildModule('MatsuriConcierge', (m) => {
  if (!process.env.MB_HOST || !process.env.MB_ADMIN_API_KEY) {
    throw new Error('Set MB_HOST and MB_ADMIN_API_KEY');
  }
  const owner = m.getAccount(0);
  const stablecoin = m.contract('MatsuriStablecoin', ['Matsuri Yen', 'MJPY', owner]);
  const voucher = m.contract('MatsuriVoucher', [stablecoin, owner]);
  const settlement = m.contract('KanjoSettlement', [stablecoin]);

  mb.link(stablecoin, { contractLabel: 'mc_stablecoin', contractVersion: '1.0', addressAlias: 'mc_stablecoin' });
  mb.link(voucher, { contractLabel: 'mc_voucher', contractVersion: '1.0', addressAlias: 'mc_voucher' });
  mb.link(settlement, { contractLabel: 'mc_settlement', contractVersion: '1.0', addressAlias: 'mc_settlement' });

  for (const s of stalls) {
    m.call(voucher, 'setEvent', [s.itemId, ethers.parseUnits(String(s.priceYen), 18), s.available, s.payTo], {
      id: `setEvent_${s.itemId}`,
    });
  }
  return { stablecoin, voucher, settlement };
});
