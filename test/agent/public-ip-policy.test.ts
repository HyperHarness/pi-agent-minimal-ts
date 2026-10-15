import test from "node:test";
import assert from "node:assert/strict";
import { isPublicIpAddress } from "../../src/agent/public-ip-policy.js";

function assertClassified(addresses: readonly string[], expected: boolean): void {
  for (const address of addresses) {
    assert.equal(
      isPublicIpAddress(address),
      expected,
      `${JSON.stringify(address)} should be ${expected ? "public" : "blocked"}`
    );
  }
}

test("classifies public IPv4 literals including each subnet's outer boundary", () => {
  assertClassified(
    [
      "1.1.1.1",
      "8.8.8.8",
      "9.255.255.255",
      "11.0.0.1",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.0.1.0",
      "192.0.3.0",
      "192.88.98.255",
      "192.88.100.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255"
    ],
    true
  );
});

test("rejects blocked IPv4 ranges at both edges", () => {
  assertClassified(
    [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.169.254",
      "172.16.0.0",
      "172.31.255.255",
      "192.0.0.0",
      "192.0.0.255",
      "192.0.2.0",
      "192.0.2.255",
      "192.88.99.0",
      "192.88.99.255",
      "192.168.0.1",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "198.51.100.0",
      "198.51.100.255",
      "203.0.113.0",
      "203.0.113.255",
      "224.0.0.0",
      "239.255.255.255",
      "240.0.0.0",
      "255.255.255.255"
    ],
    false
  );
});

test("classifies IPv6 global unicast in compressed, full and uppercase forms", () => {
  assertClassified(
    [
      "2000::1",
      "2001:200::1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "2a00:1450:4001:81b::200e",
      "2001:4860:4860:0000:0000:0000:0000:8888",
      "2001:4860:4860:0:0:0:0:8888",
      "2A00:1450:4001:081B::200E",
      "3fff:1000::1",
      "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
    ],
    true
  );
});

test("rejects IPv6 literals outside global unicast and inside the carved-out gaps", () => {
  assertClassified(
    [
      "::",
      "::1",
      "0:0:0:0:0:0:0:1",
      "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "2001::1",
      "2001:0:1234:5678::1",
      "2001:1::1",
      "2001:1ff:ffff::1",
      "2001:2::1",
      "2001:db8::1",
      "2002::1",
      "2002:c0a8:101::1",
      "3fff::1",
      "3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "4000::",
      "fc00::1",
      "fd12:3456:789a::1",
      "fec0::1",
      "fe80::1",
      "ff00::",
      "ff02::1"
    ],
    false
  );
});

test("judges IPv4-mapped IPv6 literals with the embedded IPv4 policy", () => {
  assertClassified(
    ["::ffff:1.1.1.1", "::ffff:8.8.8.8", "::FFFF:8.8.8.8", "::ffff:808:808", "::ffff:0808:0808", "0:0:0:0:0:ffff:8.8.8.8"],
    true
  );

  assertClassified(
    [
      "::ffff:0.0.0.0",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:192.168.0.1",
      "::ffff:a00:1",
      "::ffff:7f00:1",
      "::ffff:c0a8:1",
      "0:0:0:0:0:ffff:192.168.0.1"
    ],
    false
  );
});

test("rejects malformed, non-literal and zone-scoped input", () => {
  assertClassified(
    [
      "",
      " ",
      "localhost",
      "example.com",
      "8.8.8.8.example.com",
      "2130706433",
      "0x7f000001",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "1.2.3.-1",
      "1.2.3.4 ",
      " 1.2.3.4",
      "1.2.3.4\n",
      "01.2.3.4",
      "1.2.3.04",
      "1.2.3.4/24",
      "1.2.3.4:80",
      "::1%eth0",
      "fe80::1%eth0",
      "2001:db8::1%eth0",
      ":::",
      "2001:db8:::1",
      "12345::1",
      "2001:db8::g",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8::1/64",
      "::ffff:256.1.1.1",
      "::ffff:1.2.3"
    ],
    false
  );
});
