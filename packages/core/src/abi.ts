import { Interface } from 'ethers';

export const voucherIface = new Interface([
  'function buyVoucher(uint256 eventId, uint256 quantity)',
  'function eventInfo(uint256 eventId) view returns (uint256 price, uint256 available, address stall)',
  'event VoucherPurchased(address indexed buyer, uint256 indexed eventId, uint256 quantity, address indexed stall, uint256 amount)',
]);

export const settlementIface = new Interface([
  'function settle(bytes32 billId, address from, address to, uint256 amount, uint256 deadline, bytes signature)',
  'event ShareSettled(bytes32 indexed billId, address indexed from, address indexed to, uint256 amount)',
]);

export const erc20Iface = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
