// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Review proof-of-concept, not part of the suite. script/Launch.s.sol hardcodes the Pons salt as
// keccak256("FACTOR"). Does a stranger who launches with that salt first make the admin's launch revert?
import {ForkBase} from "../fork/ForkBase.sol";

contract ReviewSaltForkTest is ForkBase {
    address admin = makeAddr("factor admin");
    address gateway = makeAddr("factor gateway");
    address stranger = makeAddr("stranger");

    function test_review_strangerOccupiesTheScriptSalt() public {
        _fork();
        Factor memory h = _deployFactor(address(this), admin, gateway, _pons());
        bytes32 salt = keccak256("FACTOR"); // what script/Launch.s.sol sends
        (address decoy,) = _launchDirect(stranger, stranger, 300, false, salt);
        emit log_named_address("stranger's token with the script's salt", decoy);

        uint256 fee = _pons().launchFee();
        vm.deal(admin, fee);
        vm.prank(admin);
        (bool ok, bytes memory ret) =
            address(h.burnPot).call{value: fee}(abi.encodeCall(h.burnPot.launch, (_params(salt), 0, new address[](0))));
        if (ok) {
            emit log_named_address("admin's launch went through, token", abi.decode(ret, (address)));
        } else {
            emit log_named_bytes("admin's launch REVERTED with", ret);
        }
        assertTrue(ok, "the admin's launch is blocked by a stranger using the same salt");
    }
}
