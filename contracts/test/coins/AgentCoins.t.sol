// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {CoinBase} from "./CoinBase.sol";
import {AgentCoinLauncher} from "../../src/AgentCoinLauncher.sol";
import {AgentCoinSplitter, IAgentDesk} from "../../src/AgentCoinSplitter.sol";
import {FactorAccount} from "../../src/FactorAccount.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {ForceSend, GasEater, Reenterer, Rejecter} from "../mocks/Actors.sol";
import {MockCurve, MockFactorToken, MockFactory} from "../mocks/MockPons.sol";

/// The coin launcher and the splitter it makes for every coin: who may launch, what is forced, the four shares to the
/// wei, refused payments, a barred agent, and the attacks that matter.
contract AgentCoinsTest is CoinBase {
    event CoinLaunched(
        address indexed agent,
        address indexed coin,
        address indexed maker,
        address splitter,
        address curve,
        bool bySignature,
        uint256 openingBuyEth,
        uint256 openingBuyTokens
    );
    event Split(
        uint256 amount,
        uint256 toCompute,
        uint256 toMaker,
        uint256 toBurn,
        uint256 toOwner,
        bool computePushed,
        bool makerPushed,
        bool burnPushed,
        bool ownerPushed
    );
    event ComputePaid(address indexed agent, uint256 amount);
    event ComputeBurned(address indexed agent, uint256 amount);
    event PendingDelivered(address indexed to, uint256 amount);
    event CoinBurned(uint256 amount);

    // ---------- what the launcher is ----------

    function test_everyAddressIsReadFromTheChain() public view {
        assertEq(address(launcher.desk()), address(desk));
        assertEq(launcher.burnPot(), address(burnPot));
        assertEq(launcher.gateway(), gateway);
        assertEq(launcher.owner(), admin);
        assertEq(address(launcher.factory()), address(factory));
        assertEq(address(launcher.escrow()), address(escrow));
        assertEq(launcher.CREATOR_TAX_BPS(), 300);
        assertEq(launcher.coinCount(), 0);
        assertEq(launcher.launchFee(), factory.launchFee());
    }

    function test_aLauncherNeedsADesk() public {
        vm.expectRevert(AgentCoinLauncher.ZeroAddress.selector);
        new AgentCoinLauncher(IAgentDesk(address(0)));
    }

    /// Nothing about the launcher or a splitter can be changed by anybody: the functions that could do so are absent.
    function test_nothingCanBeSet() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        string[9] memory sigs = [
            "setOwner(address)",
            "setGateway(address)",
            "setBurnPot(address)",
            "setShares(uint16,uint16)",
            "transferOwnership(address)",
            "withdraw(address,uint256)",
            "setDesk(address)",
            "setMaker(address)",
            "setAgent(address)"
        ];
        for (uint256 i = 0; i < sigs.length; ++i) {
            vm.startPrank(admin);
            (bool ok,) = address(launcher).call(abi.encodeWithSignature(sigs[i], admin, admin));
            assertFalse(ok, sigs[i]);
            (ok,) = address(s).call(abi.encodeWithSignature(sigs[i], admin, admin));
            assertFalse(ok, sigs[i]);
            vm.stopPrank();
        }
    }

    // ---------- a launch ----------

    function test_theMakerLaunchesWithTheAgentsPermission() public {
        (MockFactorToken coin, AgentCoinSplitter s, MockCurve c) = _launchByMaker(0);
        assertEq(launcher.coinOf(agentW), address(coin));
        assertEq(launcher.splitterOf(agentW), address(s));
        assertEq(launcher.agentOf(address(coin)), agentW);
        assertEq(launcher.coinCount(), 1);
        assertEq(launcher.coinAt(0), address(coin));
        assertEq(launcher.nonces(agentW), 1, "the permission is used up");

        IPonsV2LaunchFactory.LaunchedToken memory info =
            IPonsV2LaunchFactory(address(factory)).getLaunchedToken(address(coin));
        assertEq(info.creatorFeeRecipient, address(s));
        assertEq(info.deployer, address(launcher));
        assertEq(info.creatorTaxBps, 300);
        assertFalse(info.buybackEnabled);
        assertEq(info.pairToken, address(0));

        assertEq(s.coin(), address(coin));
        assertEq(s.agent(), agentW);
        assertEq(s.maker(), maker);
        assertEq(s.launcher(), address(launcher));
        assertEq(s.desk(), address(desk));
        assertEq(s.gateway(), gateway);
        assertEq(s.burnPot(), address(burnPot));
        assertEq(s.owner(), admin);
        assertEq(address(s.escrow()), address(escrow));
        assertEq(address(s.factory()), address(factory));
        assertEq(s.curve(), address(c));
        assertEq(coin.name(), "Page Smith");
        assertEq(coin.symbol(), "SMITH");
        assertEq(address(launcher).balance, 0, "the launcher holds no ETH");
    }

    function test_theAgentLaunchesItsOwnCoinWithoutAPermission() public {
        (MockFactorToken coin, AgentCoinSplitter s,) = _launchByAgent(maker, 0);
        assertEq(s.maker(), maker, "the maker it named");
        assertEq(launcher.coinOf(agentW), address(coin));
        assertEq(launcher.nonces(agentW), 0, "no permission was used");
    }

    function test_theAgentCanBeItsOwnMaker() public {
        (, AgentCoinSplitter s, MockCurve c) = _launchByAgent(agentW, 0);
        assertEq(s.maker(), agentW);
        assertTrue(c.snipeTaxExempt(agentW));
    }

    function test_theMakerAndTheAgentSkipTheLaunchSecondsTax() public {
        (,, MockCurve c) = _launchByMaker(0);
        assertTrue(c.snipeTaxExempt(maker));
        assertTrue(c.snipeTaxExempt(agentW));
        assertTrue(c.snipeTaxExempt(address(launcher)), "the deployer");
        assertFalse(c.snipeTaxExempt(buyer));
    }

    function test_theEventSaysWhoAndHow() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.expectEmit(true, false, true, false, address(launcher));
        emit CoinLaunched(agentW, address(0), maker, address(0), address(0), true, 0, 0);
        vm.prank(maker);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
    }

    function test_theOpeningBuyGoesToTheMakerAsMeasured() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee + 0.1 ether);
        vm.recordLogs();
        vm.prank(maker);
        address t = launcher.launch{value: fee + 0.1 ether}(agentW, maker, p, 0, deadline, sig);
        uint256 got = MockFactorToken(t).balanceOf(maker);
        assertGt(got, 0);
        assertEq(maker.balance, 0, "all of it was spent");
        assertEq(MockFactorToken(t).balanceOf(address(launcher)), 0);
        assertEq(address(launcher).balance, 0);
        // the event's numbers are the measured ones
        bytes32 topic = keccak256("CoinLaunched(address,address,address,address,address,bool,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(launcher) || logs[i].topics[0] != topic) continue;
            (,,, uint256 spent, uint256 tokens) = abi.decode(logs[i].data, (address, address, bool, uint256, uint256));
            assertEq(spent, 0.1 ether);
            assertEq(tokens, got);
            seen = true;
        }
        assertTrue(seen);
    }

    /// A buy larger than the curve can fill: the curve hands the rest back to the launcher, which hands it on.
    function test_whatTheCurveCannotFillGoesBackToTheMaker() public {
        factory.setCurveMaxFill(0.05 ether);
        _launchByMaker(0.2 ether);
        assertEq(maker.balance, 0.15 ether);
        assertEq(address(launcher).balance, 0);
    }

    function test_aMakerThatRefusesTheRestUndoesItsOwnLaunch() public {
        Rejecter r = new Rejecter();
        factory.setCurveMaxFill(0.05 ether);
        uint256 fee = factory.launchFee();
        vm.deal(agentW, fee + 0.2 ether);
        vm.prank(agentW);
        vm.expectRevert(AgentCoinLauncher.RefundFailed.selector);
        launcher.launch{value: fee + 0.2 ether}(agentW, payable(address(r)), _coinParams(), 0, 0, "");
    }

    function test_theLaunchFeeMustBeThere() public {
        uint256 fee = factory.launchFee();
        vm.deal(agentW, fee);
        vm.prank(agentW);
        vm.expectRevert(abi.encodeWithSelector(AgentCoinLauncher.LaunchFeeShort.selector, fee));
        launcher.launch{value: fee - 1}(agentW, maker, _coinParams(), 0, 0, "");
    }

    function test_noZeroAgentOrMaker() public {
        vm.expectRevert(AgentCoinLauncher.ZeroAddress.selector);
        launcher.launch(address(0), maker, _coinParams(), 0, 0, "");
        vm.prank(agentW);
        vm.expectRevert(AgentCoinLauncher.ZeroAddress.selector);
        launcher.launch(agentW, payable(address(0)), _coinParams(), 0, 0, "");
    }

    function test_theLauncherTakesNoEthOutsideALaunch() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(launcher).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------- what is forced ----------

    /// Whatever the caller asks for, the fees go to the coin's own splitter at 3% with Pons' buyback off.
    function test_theFeesCannotBeSentElsewhere() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        p.creatorFeeRecipient = stranger;
        p.creatorTaxBps = 0;
        p.buybackEnabled = true;
        uint256 fee = factory.launchFee();
        vm.deal(agentW, fee);
        vm.prank(agentW);
        address t = launcher.launch{value: fee}(agentW, maker, p, 0, 0, "");
        IPonsV2LaunchFactory.LaunchedToken memory info = IPonsV2LaunchFactory(address(factory)).getLaunchedToken(t);
        assertEq(info.creatorFeeRecipient, launcher.splitterOf(agentW));
        assertEq(info.creatorTaxBps, 300);
        assertFalse(info.buybackEnabled);
    }

    /// A Pons that says it did something else than it was asked is caught, and the whole launch undone.
    function test_aLaunchIsReadBackFromPons() public {
        bytes4[6] memory want = [
            AgentCoinLauncher.NotPonsLaunch.selector,
            AgentCoinLauncher.NotPonsLaunch.selector,
            AgentCoinLauncher.WrongFeeRecipient.selector,
            AgentCoinLauncher.NotEthPair.selector,
            AgentCoinLauncher.WrongCreatorTax.selector,
            AgentCoinLauncher.BuybackEnabled.selector
        ];
        uint256 fee = factory.launchFee();
        for (uint8 i = 1; i <= 6; ++i) {
            factory.setLie(MockFactory.Lie(i));
            vm.deal(agentW, fee);
            vm.prank(agentW);
            (bool ok, bytes memory out) = address(launcher).call{value: fee}(
                abi.encodeCall(launcher.launch, (agentW, maker, _coinParams(), 0, 0, ""))
            );
            assertFalse(ok);
            assertEq(bytes4(out), want[i - 1]);
        }
        factory.setLie(MockFactory.Lie.None);
        assertEq(launcher.coinCount(), 0);
    }

    // ---------- who may launch: the attacks ----------

    function test_aStrangerCannotLaunchSomebodyElsesAgentsCoin() public {
        uint256 fee = factory.launchFee();
        vm.deal(stranger, 1 ether);
        // as if it were the maker, without a permission
        vm.prank(stranger);
        vm.expectRevert(AgentCoinLauncher.NotAllowed.selector);
        launcher.launch{value: fee}(agentW, maker, _coinParams(), 0, block.timestamp + 1, "");
        // naming itself the maker, with no signature or one of its own
        (bytes memory own,) = _permission(uint256(keccak256("stranger")), agentW, stranger, _coinParams());
        vm.prank(stranger);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        launcher.launch{value: fee}(agentW, payable(stranger), _coinParams(), 0, block.timestamp + 1, own);
        vm.prank(stranger);
        vm.expectRevert();
        launcher.launch{value: fee}(agentW, payable(stranger), _coinParams(), 0, block.timestamp + 1, "");
    }

    /// A permission seen in the mempool is useless to whoever copies it: it names the maker, and only the maker can
    /// send it.
    function test_aCopiedPermissionIsUselessToAnyoneElse() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(AgentCoinLauncher.NotAllowed.selector);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
        vm.prank(stranger);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        launcher.launch{value: fee}(agentW, payable(stranger), p, 0, deadline, sig);
        // and the maker can still use it
        vm.deal(maker, fee);
        vm.prank(maker);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
    }

    /// The permission covers the name, the ticker, the picture and the description: the maker cannot change them.
    function test_aPermissionIsForTheseWordsOnly() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(maker, 1 ether);
        for (uint256 i = 0; i < 4; ++i) {
            IPonsV2LaunchFactory.TokenParams memory q = _coinParams();
            if (i == 0) q.name = "Another Brand";
            if (i == 1) q.symbol = "OTHER";
            if (i == 2) q.logo = "https://elsewhere.example/logo.png";
            if (i == 3) q.description = "Something else.";
            vm.prank(maker);
            vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
            launcher.launch{value: fee}(agentW, maker, q, 0, deadline, sig);
        }
    }

    function test_aPermissionSignedByAnotherKeyIsRefused() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(uint256(keccak256("not the agent")), agentW, maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
    }

    function test_aPermissionRunsOut() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        vm.warp(deadline + 1);
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.Expired.selector);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
    }

    /// The agent takes back every permission it gave by raising its number.
    function test_theAgentCancelsItsPermissions() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        vm.prank(agentW);
        launcher.bumpNonce();
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
    }

    /// One coin per agent, ever: not a second by the same permission, not by a new one, not by the agent itself.
    function test_aSecondCoinIsRefused() public {
        (MockFactorToken coin,,) = _launchByMaker(0);
        uint256 fee = factory.launchFee();
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        vm.deal(maker, fee);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(AgentCoinLauncher.AlreadyLaunched.selector, address(coin)));
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
        vm.deal(agentW, fee);
        vm.prank(agentW);
        vm.expectRevert(abi.encodeWithSelector(AgentCoinLauncher.AlreadyLaunched.selector, address(coin)));
        launcher.launch{value: fee}(agentW, maker, p, 0, 0, "");
        assertEq(launcher.coinCount(), 1);
    }

    /// A permission is for one launcher on one chain: it is refused by another launcher, and on another chain.
    function test_aPermissionIsBoundToThisLauncherAndChain() public {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        AgentCoinLauncher other = new AgentCoinLauncher(IAgentDesk(address(desk)));
        uint256 fee = factory.launchFee();
        vm.deal(maker, 3 * fee);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        other.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
        uint256 home = block.chainid;
        vm.chainId(home + 1);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
        vm.chainId(home);
        vm.prank(maker);
        launcher.launch{value: fee}(agentW, maker, p, 0, deadline, sig);
        assertEq(launcher.nonces(agentW), 1, "used up");
    }

    function test_onlyAnAgentOnTheDeskHasACoin() public {
        (address nobody, uint256 key) = makeAddrAndKey("not on the desk");
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(key, nobody, maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.NotRegistered.selector);
        launcher.launch{value: fee}(nobody, maker, p, 0, deadline, sig);
    }

    function test_aBarredAgentHasNoCoin() public {
        _bar(agentW);
        uint256 fee = factory.launchFee();
        vm.deal(agentW, fee);
        vm.prank(agentW);
        vm.expectRevert(AgentCoinLauncher.Barred.selector);
        launcher.launch{value: fee}(agentW, maker, _coinParams(), 0, 0, "");
    }

    /// A maker whose wallet calls back into the launcher while being paid its change cannot launch twice.
    function test_aMakerCannotReenterTheLauncher() public {
        Reenterer r = new Reenterer();
        address agent2 = makeAddr("a second agent");
        vm.prank(agent2);
        desk.register();
        r.arm(abi.encodeCall(launcher.launch, (agent2, payable(address(r)), _coinParams(), 0, 0, "")));
        factory.setCurveMaxFill(0.05 ether);
        uint256 fee = factory.launchFee();
        vm.deal(agentW, fee + 0.2 ether);
        vm.prank(agentW);
        launcher.launch{value: fee + 0.2 ether}(agentW, payable(address(r)), _coinParams(), 0, 0, "");
        assertTrue(r.reentered());
        assertFalse(r.reentrySucceeded());
        assertEq(launcher.coinCount(), 1);
    }

    // ---------- an agent that is a Factor account ----------

    function _walletKey(address a) internal pure returns (FactorAccount.Key memory) {
        return FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(a))), bytes32(0));
    }

    function _registerAccount(FactorAccount acct, address keyHolder) internal {
        FactorAccount.Call[] memory c = new FactorAccount.Call[](1);
        c[0] = FactorAccount.Call(address(desk), 0, abi.encodeCall(desk.register, ()));
        vm.prank(keyHolder);
        acct.run(c);
    }

    /// Factor's own agents and the agents made on the site are accounts: the account's key signs, and the account
    /// itself says yes (ERC-1271).
    function test_anAgentThatIsAnAccountSignsWithItsKey() public {
        (address program, uint256 programKey) = makeAddrAndKey("an account's key");
        FactorAccount acct = FactorAccount(payable(accounts.create(_walletKey(program), "")));
        _registerAccount(acct, program);
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(programKey, address(acct), maker, p);
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        address t = launcher.launch{value: fee}(address(acct), maker, p, 0, deadline, sig);
        assertEq(launcher.agentOf(t), address(acct));
        // a key the account does not hold is refused
        address other = makeAddr("another account's key");
        FactorAccount acct2 = FactorAccount(payable(accounts.create(_walletKey(other), "")));
        _registerAccount(acct2, other);
        (bytes memory bad, uint256 d2) = _permission(programKey, address(acct2), maker, p);
        vm.deal(maker, fee);
        vm.prank(maker);
        vm.expectRevert(AgentCoinLauncher.BadSignature.selector);
        launcher.launch{value: fee}(address(acct2), maker, p, 0, d2, bad);
    }

    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    /// An account held by a passkey: the passkey's answer to the permission's digest is the signature.
    function test_anAgentHeldByAPasskeySigns() public {
        uint256 pk = 0xA11CE0000000000000000000000000000000000000000000000000000000B0B;
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        FactorAccount.Key memory k = FactorAccount.Key(FactorAccount.Kind.Passkey, bytes32(x), bytes32(y));
        FactorAccount acct = FactorAccount(payable(accounts.create(k, "credential")));
        bytes32 id = acct.keyId(k);
        // registered by an order the passkey signed, sent by anyone
        FactorAccount.Call[] memory c = new FactorAccount.Call[](1);
        c[0] = FactorAccount.Call(address(desk), 0, abi.encodeCall(desk.register, ()));
        uint256 dl = block.timestamp + 1 hours;
        acct.execute(c, dl, _assertion(pk, id, acct.digest(c, acct.nonce(), dl)));
        assertTrue(desk.agent(address(acct)).registered);

        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _assertion(pk, id, launcher.permissionDigest(address(acct), maker, p, 0, deadline));
        uint256 fee = factory.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        address t = launcher.launch{value: fee}(address(acct), maker, p, 0, deadline, sig);
        assertEq(launcher.agentOf(t), address(acct));
    }

    function _assertion(uint256 pk, bytes32 id, bytes32 challenge) internal pure returns (bytes memory) {
        bytes memory authenticatorData = abi.encodePacked(sha256("factoragents.fun"), bytes1(0x05), uint32(0));
        string memory json = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://factoragents.fun","crossOrigin":false}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(pk, sha256(abi.encodePacked(authenticatorData, sha256(bytes(json)))));
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        return abi.encodePacked(id, abi.encode(r, s, uint256(23), uint256(1), authenticatorData, json));
    }

    // ---------- the splitter: the four shares ----------

    function test_theSharesAreFixed() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        assertEq(s.COMPUTE_BPS(), 4000);
        assertEq(s.MAKER_BPS(), 2000);
        assertEq(s.BURN_BPS(), 2000);
        assertEq(s.OWNER_BPS(), 2000);
        assertEq(uint256(s.COMPUTE_BPS()) + s.MAKER_BPS() + s.BURN_BPS() + s.OWNER_BPS(), s.BPS());
    }

    function test_aRoundAmountSplitsToTheWei() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        uint256 makerBefore = maker.balance;
        vm.deal(address(s), 1 ether);
        vm.expectEmit(address(s));
        emit ComputePaid(agentW, 0.4 ether);
        vm.expectEmit(address(s));
        emit Split(1 ether, 0.4 ether, 0.2 ether, 0.2 ether, 0.2 ether, true, true, true, true);
        assertEq(s.distribute(), 1 ether);
        assertEq(gateway.balance, 0.4 ether);
        assertEq(maker.balance - makerBefore, 0.2 ether);
        assertEq(address(burnPot).balance, 0.2 ether);
        assertEq(admin.balance, 0.2 ether);
        assertEq(address(s).balance, 0);
        assertEq(s.totalSplit(), 1 ether);
        assertEq(s.totalToCompute(), 0.4 ether);
        assertEq(s.totalComputePaid(), 0.4 ether);
        assertEq(s.totalToMaker(), 0.2 ether);
        assertEq(s.totalToBurn(), 0.2 ether);
        assertEq(s.totalToOwner(), 0.2 ether);
    }

    function test_theRoundingDustGoesToTheBurn() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.deal(address(s), 9); // 40% = 3.6, 20% = 1.8
        s.distribute();
        assertEq(gateway.balance, 3);
        assertEq(admin.balance, 1);
        assertEq(address(burnPot).balance, 4, "the rest");
    }

    function testFuzz_theFourSharesAlwaysAddUp(uint96 amount) public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        uint256 makerBefore = maker.balance;
        vm.deal(address(s), amount);
        s.distribute();
        uint256 c = gateway.balance;
        uint256 m = maker.balance - makerBefore;
        uint256 b = address(burnPot).balance;
        uint256 o = admin.balance;
        assertEq(c + m + b + o, amount, "all of it, no more");
        assertEq(c, (uint256(amount) * 4000) / 10_000);
        assertEq(m, (uint256(amount) * 2000) / 10_000);
        assertEq(o, (uint256(amount) * 2000) / 10_000);
        assertLe(b - (uint256(amount) * 2000) / 10_000, 3, "the burn gets at most 3 wei of dust");
        assertEq(address(s).balance, 0, "nothing stays");
    }

    function testFuzz_manySweepsKeepTheBooks(uint96[8] memory trades) public {
        (, AgentCoinSplitter s, MockCurve c) = _launchByMaker(0);
        uint256 makerBefore = maker.balance;
        for (uint256 i = 0; i < trades.length; ++i) {
            uint256 eth = bound(trades[i], 0, 2 ether);
            if (eth > 0) _buyCoin(c, eth);
            s.sweep();
            assertEq(address(s).balance, 0);
        }
        assertEq(s.totalSplit(), s.totalToCompute() + s.totalToMaker() + s.totalToBurn() + s.totalToOwner());
        assertEq(gateway.balance, s.totalToCompute());
        assertEq(maker.balance - makerBefore, s.totalToMaker());
        assertEq(admin.balance, s.totalToOwner());
        assertEq(address(burnPot).balance, s.totalToBurn());
    }

    // ---------- fees in ----------

    function test_aSweepReleasesTheCurveClaimsAndSplits() public {
        (, AgentCoinSplitter s, MockCurve c) = _launchByMaker(0);
        _buyCoin(c, 1 ether);
        uint256 onCurve = c.pendingFees();
        assertEq(onCurve, 0.04 ether);
        uint256 toCreator = (onCurve * 37) / 40;
        assertEq(s.sweep(), toCreator);
        assertEq(c.pendingFees(), 0);
        assertEq(escrow.balanceOf(address(s)), 0);
        assertEq(gateway.balance, (toCreator * 4000) / 10_000);
        // a second sweep with nothing new does nothing and does not revert
        assertEq(s.sweep(), 0);
    }

    function test_claimTakesWhatTheEscrowHolds() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.deal(address(this), 1 ether);
        IPonsV2FeeEscrow(address(escrow)).credit{value: 1 ether}(address(s));
        assertEq(s.claim(), 1 ether);
        assertEq(gateway.balance, 0.4 ether);
    }

    /// After graduation the curve is gone and only Pons' keeper releases the pool's fees into the escrow: the sweep
    /// still claims and splits them.
    function test_afterGraduationTheSweepStillClaims() public {
        (MockFactorToken coin, AgentCoinSplitter s,) = _launchByMaker(0);
        factory.setPhase(address(coin), IPonsV2LaunchFactory.GraduationPhase.PoolCreated);
        assertEq(s.curve(), address(0));
        vm.deal(address(this), 0.5 ether);
        IPonsV2FeeEscrow(address(escrow)).credit{value: 0.5 ether}(address(s));
        assertEq(s.sweep(), 0.5 ether);
    }

    function test_ethSentStraightOrForcedIsSplit() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(s).call{value: 0.3 ether}("");
        assertTrue(ok);
        new ForceSend{value: 0.2 ether}(payable(address(s)));
        assertEq(s.unsplit(), 0.5 ether);
        assertEq(s.distribute(), 0.5 ether);
    }

    function test_theCoinIsSetOnceByTheLauncherOnly() public {
        (MockFactorToken coin, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.prank(stranger);
        vm.expectRevert(AgentCoinSplitter.NotLauncher.selector);
        s.setCoin(stranger);
        vm.prank(address(launcher));
        vm.expectRevert(AgentCoinSplitter.CoinAlreadySet.selector);
        s.setCoin(stranger);
        assertEq(s.coin(), address(coin));
    }

    // ---------- coins that reach the splitter ----------

    function test_coinsHereAreBurnedAndTheSupplyFalls() public {
        (MockFactorToken coin, AgentCoinSplitter s, MockCurve c) = _launchByMaker(0);
        uint256 got = _buyCoin(c, 0.1 ether);
        vm.prank(buyer);
        coin.transfer(address(s), got / 2);
        // and a credit in the coin in Pons' escrow
        vm.startPrank(buyer);
        coin.approve(address(escrow), got / 4);
        escrow.creditToken(address(s), address(coin), got / 4);
        vm.stopPrank();
        uint256 supply = coin.totalSupply();
        vm.expectEmit(address(s));
        emit CoinBurned(got / 2 + got / 4);
        assertEq(s.claimToken(), got / 2 + got / 4);
        assertEq(supply - coin.totalSupply(), got / 2 + got / 4);
        assertEq(s.totalCoinBurned(), got / 2 + got / 4);
        assertEq(s.claimToken(), 0, "nothing more");
    }

    function test_aBurnThatDoesNotLowerTheSupplyIsRefused() public {
        (MockFactorToken coin, AgentCoinSplitter s, MockCurve c) = _launchByMaker(0);
        uint256 got = _buyCoin(c, 0.1 ether);
        vm.prank(buyer);
        coin.transfer(address(s), got);
        coin.setFakeBurn(true);
        vm.expectRevert(AgentCoinSplitter.SupplyDidNotFall.selector);
        s.claimToken();
    }

    // ---------- a share that is refused ----------

    function test_aMakerThatRefusesItsShareCollectsItLater() public {
        Rejecter r = new Rejecter();
        (, AgentCoinSplitter s,) = _launchByAgent(address(r), 0);
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(s.makerPending(), 0.2 ether);
        assertEq(gateway.balance, 0.4 ether, "the others are not held up");
        assertEq(s.unsplit(), 0, "a pending share is not split again");
        s.retry();
        assertEq(s.makerPending(), 0.2 ether, "refused again, still pending");
        // only the maker collects it, to where it says
        vm.prank(stranger);
        vm.expectRevert(AgentCoinSplitter.NotMaker.selector);
        s.withdrawMaker(payable(stranger));
        vm.prank(address(r));
        s.withdrawMaker(payable(stranger));
        assertEq(stranger.balance, 0.2 ether);
        assertEq(s.makerPending(), 0);
        vm.prank(address(r));
        vm.expectRevert(AgentCoinSplitter.NothingPending.selector);
        s.withdrawMaker(payable(stranger));
    }

    function test_aMakerThatAcceptsLaterIsPaidByRetry() public {
        Rejecter r = new Rejecter();
        (, AgentCoinSplitter s,) = _launchByAgent(address(r), 0);
        vm.deal(address(s), 1 ether);
        s.distribute();
        r.setAccept(true);
        vm.expectEmit(address(s));
        emit PendingDelivered(address(r), 0.2 ether);
        s.retry();
        assertEq(address(r).balance, 0.2 ether);
        assertEq(address(s).balance, 0);
    }

    function test_anOwnerThatRefusesCollectsItsOwn() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.etch(admin, address(new Rejecter()).code);
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(s.ownerPending(), 0.2 ether);
        vm.prank(maker);
        vm.expectRevert(AgentCoinSplitter.NotOwner.selector);
        s.withdrawOwner(maker);
        vm.prank(admin);
        s.withdrawOwner(payable(stranger));
        assertEq(stranger.balance, 0.2 ether);
    }

    /// The compute share only ever goes to the gateway, and is said to be paid only when it arrives.
    function test_aRefusedComputeShareWaitsForTheGatewayOnly() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.etch(gateway, address(new Rejecter()).code);
        vm.deal(address(s), 1 ether);
        vm.recordLogs();
        s.distribute();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != ComputePaid.selector, "not said to be paid");
        }
        assertEq(s.computePending(), 0.4 ether);
        assertEq(s.totalComputePaid(), 0);
        Rejecter(payable(gateway)).setAccept(true);
        vm.expectEmit(address(s));
        emit ComputePaid(agentW, 0.4 ether);
        s.retry();
        assertEq(gateway.balance, 0.4 ether);
        assertEq(s.totalComputePaid(), 0.4 ether);
    }

    function test_aWalletThatEatsGasCannotStopTheSplit() public {
        GasEater g = new GasEater();
        (, AgentCoinSplitter s,) = _launchByAgent(address(g), 0);
        vm.deal(address(s), 1 ether);
        s.distribute{gas: 500_000}();
        assertEq(s.makerPending(), 0.2 ether);
        assertEq(gateway.balance, 0.4 ether);
        assertEq(admin.balance, 0.2 ether);
    }

    function test_aMakerCannotReenterTheSplitter() public {
        Reenterer r = new Reenterer();
        (, AgentCoinSplitter s,) = _launchByAgent(address(r), 0);
        bytes[4] memory calls = [
            abi.encodeCall(s.distribute, ()),
            abi.encodeCall(s.retry, ()),
            abi.encodeCall(s.sweep, ()),
            abi.encodeCall(s.withdrawMaker, (payable(address(r))))
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            r.arm(calls[i]);
            vm.deal(address(s), address(s).balance + 1 ether);
            s.distribute();
            assertFalse(r.reentrySucceeded());
        }
        assertEq(address(s).balance, 0);
    }

    // ---------- a barred agent ----------

    function test_aBarredAgentsComputeShareGoesToTheBurn() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        _bar(agentW);
        uint256 potBefore = address(burnPot).balance;
        vm.deal(address(s), 1 ether);
        vm.expectEmit(address(s));
        emit ComputeBurned(agentW, 0.4 ether);
        s.distribute();
        assertEq(gateway.balance, 0, "nothing to the gateway");
        assertEq(address(burnPot).balance - potBefore, 0.6 ether, "its own share and the compute share");
        assertEq(s.totalComputeBurned(), 0.4 ether);
        assertEq(s.totalToCompute(), 0.4 ether, "still counted as the compute share");
    }

    function test_pendingComputeOfAnAgentBarredSinceGoesToTheBurn() public {
        (, AgentCoinSplitter s,) = _launchByMaker(0);
        vm.etch(gateway, address(new Rejecter()).code);
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(s.computePending(), 0.4 ether);
        _bar(agentW);
        Rejecter(payable(gateway)).setAccept(true);
        uint256 potBefore = address(burnPot).balance;
        vm.expectEmit(address(s));
        emit ComputeBurned(agentW, 0.4 ether);
        s.retry();
        assertEq(gateway.balance, 0);
        assertEq(address(burnPot).balance - potBefore, 0.4 ether);
        assertEq(s.computePending(), 0);
    }

    /// Its coin keeps trading and its other shares are paid as before.
    function test_aBarredAgentsCoinKeepsTrading() public {
        (, AgentCoinSplitter s, MockCurve c) = _launchByMaker(0);
        _bar(agentW);
        uint256 makerBefore = maker.balance;
        _buyCoin(c, 1 ether);
        uint256 got = s.sweep();
        assertGt(got, 0);
        assertEq(maker.balance - makerBefore, (got * 2000) / 10_000);
    }
}

