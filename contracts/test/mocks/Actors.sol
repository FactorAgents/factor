// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A wallet that refuses ETH, or accepts it, as told.
contract Rejecter {
    bool public accept;

    function setAccept(bool on) external {
        accept = on;
    }

    receive() external payable {
        require(accept, "no");
    }
}

/// A wallet whose code burns all the gas it is given.
contract GasEater {
    uint256 internal sink;

    receive() external payable {
        while (true) {
            sink += 1;
        }
    }
}

/// A wallet that, when paid, calls back into whoever paid it with whatever call it was armed with.
contract Reenterer {
    bytes public armed;
    bool public reentered;
    bool public reentrySucceeded;

    function arm(bytes calldata data) external {
        armed = data;
    }

    function call(address target, bytes calldata data) external payable returns (bool ok, bytes memory out) {
        (ok, out) = target.call{value: msg.value}(data);
    }

    receive() external payable {
        if (armed.length != 0) {
            reentered = true;
            (bool ok,) = msg.sender.call(armed);
            if (ok) reentrySucceeded = true;
        }
    }
}

/// A wallet that sends part of what it is paid straight back.
contract Bouncer {
    uint256 public back;

    function setBack(uint256 wei_) external {
        back = wei_;
    }

    receive() external payable {
        if (back != 0 && msg.value >= back) {
            (bool ok,) = msg.sender.call{value: back}("");
            require(ok, "bounce refused");
        }
    }
}

/// Puts ETH into an address without calling it, the way a self-destructing contract can.
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// A pot that can be told to refuse ETH, wired the way the splitter's constructor checks.
contract TogglePot {
    address public splitter;
    address public factory;
    address public token;
    address public burnPot;
    bool public reject;

    constructor(address splitter_, address factory_, address burnPot_) {
        splitter = splitter_;
        factory = factory_;
        burnPot = burnPot_;
    }

    function setReject(bool on) external {
        reject = on;
    }

    receive() external payable {
        require(!reject, "pot refuses");
    }
}
