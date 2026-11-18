// pay.billtrack.me sends the player back to /?coinOrder=<id>&payment=<hint>.
// Read the order id once and strip both params so a refresh doesn't re-trigger.
// The `payment` hint is ignored on purpose: only the server decides if it paid.
export function takeReturnedCoinOrder() {
  try {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('coinOrder');
    if (!id) return null;
    url.searchParams.delete('coinOrder');
    url.searchParams.delete('payment');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
