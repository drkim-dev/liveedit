import { networkInterfaces } from "node:os";

function normalize(address: string): string {
  return address.replace(/^::ffff:/, "").split("%")[0];
}

/** Host authority comes from the server PC, never from a client-supplied header. */
export function isServerPeer(address: string | undefined): boolean {
  if (!address) return false;
  const peer = normalize(address);
  if (peer === "::1" || /^127\./.test(peer)) return true;
  return Object.values(networkInterfaces()).flat().some((entry) => entry && normalize(entry.address) === peer);
}
