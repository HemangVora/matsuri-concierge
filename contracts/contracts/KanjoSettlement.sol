// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { EIP712 } from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import { ECDSA } from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

// Moves a friend's bill share only to the recipient, amount and bill the friend signed.
// 友人が署名した宛先・金額・伝票に対してのみ割り勘分を移動する。
contract KanjoSettlement is EIP712 {
    bytes32 public constant SHARE_TYPEHASH =
        keccak256('Share(bytes32 billId,address from,address to,uint256 amount,uint256 deadline)');

    IERC20 public immutable token;
    mapping(bytes32 => mapping(address => bool)) public settled;

    event ShareSettled(bytes32 indexed billId, address indexed from, address indexed to, uint256 amount);

    constructor(address token_) EIP712('KanjoSettlement', '1') {
        token = IERC20(token_);
    }

    function settle(
        bytes32 billId,
        address from,
        address to,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, 'Expired');
        require(!settled[billId][from], 'Already settled');
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SHARE_TYPEHASH, billId, from, to, amount, deadline)));
        require(ECDSA.recover(digest, signature) == from, 'Bad signature');
        settled[billId][from] = true;
        require(token.transferFrom(from, to, amount), 'Transfer failed');
        emit ShareSettled(billId, from, to, amount);
    }
}
