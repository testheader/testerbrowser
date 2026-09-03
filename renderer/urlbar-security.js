function classify(url) {
  if (!url) return { cls: 'neutral', icon: '🔒', proto: '', rest: '' };
  let proto;
  try { proto = new URL(url).protocol; } catch { return { cls: 'neutral', icon: '🔒', proto: '', rest: url }; }
  if (proto === 'https:') return { cls: 'secure',   icon: '🔒', proto: 'https://', rest: url.slice('https://'.length) };
  if (proto === 'http:')  return { cls: 'insecure', icon: '🔓', proto: 'http://',  rest: url.slice('http://'.length) };
  // Internal schemes (file:, chrome-error:, devtools:, about:, data:, …) get a neutral lock.
  return { cls: 'neutral', icon: '🔒', proto: '', rest: url };
}

export function updateUrlbarSecurity(url) {
  const lock = document.getElementById('urlbarLock');
  const display = document.getElementById('urlbarDisplay');
  const { cls, icon, proto, rest } = classify(url);

  lock.className = cls;
  lock.textContent = icon;

  display.innerHTML = '';
  if (proto) {
    const protoSpan = document.createElement('span');
    protoSpan.className = 'url-proto';
    protoSpan.textContent = proto;
    display.appendChild(protoSpan);
  }
  display.appendChild(document.createTextNode(rest));
}
