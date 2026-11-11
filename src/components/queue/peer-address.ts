/** An IPv4 peer on a dual-stack socket reads `[::ffff:1.2.3.4]:80`. */
export function shortPeerAddress(addr: string): string {
  return addr.replace(/^\[::ffff:([\d.]+)\]/i, '$1');
}
