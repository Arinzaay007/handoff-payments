// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal non-custodial alias registry. This contract never receives or moves funds.
/// @dev Audit, add access controls, and test name-normalisation rules before any production deployment.
contract UsernameRegistry {
    struct Record {
        address wallet;
        address owner;
    }

    mapping(bytes32 => Record) private records;

    event UsernameClaimed(bytes32 indexed usernameHash, string username, address indexed owner, address wallet);
    event WalletUpdated(bytes32 indexed usernameHash, address indexed oldWallet, address indexed newWallet);

    error UsernameUnavailable();
    error NotOwner();
    error InvalidWallet();

    function claimUsername(string calldata username, address wallet) external {
        if (wallet == address(0)) revert InvalidWallet();
        bytes32 hash = keccak256(bytes(_normalise(username)));
        if (records[hash].owner != address(0)) revert UsernameUnavailable();
        records[hash] = Record({wallet: wallet, owner: msg.sender});
        emit UsernameClaimed(hash, username, msg.sender, wallet);
    }

    function updateWallet(string calldata username, address newWallet) external {
        if (newWallet == address(0)) revert InvalidWallet();
        bytes32 hash = keccak256(bytes(_normalise(username)));
        Record storage record = records[hash];
        if (record.owner != msg.sender) revert NotOwner();
        address oldWallet = record.wallet;
        record.wallet = newWallet;
        emit WalletUpdated(hash, oldWallet, newWallet);
    }

    function resolve(string calldata username) external view returns (address) {
        return records[keccak256(bytes(_normalise(username)))].wallet;
    }

    /// @dev UI/API must enforce stronger rules (ASCII-only, length, confusables) before calling claim.
    function _normalise(string calldata username) private pure returns (string calldata) {
        return username;
    }
}
