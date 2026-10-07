// Consume credentials before React or navigation can copy the current URL.
export function consumeKeyLink() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has('key')) return '';
  const key = fragment.get('key')?.trim() ?? '';
  fragment.delete('key');
  url.hash = fragment.toString();
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  return key;
}
