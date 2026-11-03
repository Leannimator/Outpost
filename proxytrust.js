'use strict';
// Which "hops" in the X-Forwarded-For list the app believes, so each visitor keeps their real address for rate limits.
//
// TRUST_PROXY=cloudflare (the setting for a site that may sit behind Cloudflare's orange cloud):
//  - the connection straight into the app is always trusted (that is Render's own front door), exactly like TRUST_PROXY=1;
//  - an address further back is believed ONLY if it is one of Cloudflare's published server ranges (or a private address inside the host).
// So a visitor who reaches the app through Cloudflare is seen as their real address, and a visitor who skips Cloudflare and goes
// straight to the host's own address cannot pretend to be someone else by writing a fake header: the address they really connected
// from is not a Cloudflare address, so nothing to the left of it is believed.
// Source of the ranges: https://www.cloudflare.com/ips-v4 and /ips-v6 (checked 2026-11-03). They change rarely; when they do, update
// this list. If it is ever stale the worst case is the old behaviour (every visitor behind a new Cloudflare range looks like one address
// for rate limits), not a way around them.
const proxyaddr = require('proxy-addr');

const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function cloudflareTrust() {
  const known = proxyaddr.compile(['loopback', 'uniquelocal', ...CLOUDFLARE_RANGES]);
  return (addr, i) => i === 0 || known(addr);
}

module.exports = { cloudflareTrust, CLOUDFLARE_RANGES };
