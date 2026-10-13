// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A price feed whose answer a rehearsal sets: put in place of a real feed's code on a LOCAL fork only
/// (engine/scripts/rehearse.ts), so that prices move while a rehearsed week goes by in minutes. It answers
/// latestRoundData() in Chainlink's shape and nothing else. It is never deployed anywhere.
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
