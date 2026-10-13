// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// An account for somebody without a wallet.
///
/// It holds ETH and makes calls, as a wallet does, and it is a customer or an agent on the desk like any other
/// address. What it obeys is a key its owner holds and nobody else does:
///
///   a passkey   the key a phone or a laptop keeps behind a fingerprint, a face or a PIN. It signs with the P-256
///               curve, which this chain checks natively.
///   a wallet    an ordinary address. An agent's program has one of these and no ETH to pay gas with; a person may
///               add one to their account as a second way in.
///
/// The owner signs what the account should do. ANYONE may then hand that signature to the account, and whoever does
/// pays the gas: that is how Factor pays it for its users, and why nobody depends on Factor to do so. An order is
/// good for this account only, on this chain only, once, and until its deadline.
///
/// Nobody else has any power here. There is no owner, no guardian, no way to recover an account for somebody and
/// no way to upgrade it. An account whose every key is lost is lost, so its owner can add a second key.
contract FactorAccount {
    enum Kind {
        None,
        Wallet, // a: the address
        Passkey // a, b: the public key's x and y
    }

    struct Key {
        Kind kind;
        bytes32 a;
        bytes32 b;
    }

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Factor Account");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant CALL_TYPEHASH = keccak256("Call(address to,uint256 value,bytes data)");
    bytes32 private constant EXECUTE_TYPEHASH =
        keccak256("Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)");
    bytes4 private constant ERC1271_VALID = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    /// The factory that makes accounts. Only it can give a new account its first key.
    address public immutable factory;

    mapping(bytes32 id => Key) private _keys;
    /// How many keys the account obeys. Never zero once it exists.
    uint256 public keyCount;
    /// The number the next order must carry. Each order uses one, in order, so none can be used twice.
    uint256 public nonce;

    event KeyAdded(bytes32 indexed id, Kind kind, bytes32 a, bytes32 b, bytes credential);
    event KeyRemoved(bytes32 indexed id);
    event Executed(uint256 indexed nonce, bytes32 indexed key, uint256 calls);

    error OnlyFactory();
    error OnlySelf();
    error NotAKey();
    error BadKey();
    error KeyExists();
    error NoSuchKey();
    error LastKey();
    error Expired(uint256 deadline);
    error BadSignature();
    error NoCalls();
    error CallFailed(uint256 index);

    constructor() {
        factory = msg.sender;
    }

    /// The account takes ETH from anybody: its owner's own, an advance, a payment, a refund.
    receive() external payable {}

    /// The first key, given by the factory in the transaction that makes the account.
    function initialize(Key calldata first, bytes calldata credential) external {
        if (msg.sender != factory || keyCount != 0) revert OnlyFactory();
        _add(first, credential);
    }

    // ---------- doing things ----------

    /// What the owner signed, carried out. Anyone may send it. All of it happens or none of it.
    ///
    /// `signature` is a wallet key's 65 bytes over the order's EIP-712 digest, or for a passkey the key's id
    /// followed by the passkey's answer to that digest as its challenge (see {_signer}).
    function execute(Call[] calldata calls, uint256 deadline, bytes calldata signature)
        external
        returns (bytes[] memory results)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        uint256 n = nonce;
        bytes32 id = _signer(digest(calls, n, deadline), signature);
        if (id == bytes32(0)) revert BadSignature();
        nonce = n + 1;
        emit Executed(n, id, calls.length);
        return _run(calls);
    }

    /// The same, sent by one of the account's wallet keys itself, which then pays its own gas and needs no
    /// signature beyond the transaction's.
    function run(Call[] calldata calls) external returns (bytes[] memory results) {
        bytes32 id = keyId(Key(Kind.Wallet, bytes32(uint256(uint160(msg.sender))), bytes32(0)));
        if (_keys[id].kind != Kind.Wallet) revert NotAKey();
        uint256 n = nonce;
        nonce = n + 1;
        emit Executed(n, id, calls.length);
        return _run(calls);
    }

    function _run(Call[] calldata calls) private returns (bytes[] memory results) {
        if (calls.length == 0) revert NoCalls();
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory out) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                // the reason the call gave is passed on as it is, so whoever sent the order is told why
                if (out.length == 0) revert CallFailed(i);
                assembly ("memory-safe") {
                    revert(add(out, 0x20), mload(out))
                }
            }
            results[i] = out;
        }
    }

    /// What a key signs for an order: EIP-712, so a wallet shows its owner the calls, and bound to this account
    /// and this chain.
    function digest(Call[] calldata calls, uint256 nonce_, uint256 deadline) public view returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data)));
        }
        bytes32 order = keccak256(abi.encode(EXECUTE_TYPEHASH, keccak256(abi.encodePacked(hashes)), nonce_, deadline));
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked(hex"1901", domain, order));
    }

    // ---------- keys ----------

    /// A second key: another device's passkey, or a wallet. Only the account itself can add one, which means an
    /// order one of its keys signed. `credential` is the passkey's own name for itself, written to the log so the
    /// owner's browser can find the account again; it is not used by the contract.
    function addKey(Key calldata k, bytes calldata credential) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _add(k, credential);
    }

    /// Takes a key away. Never the last one.
    function removeKey(bytes32 id) external {
        if (msg.sender != address(this)) revert OnlySelf();
        if (_keys[id].kind == Kind.None) revert NoSuchKey();
        if (keyCount == 1) revert LastKey();
        delete _keys[id];
        keyCount -= 1;
        emit KeyRemoved(id);
    }

    function _add(Key calldata k, bytes calldata credential) private {
        if (k.kind == Kind.Wallet) {
            if (k.a == bytes32(0) || uint256(k.a) >> 160 != 0 || k.b != bytes32(0)) revert BadKey();
        } else if (k.kind == Kind.Passkey) {
            if (!P256.isValidPublicKey(k.a, k.b)) revert BadKey();
        } else {
            revert BadKey();
        }
        bytes32 id = keyId(k);
        if (_keys[id].kind != Kind.None) revert KeyExists();
        _keys[id] = k;
        keyCount += 1;
        emit KeyAdded(id, k.kind, k.a, k.b, credential);
    }

    function keyId(Key memory k) public pure returns (bytes32) {
        return keccak256(abi.encode(k.kind, k.a, k.b));
    }

    function key(bytes32 id) external view returns (Key memory) {
        return _keys[id];
    }

    // ---------- signatures ----------

    /// ERC-1271: whether one of the account's keys signed `hash`. This is how the engine knows a name, a job's
    /// title or a request for a compute key came from the account's owner.
    ///
    /// A hash here is not bound to the account by this contract. Whoever asks for one to be signed binds it, as
    /// Factor's signed texts do by carrying the account's address.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _signer(hash, signature) == bytes32(0) ? ERC1271_INVALID : ERC1271_VALID;
    }

    /// The id of the key that signed `hash`, or zero.
    ///
    /// 65 bytes: a wallet's signature. Anything longer: 32 bytes of key id, then the passkey's answer
    /// (r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON, ABI-encoded), whose challenge must be
    /// `hash` and which must say its owner was verified by fingerprint, face or PIN.
    function _signer(bytes32 hash, bytes calldata signature) private view returns (bytes32) {
        if (signature.length == 65) {
            (address who, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
            if (err != ECDSA.RecoverError.NoError) return bytes32(0);
            bytes32 walletId = keyId(Key(Kind.Wallet, bytes32(uint256(uint160(who))), bytes32(0)));
            return _keys[walletId].kind == Kind.Wallet ? walletId : bytes32(0);
        }
        if (signature.length < 32) return bytes32(0);
        bytes32 id = bytes32(signature[:32]);
        Key storage k = _keys[id];
        if (k.kind != Kind.Passkey) return bytes32(0);
        (bool decoded, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(signature[32:]);
        if (!decoded) return bytes32(0);
        // The two numbers say where in the passkey's own text its type and its challenge stand. The check that
        // reads them looks at memory at those places whatever they are, so a number far outside the text would
        // make it run out of gas instead of saying no: they are held inside the text here.
        uint256 length = bytes(auth.clientDataJSON).length;
        if (auth.typeIndex >= length || auth.challengeIndex >= length) return bytes32(0);
        return WebAuthn.verify(abi.encodePacked(hash), auth, k.a, k.b, true) ? id : bytes32(0);
    }
}

/// Makes accounts. Each is a small copy that runs FactorAccount's code and keeps its own keys and ETH.
///
/// An account's address follows from its first key alone, so the same key always leads to the same account, and
/// making an account for somebody else's key gives them an account and takes nothing from them. Anyone may call
/// this; nobody owns it.
contract FactorAccounts {
    address public immutable implementation;

    event Created(
        address indexed account, bytes32 indexed keyId, FactorAccount.Kind kind, bytes32 a, bytes32 b, bytes credential
    );

    constructor() {
        implementation = address(new FactorAccount());
    }

    /// The account of `first`, made now if it does not exist yet.
    function create(FactorAccount.Key calldata first, bytes calldata credential) external returns (address account) {
        bytes32 salt = keccak256(abi.encode(first.kind, first.a, first.b));
        account = Clones.predictDeterministicAddress(implementation, salt);
        if (account.code.length > 0) return account;
        Clones.cloneDeterministic(implementation, salt);
        FactorAccount(payable(account)).initialize(first, credential);
        emit Created(account, salt, first.kind, first.a, first.b, credential);
    }

    /// Where the account of `first` is, whether or not it has been made.
    function addressOf(FactorAccount.Key calldata first) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, keccak256(abi.encode(first.kind, first.a, first.b)));
    }
}
