// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IPonsToken} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorAccount, FactorAccounts} from "../../src/FactorAccount.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";

/// Credit lines against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the
/// chain (nothing here is sent anywhere): a line contract is deployed beside the live desk, which knows nothing of it,
/// and an agent opens a line, draws as cash and as compute, is hired and paid at its line account by a real job on
/// the live desk, and that payment repays the line before the agent can take the rest. The fee's burn half is spent
/// on $FACTOR by the live burn pot.
contract LinesForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorBurnPot constant POT = FactorBurnPot(payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79));
    FactorAccounts constant ACCOUNTS = FactorAccounts(0x3417A303DcB62A84965a641f894ff5803502F8FA);
    address constant GATEWAY = 0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0;

    FactorLine line;
    address key;
    address buyer;

    function setUp() public {
        _fork();
        line = new FactorLine(DESK);
        key = makeAddr("an agent on the live desk");
        buyer = makeAddr("a customer of the live desk");
        vm.deal(key, 1 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(line).call{value: 0.1 ether}("");
        assertTrue(ok);
        vm.prank(key);
        DESK.register();
    }

    function _deskBooks() internal view {
        assertGe(
            address(DESK).balance,
            DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal(),
            "the live desk holds its books"
        );
    }

    function _lineBooks() internal view {
        assertEq(address(line).balance, line.pool() + line.owedTotal());
        assertEq(line.pool() + line.out() + line.lost(), line.totalPoolIn() + line.totalFeesToPool());
    }

    function test_fork_theLineReadsTheLiveDesksAddresses() public view {
        assertEq(line.burnPot(), address(POT));
        assertEq(line.gateway(), GATEWAY);
        assertEq(DESK.gateway(), GATEWAY);
        assertEq(address(line.desk()), address(DESK));
    }

    function test_fork_aWholeLineAgainstTheLiveDesk() public {
        uint256 deskPool = DESK.pool();
        vm.prank(key);
        FactorLineAccount acct = FactorLineAccount(payable(line.open()));
        assertTrue(DESK.agent(address(acct)).registered, "the account registered on the live desk");
        assertEq(address(acct), line.accountAddress(key));

        // a bond at the account, a cash draw and a compute draw
        vm.prank(key);
        acct.addBond{value: 0.01 ether}(0);
        assertEq(line.canDraw(key), 0.01 ether);
        uint256 potBefore = address(POT).balance;
        uint256 gwBefore = GATEWAY.balance;
        uint256 keyBefore = key.balance;
        vm.prank(key);
        line.draw(0.004 ether, false);
        vm.prank(key);
        line.draw(0.002 ether, true);
        assertEq(key.balance - keyBefore, 0.00392 ether);
        assertEq(GATEWAY.balance - gwBefore, 0.00196 ether, "compute reached the live gateway");
        assertEq(address(POT).balance - potBefore, 0.00006 ether, "the burn half reached the live burn pot");
        assertEq(line.debtOf(address(acct)), 0.006 ether);

        // a real job on the live desk, locked for the line account, delivered and accepted
        vm.prank(buyer);
        uint256 id = DESK.lock{value: 0.01 ether}(address(acct), block.timestamp + 1 days, false);
        vm.prank(key);
        acct.deliver(id, keccak256("the work"));
        vm.prank(buyer);
        DESK.accept(id);
        assertEq(address(acct).balance, 0.0098 ether, "the payout landed in the line account");
        assertEq(DESK.pool() - deskPool, 0.0002 ether, "the live desk's pool took its job fee");
        assertEq(line.limit(address(acct)), 0.0102 ether, "the job's fee raised the limit");

        // the agent wants its pay: the line is paid first
        vm.prank(key);
        acct.withdraw(payable(key), 0.0038 ether);
        assertEq(line.debtOf(address(acct)), 0);
        assertEq(line.line(address(acct)).onTime, 1);
        assertEq(address(acct).balance, 0);
        _deskBooks();
        _lineBooks();
    }

    function test_fork_aPasskeyAccountOpensALine() public {
        address walletKey = makeAddr("a Factor account's wallet key");
        FactorAccount.Key memory first =
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(walletKey))), bytes32(0));
        address payable fa = payable(ACCOUNTS.create(first, ""));
        vm.deal(fa, 0.1 ether);
        FactorAccount.Call[] memory calls = new FactorAccount.Call[](4);
        calls[0] = FactorAccount.Call(address(DESK), 0, abi.encodeCall(FactorDesk.register, ()));
        calls[1] = FactorAccount.Call(address(line), 0, abi.encodeCall(FactorLine.open, ()));
        calls[2] =
            FactorAccount.Call(line.accountAddress(fa), 0.01 ether, abi.encodeCall(FactorLineAccount.addBond, (0)));
        calls[3] = FactorAccount.Call(address(line), 0, abi.encodeCall(FactorLine.draw, (0.005 ether, false)));
        vm.prank(walletKey);
        FactorAccount(fa).run(calls);
        assertEq(line.debtOf(line.accountOf(fa)), 0.005 ether);
        assertEq(fa.balance, 0.1 ether - 0.01 ether + 0.0049 ether);
        _lineBooks();
    }

    function test_fork_theBurnHalfIsBurnedByTheLivePot() public {
        vm.prank(key);
        FactorLineAccount acct = FactorLineAccount(payable(line.open()));
        vm.prank(key);
        acct.addBond{value: 0.05 ether}(0);
        vm.prank(key);
        line.draw(0.05 ether, false);
        IPonsToken token = IPonsToken(address(POT.token()));
        vm.warp(block.timestamp + 1 days + 1);
        (bool open,,) = POT.market();
        if (!open) return;
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = POT.burn(0);
        assertGt(ethIn, 0);
        assertGt(burned, 0);
        assertEq(supply - token.totalSupply(), burned, "the supply fell by what was burned");
    }

    function test_fork_aLineDefaultsAndTheLiveDeskIsUntouched() public {
        vm.prank(key);
        FactorLineAccount acct = FactorLineAccount(payable(line.open()));
        // fees at the account from a real job, the payout withdrawn, then a draw that is never repaid
        vm.prank(buyer);
        uint256 id = DESK.lock{value: 0.5 ether}(address(acct), block.timestamp + 1 days, false);
        vm.prank(key);
        acct.deliver(id, keccak256("w"));
        vm.prank(buyer);
        DESK.accept(id);
        vm.prank(key);
        acct.withdraw(payable(key), 0.49 ether);
        vm.prank(key);
        line.draw(0.01 ether, false);
        uint256 deskPool = DESK.pool();
        vm.warp(block.timestamp + 61 days);
        line.recover(address(acct));
        assertTrue(line.line(address(acct)).defaulted);
        assertEq(line.lost(), 0.01 ether);
        assertEq(DESK.pool(), deskPool, "the live desk's pool is not touched by a line's default");
        assertFalse(DESK.agent(address(acct)).barred, "and the desk does not know of it");
        _deskBooks();
        _lineBooks();
    }
}
