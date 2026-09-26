// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';

// Simple issuer-controlled stablecoin for the demo.
// デモ用の発行者管理ステーブルコイン。
contract MatsuriStablecoin is ERC20, Ownable {
    // The issuer becomes the owner and can mint/burn.
    // 発行者がオーナーとなり、mint/burn を実行できる。
    constructor(string memory name_, string memory symbol_, address issuer) ERC20(name_, symbol_) Ownable(issuer) {}

    // Mint tokens to a recipient (issuer only).
    // 受取先へ発行（発行者のみ）。
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Burn tokens from an address (issuer only).
    // 指定アドレスから焼却（発行者のみ）。
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
