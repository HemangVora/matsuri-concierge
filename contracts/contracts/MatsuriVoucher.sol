// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { ERC721 } from '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';

// Based on curvegrid/matsuri-stablecoin-sample-app (MIT). Change: each item pays its own stall.
// Curvegrid サンプル (MIT) を元に、商品ごとに屋台へ直接支払うよう変更。
contract MatsuriVoucher is ERC721, Ownable {
    struct EventInfo {
        uint256 price;
        uint256 available;
        address stall;
    }

    IERC20 public immutable stablecoin;

    mapping(uint256 => EventInfo) private events;
    mapping(address => mapping(uint256 => uint256)) private balances;
    mapping(uint256 => uint256) private tokenEvent;
    mapping(address => mapping(uint256 => uint256[])) private ownedEventTokens;
    uint256 private nextTokenId = 1;

    event EventConfigured(uint256 indexed eventId, uint256 price, uint256 available, address indexed stall);
    event VoucherPurchased(address indexed buyer, uint256 indexed eventId, uint256 quantity, address indexed stall, uint256 amount);
    event VoucherRedeemed(address indexed holder, uint256 indexed eventId, uint256 quantity);

    constructor(address stablecoinAddress, address owner_) ERC721('Matsuri Voucher', 'MVCHR') Ownable(owner_) {
        stablecoin = IERC20(stablecoinAddress);
    }

    function setEvent(uint256 eventId, uint256 price, uint256 available, address stall) external onlyOwner {
        require(stall != address(0), 'Stall required');
        events[eventId] = EventInfo({ price: price, available: available, stall: stall });
        emit EventConfigured(eventId, price, available, stall);
    }

    function buyVoucher(uint256 eventId, uint256 quantity) external {
        EventInfo storage info = events[eventId];
        require(info.price > 0, 'Event not found');
        require(quantity > 0, 'Quantity required');
        require(info.available >= quantity, 'Not enough availability');

        uint256 totalCost = info.price * quantity;
        require(stablecoin.transferFrom(msg.sender, info.stall, totalCost), 'Payment failed');
        info.available -= quantity;

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = nextTokenId++;
            _safeMint(msg.sender, tokenId);
            tokenEvent[tokenId] = eventId;
            ownedEventTokens[msg.sender][eventId].push(tokenId);
            balances[msg.sender][eventId] += 1;
        }
        emit VoucherPurchased(msg.sender, eventId, quantity, info.stall, totalCost);
    }

    function redeemVoucher(uint256 eventId, uint256 quantity) external {
        require(balances[msg.sender][eventId] >= quantity, 'Insufficient vouchers');
        for (uint256 i = 0; i < quantity; i++) {
            uint256[] storage stack = ownedEventTokens[msg.sender][eventId];
            uint256 tokenId = stack[stack.length - 1];
            stack.pop();
            delete tokenEvent[tokenId];
            _burn(tokenId);
            balances[msg.sender][eventId] -= 1;
        }
        emit VoucherRedeemed(msg.sender, eventId, quantity);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        require(from == address(0) || to == address(0), 'Transfers disabled');
        return from;
    }

    function balanceOf(address owner_, uint256 eventId) external view returns (uint256) {
        return balances[owner_][eventId];
    }

    function eventInfo(uint256 eventId) external view returns (uint256 price, uint256 available, address stall) {
        EventInfo storage info = events[eventId];
        return (info.price, info.available, info.stall);
    }
}
