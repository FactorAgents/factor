// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {DeskBase} from "./DeskBase.sol";
import {FactorAccount, FactorAccounts} from "../src/FactorAccount.sol";
import {FactorDesk} from "../src/FactorDesk.sol";

/// Something an account calls that calls the account back with the very order it is in the middle of.
contract Reenter {
    FactorAccount.Call[] internal calls;
    uint256 internal deadline;
    bytes internal signature;

    function arm(FactorAccount.Call[] memory c, uint256 d, bytes memory s) external {
        for (uint256 i; i < c.length; ++i) {
            calls.push(c[i]);
        }
        deadline = d;
        signature = s;
    }

    function again() external {
        FactorAccount(payable(msg.sender)).execute(calls, deadline, signature);
    }
}

/// Accounts for people without a wallet: what a key can make one do, what nobody else can, and a whole job on the
/// desk done by two accounts that never pay gas.
contract AccountTest is DeskBase {
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes4 internal constant VALID = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;

    // a person's passkey, a second device's, and somebody else's
    uint256 internal passkey = 0xA11CE0000000000000000000000000000000000000000000000000000000B0B;
    uint256 internal second = 0x5EC0FD0000000000000000000000000000000000000000000000000000000002;
    uint256 internal thief = 0xBAD0000000000000000000000000000000000000000000000000000000000BAD;
    // an agent's program: a key, and not a wei to pay gas with
    address internal bot;
    uint256 internal botKey;
    address internal relayer = makeAddr("whoever pays the gas");

    FactorAccount internal person;
    FactorAccount internal agent;
    bytes32 internal personKey;

    function setUp() public override {
        super.setUp();
        (bot, botKey) = makeAddrAndKey("an agent's own key");
        person = FactorAccount(payable(accounts.create(_passkey(passkey), "credential-1")));
        agent = FactorAccount(payable(accounts.create(_wallet(bot), "")));
        personKey = person.keyId(_passkey(passkey));
    }

    // ---------- keys and signatures, as a browser and a program make them ----------

    function _passkey(uint256 pk) internal pure returns (FactorAccount.Key memory) {
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        return FactorAccount.Key(FactorAccount.Kind.Passkey, bytes32(x), bytes32(y));
    }

    function _wallet(address a) internal pure returns (FactorAccount.Key memory) {
        return FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(a))), bytes32(0));
    }

    /// What a passkey answers when it is asked to sign `challenge`: 0x05 says its owner was present and verified.
    function _assertion(uint256 pk, bytes32 id, bytes32 challenge) internal pure returns (bytes memory) {
        return _assertion(pk, id, challenge, 0x05, "webauthn.get", false);
    }

    function _assertion(uint256 pk, bytes32 id, bytes32 challenge, bytes1 flags, string memory kind, bool highS)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory authenticatorData = abi.encodePacked(sha256("factor.fun"), flags, uint32(0));
        string memory json = string.concat(
            '{"type":"',
            kind,
            '","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://factor.fun","crossOrigin":false}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(pk, sha256(abi.encodePacked(authenticatorData, sha256(bytes(json)))));
        // a browser hands the low half; the high one is as valid a signature and is refused, so nobody can make a
        // second signature out of a first
        if ((uint256(s) > N / 2) != highS) s = bytes32(N - uint256(s));
        return abi.encodePacked(id, abi.encode(r, s, uint256(23), uint256(1), authenticatorData, json));
    }

    function _walletSig(uint256 key_, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key_, hash);
        return abi.encodePacked(r, s, v);
    }

    function _one(address to, uint256 value, bytes memory data) internal pure returns (FactorAccount.Call[] memory c) {
        c = new FactorAccount.Call[](1);
        c[0] = FactorAccount.Call(to, value, data);
    }

    /// The person's passkey signs an order, and somebody else sends it.
    function _asPerson(FactorAccount.Call[] memory c) internal returns (bytes[] memory) {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, person.nonce(), deadline));
        vm.prank(relayer);
        return person.execute(c, deadline, sig);
    }

    /// The same order, signed and sent after the test has said what it expects of the sending.
    function _refusedForPerson(FactorAccount.Call[] memory c, bytes memory why) internal {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, person.nonce(), deadline));
        vm.expectRevert(why);
        person.execute(c, deadline, sig);
    }

    function _refused(FactorAccount.Call[] memory c, uint256 deadline, bytes memory sig) internal {
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(c, deadline, sig);
    }

    /// The agent's key signs an order, and somebody else sends it.
    function _asAgent(FactorAccount.Call[] memory c) internal returns (bytes[] memory) {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _walletSig(botKey, agent.digest(c, agent.nonce(), deadline));
        vm.prank(relayer);
        return agent.execute(c, deadline, sig);
    }

    // ---------- making accounts ----------

    function test_theSameKeyIsAlwaysTheSameAccount() public {
        assertEq(accounts.addressOf(_passkey(passkey)), address(person));
        assertEq(accounts.create(_passkey(passkey), "anything"), address(person), "made once, found afterwards");
        assertEq(person.keyCount(), 1);
        assertEq(uint8(person.key(personKey).kind), uint8(FactorAccount.Kind.Passkey));
        assertTrue(accounts.addressOf(_passkey(second)) != address(person));
        assertEq(accounts.addressOf(_passkey(second)).code.length, 0, "an address is known before anything is there");
    }

    function test_anAccountIsKnownBeforeItExistsAndKeepsWhatWasSentToIt() public {
        address later = accounts.addressOf(_passkey(second));
        vm.deal(address(this), 1 ether);
        (bool ok,) = later.call{value: 1 ether}("");
        assertTrue(ok);
        FactorAccount made = FactorAccount(payable(accounts.create(_passkey(second), "credential-2")));
        assertEq(address(made), later);
        assertEq(later.balance, 1 ether);
    }

    function test_nobodyCanGiveAnAccountItsFirstKeyButTheFactory() public {
        vm.expectRevert(FactorAccount.OnlyFactory.selector);
        person.initialize(_passkey(thief), "");
        // the original the copies are made from has no key, and nobody can give it one
        FactorAccount original = FactorAccount(payable(accounts.implementation()));
        assertEq(original.keyCount(), 0);
        vm.expectRevert(FactorAccount.OnlyFactory.selector);
        original.initialize(_passkey(thief), "");
        vm.prank(address(accounts));
        vm.expectRevert(FactorAccount.OnlyFactory.selector);
        person.initialize(_passkey(thief), "");
    }

    function test_aKeyThatIsNoKeyIsRefused() public {
        FactorAccount.Key memory offCurve =
            FactorAccount.Key(FactorAccount.Kind.Passkey, bytes32(uint256(1)), bytes32(uint256(1)));
        vm.expectRevert(FactorAccount.BadKey.selector);
        accounts.create(offCurve, "");
        vm.expectRevert(FactorAccount.BadKey.selector);
        accounts.create(FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(0), bytes32(0)), "");
        vm.expectRevert(FactorAccount.BadKey.selector);
        accounts.create(FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(type(uint256).max), bytes32(0)), "");
        vm.expectRevert(FactorAccount.BadKey.selector);
        accounts.create(
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(bot))), bytes32(uint256(1))), ""
        );
        vm.expectRevert(FactorAccount.BadKey.selector);
        accounts.create(FactorAccount.Key(FactorAccount.Kind.None, bytes32(uint256(1)), bytes32(0)), "");
    }

    // ---------- an order ----------

    function test_aPasskeySignsAndAnybodySends() public {
        vm.deal(address(person), 1 ether);
        address friend = makeAddr("a friend");
        vm.expectEmit(address(person));
        emit FactorAccount.Executed(0, personKey, 1);
        _asPerson(_one(friend, 0.25 ether, ""));
        assertEq(friend.balance, 0.25 ether);
        assertEq(address(person).balance, 0.75 ether);
        assertEq(person.nonce(), 1);
        assertEq(relayer.balance, 0, "whoever sends it is given nothing and takes nothing");
    }

    function test_theDigestIsEIP712AsAWalletShowsIt() public view {
        FactorAccount.Call[] memory c = new FactorAccount.Call[](2);
        c[0] = FactorAccount.Call(address(desk), 1 ether, abi.encodeCall(FactorDesk.register, ()));
        c[1] = FactorAccount.Call(address(0xBEEF), 0, "");
        bytes32 callType = keccak256("Call(address to,uint256 value,bytes data)");
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = keccak256(abi.encode(callType, c[0].to, c[0].value, keccak256(c[0].data)));
        hashes[1] = keccak256(abi.encode(callType, c[1].to, c[1].value, keccak256(c[1].data)));
        bytes32 order = keccak256(
            abi.encode(
                keccak256(
                    "Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)"
                ),
                keccak256(abi.encodePacked(hashes)),
                uint256(7),
                uint256(1_800_000_000)
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Factor Account"),
                keccak256("1"),
                block.chainid,
                address(person)
            )
        );
        assertEq(person.digest(c, 7, 1_800_000_000), keccak256(abi.encodePacked(hex"1901", domain, order)));
    }

    function test_anOrderIsGoodOnce() public {
        vm.deal(address(person), 1 ether);
        FactorAccount.Call[] memory c = _one(makeAddr("a friend"), 0.1 ether, "");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, 0, deadline));
        person.execute(c, deadline, sig);
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(c, deadline, sig);
        assertEq(address(person).balance, 0.9 ether);
    }

    function test_anOrderIsGoodUntilItsDeadlineAndNotAfter() public {
        vm.deal(address(person), 1 ether);
        FactorAccount.Call[] memory c = _one(makeAddr("a friend"), 0.1 ether, "");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, 0, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(FactorAccount.Expired.selector, deadline));
        person.execute(c, deadline, sig);
        // and whoever sends it cannot give it a later one
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(c, deadline + 1 hours, sig);
        vm.warp(deadline);
        person.execute(c, deadline, sig);
    }

    function test_whoeverSendsAnOrderCannotChangeIt() public {
        vm.deal(address(person), 1 ether);
        address friend = makeAddr("a friend");
        FactorAccount.Call[] memory c = _one(friend, 0.1 ether, "");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, 0, deadline));
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(_one(relayer, 0.1 ether, ""), deadline, sig);
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(_one(friend, 1 ether, ""), deadline, sig);
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(_one(friend, 0.1 ether, hex"00"), deadline, sig);
        FactorAccount.Call[] memory two = new FactorAccount.Call[](2);
        two[0] = c[0];
        two[1] = FactorAccount.Call(relayer, 0.9 ether, "");
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(two, deadline, sig);
        assertEq(address(person).balance, 1 ether);
    }

    function test_anOrderIsForOneAccountOnOneChain() public {
        // the same passkey is a key of two accounts: what it signed for one is nothing to the other
        FactorAccount other = FactorAccount(payable(accounts.create(_passkey(second), "")));
        vm.deal(address(other), 1 ether);
        vm.deal(address(person), 1 ether);
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 otherKey = other.keyId(_passkey(second));
        FactorAccount.Call[] memory add =
            _one(address(other), 0, abi.encodeCall(FactorAccount.addKey, (_passkey(passkey), "credential-1")));
        vm.prank(relayer);
        other.execute(add, deadline, _assertion(second, otherKey, other.digest(add, 0, deadline)));
        assertEq(other.keyCount(), 2);

        FactorAccount.Call[] memory c = _one(relayer, 1 ether, "");
        // the two accounts stand at different numbers, so the order is signed for the one it is tried on
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, 1, deadline));
        assertEq(other.nonce(), 1);
        vm.expectRevert(FactorAccount.BadSignature.selector);
        other.execute(c, deadline, sig);

        // and on another chain the same account at the same address would refuse it
        sig = _assertion(passkey, personKey, person.digest(c, 0, deadline));
        vm.chainId(1);
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(c, deadline, sig);
        vm.chainId(31337);
        person.execute(c, deadline, sig);
    }

    function test_onlyTheAccountsOwnKeySigns() public {
        vm.deal(address(person), 1 ether);
        FactorAccount.Call[] memory c = _one(relayer, 1 ether, "");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 d = person.digest(c, 0, deadline);
        // another passkey, under its own id and under the real key's id
        bytes32 thiefId = person.keyId(_passkey(thief));
        _refused(c, deadline, _assertion(thief, thiefId, d));
        _refused(c, deadline, _assertion(thief, personKey, d));
        // a wallet that is no key of this account
        _refused(c, deadline, _walletSig(botKey, d));
        // nothing at all, and nonsense
        _refused(c, deadline, "");
        _refused(c, deadline, abi.encodePacked(personKey));
        _refused(c, deadline, abi.encodePacked(personKey, bytes32(uint256(1)), bytes32(uint256(2))));
        assertEq(address(person).balance, 1 ether);
    }

    function test_aPasskeysAnswerMustBeForThisOrderWithItsOwnerVerified() public {
        vm.deal(address(person), 1 ether);
        FactorAccount.Call[] memory c = _one(relayer, 1 ether, "");
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 d = person.digest(c, 0, deadline);
        // an answer to another challenge
        _refused(c, deadline, _assertion(passkey, personKey, keccak256("something else")));
        // present, and not verified by fingerprint, face or PIN
        _refused(c, deadline, _assertion(passkey, personKey, d, 0x01, "webauthn.get", false));
        // not even present
        _refused(c, deadline, _assertion(passkey, personKey, d, 0x04, "webauthn.get", false));
        // the answer a passkey gives when it is being made, not when it signs
        _refused(c, deadline, _assertion(passkey, personKey, d, 0x05, "webauthn.create", false));
        // the other half of the same signature
        _refused(c, deadline, _assertion(passkey, personKey, d, 0x05, "webauthn.get", true));
        // a passkey that is kept in a synced keychain says so, and is taken
        person.execute(c, deadline, _assertion(passkey, personKey, d, 0x1d, "webauthn.get", false));
        assertEq(relayer.balance, 1 ether);
    }

    function test_allOfAnOrderHappensOrNoneOfIt() public {
        vm.deal(address(person), 1 ether);
        address friend = makeAddr("a friend");
        FactorAccount.Call[] memory c = new FactorAccount.Call[](2);
        c[0] = FactorAccount.Call(friend, 0.4 ether, "");
        // the desk refuses this: nobody is registered at that address
        c[1] = FactorAccount.Call(
            address(desk),
            0.1 ether,
            abi.encodeCall(FactorDesk.lock, (makeAddr("nobody"), block.timestamp + 1 days, false))
        );
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, 0, deadline));
        // the desk's own reason comes through, so whoever sent the order can say why
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        person.execute(c, deadline, sig);
        assertEq(friend.balance, 0);
        assertEq(address(person).balance, 1 ether);
        assertEq(person.nonce(), 0, "an order that did not happen did not use its number");

        // a call that fails without a word
        _refusedForPerson(
            _one(address(desk), 0, hex"deadbeef"), abi.encodeWithSelector(FactorAccount.CallFailed.selector, 0)
        );
        _refusedForPerson(new FactorAccount.Call[](0), abi.encodeWithSelector(FactorAccount.NoCalls.selector));
    }

    function test_anOrderCannotBeRunAgainFromInsideItself() public {
        Reenter back = new Reenter();
        vm.deal(address(person), 1 ether);
        FactorAccount.Call[] memory c = new FactorAccount.Call[](2);
        c[0] = FactorAccount.Call(relayer, 0.5 ether, "");
        c[1] = FactorAccount.Call(address(back), 0, abi.encodeCall(Reenter.again, ()));
        uint256 deadline = block.timestamp + 10 minutes;
        bytes memory sig = _assertion(passkey, personKey, person.digest(c, 0, deadline));
        back.arm(c, deadline, sig);
        vm.expectRevert(FactorAccount.BadSignature.selector);
        person.execute(c, deadline, sig);
        assertEq(address(person).balance, 1 ether);
    }

    // ---------- more than one key ----------

    function test_aSecondKeyIsAddedByAnOrderAndByNothingElse() public {
        vm.expectRevert(FactorAccount.OnlySelf.selector);
        person.addKey(_passkey(thief), "");
        vm.prank(relayer);
        vm.expectRevert(FactorAccount.OnlySelf.selector);
        person.removeKey(personKey);

        _asPerson(_one(address(person), 0, abi.encodeCall(FactorAccount.addKey, (_wallet(bot), ""))));
        assertEq(person.keyCount(), 2);
        _refusedForPerson(
            _one(address(person), 0, abi.encodeCall(FactorAccount.addKey, (_wallet(bot), ""))),
            abi.encodeWithSelector(FactorAccount.KeyExists.selector)
        );

        // the wallet signs orders now, and can send them itself and pay its own gas
        vm.deal(address(person), 1 ether);
        address friend = makeAddr("a friend");
        FactorAccount.Call[] memory c = _one(friend, 0.1 ether, "");
        uint256 deadline = block.timestamp + 10 minutes;
        vm.prank(relayer);
        person.execute(c, deadline, _walletSig(botKey, person.digest(c, person.nonce(), deadline)));
        vm.prank(bot);
        person.run(c);
        assertEq(friend.balance, 0.2 ether);
        vm.prank(relayer);
        vm.expectRevert(FactorAccount.NotAKey.selector);
        person.run(c);
    }

    function test_aKeyThatWasTakenAwaySignsNothingAndTheLastOneStays() public {
        _refusedForPerson(
            _one(address(person), 0, abi.encodeCall(FactorAccount.removeKey, (personKey))),
            abi.encodeWithSelector(FactorAccount.LastKey.selector)
        );
        _refusedForPerson(
            _one(address(person), 0, abi.encodeCall(FactorAccount.removeKey, (keccak256("no key")))),
            abi.encodeWithSelector(FactorAccount.NoSuchKey.selector)
        );

        _asPerson(_one(address(person), 0, abi.encodeCall(FactorAccount.addKey, (_passkey(second), "credential-2"))));
        bytes32 secondKey = person.keyId(_passkey(second));
        // the new device takes the old one's key away: a lost phone
        FactorAccount.Call[] memory c = _one(address(person), 0, abi.encodeCall(FactorAccount.removeKey, (personKey)));
        uint256 deadline = block.timestamp + 10 minutes;
        vm.prank(relayer);
        person.execute(c, deadline, _assertion(second, secondKey, person.digest(c, person.nonce(), deadline)));
        assertEq(person.keyCount(), 1);
        assertEq(uint8(person.key(personKey).kind), uint8(FactorAccount.Kind.None));

        vm.deal(address(person), 1 ether);
        c = _one(relayer, 1 ether, "");
        bytes32 d = person.digest(c, person.nonce(), deadline);
        _refused(c, deadline, _assertion(passkey, personKey, d));
        person.execute(c, deadline, _assertion(second, secondKey, d));
        assertEq(relayer.balance, 1 ether);
    }

    // ---------- signed texts ----------

    function test_aSignedTextIsKnownToBeTheOwners() public view {
        bytes32 text = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n11hello there"));
        assertEq(person.isValidSignature(text, _assertion(passkey, personKey, text)), VALID);
        assertEq(person.isValidSignature(text, _assertion(thief, personKey, text)), INVALID);
        assertEq(person.isValidSignature(text, _assertion(passkey, personKey, keccak256("other"))), INVALID);
        assertEq(
            person.isValidSignature(text, _assertion(passkey, personKey, text, 0x01, "webauthn.get", false)), INVALID
        );
        assertEq(agent.isValidSignature(text, _walletSig(botKey, text)), VALID);
        assertEq(agent.isValidSignature(keccak256("other"), _walletSig(botKey, text)), INVALID);
        assertEq(person.isValidSignature(text, _walletSig(botKey, text)), INVALID);
        assertEq(person.isValidSignature(text, ""), INVALID);
    }

    function testFuzz_nonsenseIsNeverASignatureAndNeverAnError(bytes32 hash, bytes memory junk, bool underTheKey)
        public
        view
    {
        bytes memory sig = underTheKey ? abi.encodePacked(personKey, junk) : junk;
        assertEq(person.isValidSignature(hash, sig), INVALID);
        assertEq(agent.isValidSignature(hash, sig), INVALID);
    }

    function testFuzz_anAnswerWithItsNumbersMovedIsNeverASignatureAndNeverAnError(
        bytes32 hash,
        uint256 challengeIndex,
        uint256 typeIndex,
        bytes memory authenticatorData,
        string memory json
    ) public view {
        bytes memory sig = abi.encodePacked(
            personKey,
            abi.encode(bytes32(uint256(1)), bytes32(uint256(1)), challengeIndex, typeIndex, authenticatorData, json)
        );
        assertEq(person.isValidSignature(hash, sig), INVALID);
    }

    function testFuzz_aRealAnswerWithItsNumbersMovedIsNoSignature(uint256 challengeIndex, uint256 typeIndex)
        public
        view
    {
        vm.assume(challengeIndex != 23 || typeIndex != 1);
        bytes32 text = keccak256("a text");
        bytes memory good = _assertion(passkey, personKey, text);
        assertEq(person.isValidSignature(text, good), VALID);
        // the two numbers are the third and fourth words after the key's id
        bytes memory moved = good;
        assembly ("memory-safe") {
            mstore(add(moved, 0x80), challengeIndex)
            mstore(add(moved, 0xa0), typeIndex)
        }
        assertEq(person.isValidSignature(text, moved), INVALID);
    }

    // ---------- on the desk ----------

    /// A person with a passkey hires an agent whose program has a key and no ETH. Neither ever pays gas: every
    /// transaction here is sent by somebody else.
    function test_aWholeJobBetweenTwoAccountsThatNeverPayGas() public {
        assertEq(bot.balance, 0);
        assertEq(address(agent).balance, 0);
        _asAgent(_one(address(desk), 0, abi.encodeCall(FactorDesk.register, ())));
        assertTrue(desk.agent(address(agent)).registered);

        // the person's ETH arrives at the account from wherever they have it
        vm.deal(address(person), 0.05 ether);
        bytes[] memory out = _asPerson(
            _one(
                address(desk),
                0.04 ether,
                abi.encodeCall(FactorDesk.lock, (address(agent), block.timestamp + 1 days, true))
            )
        );
        uint256 id = abi.decode(out[0], (uint256));
        assertEq(desk.job(id).customer, address(person));
        assertEq(desk.job(id).agent, address(agent));
        assertEq(address(person).balance, 0.01 ether);

        // the agent draws early: the advance lands in its account, inside the desk's own limit on gas for a payout
        _asAgent(_one(address(desk), 0, abi.encodeCall(FactorDesk.draw, (id, 0.02 ether, FactorDesk.Kind.Early))));
        assertEq(address(agent).balance, 0.0198 ether);
        assertEq(desk.owed(address(agent)), 0, "the account took the payout: nothing is left waiting in the desk");

        _asAgent(_one(address(desk), 0, abi.encodeCall(FactorDesk.deliver, (id, keccak256("the work")))));
        _asPerson(_one(address(desk), 0, abi.encodeCall(FactorDesk.accept, (id))));
        assertEq(uint8(desk.job(id).state), uint8(FactorDesk.State.Settled));
        // 0.04 less the 0.02 it drew, less the 2% job fee; and the 0.0198 it already had
        assertEq(address(agent).balance, 0.0198 ether + 0.02 ether - 0.0008 ether);
        assertEq(desk.owed(address(agent)), 0);
        assertEq(desk.agent(address(agent)).settled, 1);

        // the agent's owner takes it out to an address of their own
        address home = makeAddr("the owner's own address");
        _asAgent(_one(home, address(agent).balance, ""));
        assertEq(home.balance, 0.039 ether);
        assertEq(address(agent).balance, 0);
        assertEq(bot.balance, 0, "the agent's key never held a wei");
        _books();
    }

    function test_aRefundAndARejectionReachAnAccountToo() public {
        _asAgent(_one(address(desk), 0, abi.encodeCall(FactorDesk.register, ())));
        vm.deal(address(person), 0.1 ether);
        bytes[] memory out = _asPerson(
            _one(
                address(desk),
                0.04 ether,
                abi.encodeCall(FactorDesk.lock, (address(agent), block.timestamp + 1 days, false))
            )
        );
        uint256 first = abi.decode(out[0], (uint256));
        // nobody delivers: after the due time and the grace anybody refunds it, and the account has it all back
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(first);
        assertEq(address(person).balance, 0.1 ether);
        assertEq(desk.owed(address(person)), 0);

        out = _asPerson(
            _one(
                address(desk),
                0.04 ether,
                abi.encodeCall(FactorDesk.lock, (address(agent), block.timestamp + 1 days, false))
            )
        );
        uint256 secondJob = abi.decode(out[0], (uint256));
        _asAgent(
            _one(address(desk), 0, abi.encodeCall(FactorDesk.deliver, (secondJob, keccak256("not what was asked"))))
        );
        _asPerson(_one(address(desk), 0, abi.encodeCall(FactorDesk.reject, (secondJob))));
        assertEq(address(person).balance, 0.08 ether, "half of the price is back");
        assertEq(desk.owed(address(person)), 0);
        _books();
    }

    function test_theDeployChecksTheMakerOfAccounts() public view {
        assertEq(FactorAccount(payable(accounts.implementation())).factory(), address(accounts));
        assertEq(person.factory(), address(accounts));
    }
}
