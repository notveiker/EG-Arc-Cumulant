// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test USDC (6 decimals) — a stand-in for Arc's canonical USDC at 0x3600…0000.
///         Used in unit tests, on a local Anvil node, AND deployed to Arc testnet as a
///         freely-mintable collateral token so demos aren't capped by the $20 faucet limit.
///         Anyone can `mint`/`faucet` test USDC and `redeem` (burn) it. Testnet only.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test USDC to any address (no cap).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Mint test USDC to yourself — the open faucet (no cap).
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /// @notice Redeem (burn) your test USDC.
    function redeem(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
