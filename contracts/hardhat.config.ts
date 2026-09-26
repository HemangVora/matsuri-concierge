import { defineConfig } from 'hardhat/config';
import hardhatIgnition from '@nomicfoundation/hardhat-ignition';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatEthersChaiMatchers from '@nomicfoundation/hardhat-ethers-chai-matchers';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';
import hardhatMultibaasPlugin from 'hardhat-multibaas-plugin';
import 'dotenv/config';

// Configure Awaji and Sepolia for deployment.
// Awaji と Sepolia のデプロイ設定。
const mbHost = process.env.MB_HOST ?? '';
const mbApiKey = process.env.MB_ADMIN_API_KEY ?? '';
// Load the linking plugin only when credentials are set so local tests work without secrets.
// ローカルテストに秘密情報が不要になるよう、認証情報がある場合のみ紐付けプラグインを読み込む。
const multibaasPlugins = mbHost && mbApiKey ? [hardhatMultibaasPlugin] : [];

export default defineConfig({
  solidity: '0.8.33',
  plugins: [hardhatIgnition, hardhatEthers, hardhatEthersChaiMatchers, hardhatMocha, ...multibaasPlugins],
  ignition: {
    requiredConfirmations: 1
  },
  networks: {
    awaji: {
      type: 'http',
      chainType: 'l1',
      // Use the configured RPC endpoint, or the public default.
      // 設定済み RPC エンドポイント、または公開の既定値を使う。
      url: process.env.AWAJI_RPC_URL || 'https://rpc.awaji.mizuhiki.io',
      chainId: 6_497,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : []
    },
    sepolia: {
      type: 'http',
      chainType: 'l1',
      // Use the configured RPC endpoint, or the public default.
      // 設定済み RPC エンドポイント、または公開の既定値を使う。
      url: process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org',
      chainId: 11_155_111,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : []
    }
  },
  // MultiBaas admin config used by the plugin to register and link contracts.
  // コントラクト登録とリンクのための MultiBaas 管理設定。
  mbConfig: {
    apiKey: mbApiKey,
    host: mbHost,
    allowUpdateAddress: ['awaji', 'sepolia'],
    allowUpdateContract: ['awaji', 'sepolia'],
    // MB_SYNC_EXISTING=1 links contracts from an earlier, interrupted run.
    // MB_SYNC_EXISTING=1 で中断した実行のコントラクトも紐付ける。
    syncExisting: process.env.MB_SYNC_EXISTING === '1',
  }
});
