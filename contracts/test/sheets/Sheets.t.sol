// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorSheets} from "../../src/FactorSheets.sol";

contract SheetsTest is Test {
    FactorSheets s;
    address keeper = address(0xBEEF);
    address other = address(0xCAFE);
    event Sealed(address indexed by, uint64 indexed hour, bytes32 root, uint32 sheets);

    function setUp() public {
        vm.warp(1_790_000_000);
        s = new FactorSheets();
    }

    function hourNow() internal view returns (uint64) { return uint64(block.timestamp / 1 hours); }

    function test_seal_writes_once() public {
        uint64 h = hourNow();
        vm.expectEmit(true, true, false, true);
        emit Sealed(keeper, h, bytes32(uint256(7)), 3);
        vm.prank(keeper);
        s.seal(h, bytes32(uint256(7)), 3);
        assertEq(s.rootOf(keeper, h), bytes32(uint256(7)));
        assertEq(s.sheetsOf(keeper, h), 3);
        assertEq(s.lastHour(keeper), h);
        vm.prank(keeper);
        vm.expectRevert(FactorSheets.AlreadySealed.selector);
        s.seal(h, bytes32(uint256(8)), 3);
        assertEq(s.rootOf(keeper, h), bytes32(uint256(7)), "a sealed root never changes");
    }

    function test_posters_are_separate() public {
        uint64 h = hourNow();
        vm.prank(other);
        s.seal(h, bytes32(uint256(1)), 1);
        vm.prank(keeper);
        s.seal(h, bytes32(uint256(2)), 1);
        assertEq(s.rootOf(other, h), bytes32(uint256(1)));
        assertEq(s.rootOf(keeper, h), bytes32(uint256(2)), "another poster cannot take the keeper's hour");
    }

    function test_refusals() public {
        uint64 h = hourNow();
        vm.startPrank(keeper);
        vm.expectRevert(FactorSheets.NoRoot.selector);
        s.seal(h, bytes32(0), 1);
        vm.expectRevert(FactorSheets.NoSheets.selector);
        s.seal(h, bytes32(uint256(1)), 0);
        vm.expectRevert(FactorSheets.FutureHour.selector);
        s.seal(h + 1, bytes32(uint256(1)), 1);
        s.seal(h - 5, bytes32(uint256(1)), 1); // a late hour is fine
        s.seal(h, bytes32(uint256(2)), 1);
        assertEq(s.lastHour(keeper), h);
        s.seal(h - 2, bytes32(uint256(3)), 1);
        assertEq(s.lastHour(keeper), h, "an older hour does not move lastHour back");
        vm.stopPrank();
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_proves() public {
        bytes32 a = keccak256("a"); bytes32 b = keccak256("b"); bytes32 c = keccak256("c");
        bytes32 ab = _pair(a, b);
        bytes32 root = _pair(ab, c);
        uint64 h = hourNow();
        vm.prank(keeper);
        s.seal(h, root, 3);
        bytes32[] memory pa = new bytes32[](2); pa[0] = b; pa[1] = c;
        assertTrue(s.proves(keeper, h, a, pa));
        bytes32[] memory pc = new bytes32[](1); pc[0] = ab;
        assertTrue(s.proves(keeper, h, c, pc));
        assertFalse(s.proves(keeper, h, keccak256("d"), pc), "a leaf not in the tree");
        assertFalse(s.proves(other, h, a, pa), "nobody else's root");
        assertFalse(s.proves(keeper, h - 1, a, pa), "an hour not sealed");
    }

    function testFuzz_seal_any_root(bytes32 root, uint32 n, uint64 back) public {
        vm.assume(root != bytes32(0) && n > 0);
        uint64 h = hourNow() - (back % 10_000);
        vm.prank(keeper);
        s.seal(h, root, n);
        assertEq(s.rootOf(keeper, h), root);
        vm.prank(keeper);
        vm.expectRevert(FactorSheets.AlreadySealed.selector);
        s.seal(h, root, n);
    }

    function test_holds_nothing() public {
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        (bool ok, ) = address(s).call{value: 1}("");
        assertFalse(ok, "no receive: the contract takes no ETH");
    }
}
