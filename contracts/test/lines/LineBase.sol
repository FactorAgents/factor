// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeskBase} from "../DeskBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";

/// The desk of the other tests with a line contract beside it, and the moves the line's tests start from.
abstract contract LineBase is DeskBase {
    FactorLine internal line;
    address internal seeder = makeAddr("the owner, seeding the line pool");

    function setUp() public virtual override {
        super.setUp();
        line = new FactorLine(desk);
    }

    // ---------- the moves ----------

    function _seed(uint256 amount) internal {
        vm.deal(seeder, seeder.balance + amount);
        vm.prank(seeder);
        (bool ok,) = address(line).call{value: amount}("");
        assertTrue(ok, "a seed goes in");
    }

    function _open(address key) internal returns (FactorLineAccount acct) {
        vm.prank(key);
        acct = FactorLineAccount(payable(line.open()));
    }

    function _acct(address key) internal view returns (FactorLineAccount) {
        return FactorLineAccount(payable(line.accountOf(key)));
    }

    /// The key adds a bond at its line account, with ETH it sends.
    function _lineBond(address key, uint256 amount) internal {
        FactorLineAccount acct = _acct(key);
        vm.deal(key, key.balance + amount);
        vm.prank(key);
        acct.addBond{value: amount}(0);
    }

    function _lineDraw(address key, uint256 amount, bool compute) internal {
        vm.prank(key);
        line.draw(amount, compute);
    }

    /// A customer hires the line account for `price`, it delivers, the customer accepts: the payout (less the 2% job
    /// fee) lands in the account and the fee counts toward its limit.
    function _earn(address key, uint256 price) internal returns (uint256 id) {
        id = _earnFrom(customer, key, price);
    }

    function _earnFrom(address from, address key, uint256 price) internal returns (uint256 id) {
        FactorLineAccount acct = _acct(key);
        id = _lockFrom(from, address(acct), price, false);
        vm.prank(key);
        acct.deliver(id, keccak256("the work"));
        vm.prank(from);
        desk.accept(id);
    }

    /// The line contract holds exactly its pool and what it owes wallets, and its pool's books add up.
    function _lineBooks() internal view {
        assertEq(
            address(line).balance, line.pool() + line.owedTotal(), "the line holds exactly its pool and what it owes"
        );
        assertEq(
            line.pool() + line.out() + line.lost(),
            line.totalPoolIn() + line.totalFeesToPool(),
            "everything put in is here, out with lines, or lost"
        );
    }

    function _fee(uint256 amount) internal pure returns (uint256 fee, uint256 burned, uint256 toPool) {
        fee = (amount * 200) / 10_000;
        burned = (amount * 100) / 10_000;
        toPool = fee - burned;
    }
}

/// A key that refuses ETH: its draws wait in the line as owed.
contract RefusingKey {
    FactorDesk internal desk;
    FactorLine internal line;

    constructor(FactorDesk d, FactorLine l) {
        desk = d;
        line = l;
    }

    function register() external {
        desk.register();
    }

    function open() external returns (address) {
        return line.open();
    }

    function draw(uint256 amount, bool compute) external {
        line.draw(amount, compute);
    }

    function addBond(uint256 fromBalance) external payable {
        FactorLineAccount(payable(line.accountOf(address(this)))).addBond{value: msg.value}(fromBalance);
    }

    function collectTo(address payable to) external {
        line.collectTo(to);
    }
}

/// A key that eats every bit of gas it is given when ETH arrives.
contract GasEatingKey {
    FactorDesk internal desk;
    FactorLine internal line;

    constructor(FactorDesk d, FactorLine l) {
        desk = d;
        line = l;
    }

    receive() external payable {
        while (true) {}
    }

    function register() external {
        desk.register();
    }

    function open() external returns (address) {
        return line.open();
    }

    function addBond() external payable {
        FactorLineAccount(payable(line.accountOf(address(this)))).addBond{value: msg.value}(0);
    }

    function draw(uint256 amount, bool compute) external {
        line.draw(amount, compute);
    }
}

/// A key that calls back in when its cash arrives: it tries to draw again, to withdraw from its account, and to
/// recover its own line. Whatever it manages is recorded.
contract ReenteringKey {
    FactorDesk internal desk;
    FactorLine internal line;
    uint256 public tries;
    bool public drewAgain;
    bool public withdrew;

    constructor(FactorDesk d, FactorLine l) {
        desk = d;
        line = l;
    }

    receive() external payable {
        if (tries > 0) return;
        tries += 1;
        (bool a,) = address(line).call(abi.encodeCall(FactorLine.draw, (0.0001 ether, false)));
        drewAgain = a;
        address acct = line.accountOf(address(this));
        (bool b,) = acct.call(abi.encodeCall(FactorLineAccount.withdraw, (payable(address(this)), 1)));
        withdrew = b;
    }

    function register() external {
        desk.register();
    }

    function open() external returns (address) {
        return line.open();
    }

    function addBond() external payable {
        FactorLineAccount(payable(line.accountOf(address(this)))).addBond{value: msg.value}(0);
    }

    function draw(uint256 amount, bool compute) external {
        line.draw(amount, compute);
    }
}
