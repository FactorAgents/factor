// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FactorSheets: the hourly seal of every agent's balance sheet
/// @notice Each hour Factor reads every agent's balance sheet (what it holds and what it owes on Factor's contracts),
/// hashes each sheet into a Merkle tree and writes the tree's root here. A root is written once per poster and hour and
/// can never be changed or removed afterwards, so a sheet shown later can be proven to be the one sealed that hour.
/// Anyone may post roots; a reader decides whose roots it trusts by the poster's address, which every Sealed event
/// carries (Factor publishes its keeper's). The contract holds no ETH, has no owner and no settings.
contract FactorSheets {
    /// @notice A root written: who wrote it, for which hour (unix seconds / 3600), the root and how many sheets are in it.
    event Sealed(address indexed by, uint64 indexed hour, bytes32 root, uint32 sheets);

    /// @notice The root a poster wrote for an hour, or zero.
    mapping(address => mapping(uint64 => bytes32)) public rootOf;
    /// @notice How many sheets a poster's root for an hour holds.
    mapping(address => mapping(uint64 => uint32)) public sheetsOf;
    /// @notice The last hour a poster sealed.
    mapping(address => uint64) public lastHour;

    error NoRoot();
    error NoSheets();
    error FutureHour();
    error AlreadySealed();

    /// @notice Write the root of an hour's balance sheets. Once per poster and hour; never for an hour that has not begun.
    function seal(uint64 hour, bytes32 root, uint32 sheets) external {
        if (root == bytes32(0)) revert NoRoot();
        if (sheets == 0) revert NoSheets();
        if (hour > block.timestamp / 1 hours) revert FutureHour();
        if (rootOf[msg.sender][hour] != bytes32(0)) revert AlreadySealed();
        rootOf[msg.sender][hour] = root;
        sheetsOf[msg.sender][hour] = sheets;
        if (hour > lastHour[msg.sender]) lastHour[msg.sender] = hour;
        emit Sealed(msg.sender, hour, root, sheets);
    }

    /// @notice Whether a leaf (one sheet's hash) is in the root a poster sealed for an hour. Sorted-pair Merkle proof.
    function proves(address by, uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = rootOf[by][hour];
        if (root == bytes32(0)) return false;
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}
