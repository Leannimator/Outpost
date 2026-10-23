/* Outpost branding: colors, logo and graphics.
   Shared by the server (it builds /theme.css from the same code) and every page in the browser. */
(function (root) {
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (h) => { const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const TEXTMODES = ['', 'same', 'each'];
  // The text colors actually in effect (null = leave the built-in color alone).
  function textColors(t) {
    const ok = (k) => (HEX.test(t[k] || '') ? t[k] : null);
    if (t.textmode === 'same') { const c = ok('text'); return { body: c, heading: c, link: c, buttontext: c }; }
    if (t.textmode === 'each') return { body: ok('text'), heading: ok('heading'), link: ok('link'), buttontext: ok('buttontext') };
    return { body: null, heading: null, link: null, buttontext: null };
  }

  const PALETTES = [
    { name: 'Outpost', bg: '#fcf6ea', accent: '#ebc9b0', button: '#f72d00' },
    { name: 'Meadow', bg: '#f4f6ec', accent: '#cfe3b5', button: '#35563f' },
    { name: 'Berry', bg: '#fbf1f3', accent: '#f0b4c6', button: '#5b2a45' },
    { name: 'Harbor', bg: '#f0f5f7', accent: '#b8d4e3', button: '#24435c' },
    { name: 'Dusk', bg: '#f6f1f8', accent: '#d3c0ea', button: '#3d2f5c' },
    { name: 'Clay', bg: '#faf2ea', accent: '#f2c2a0', button: '#7a3b25' },
  ];

  // Buttons carry white text, so they must be dark enough to read.
  const buttonOk = (h, label) => HEX.test(h) && (HEX.test(label || '') ? contrast(h, label) >= 3 : lum(h) < 0.3);

  function lightVars(t) {
    const v = [];
    if (HEX.test(t.bg || '')) v.push('--cream:' + t.bg, '--cream-2:' + mix(t.bg, '#000000', 0.045), '--card:' + mix(t.bg, '#ffffff', 0.55), '--line:' + mix(t.bg, '#000000', 0.09));
    if (HEX.test(t.accent || '')) v.push('--rose:' + t.accent, '--rose-2:' + mix(t.accent, '#ffffff', 0.6), '--rose-ink:' + mix(t.accent, '#000000', 0.62));
    const tc = textColors(t), pageBg = HEX.test(t.bg || '') ? t.bg : PALETTES[0].bg;
    if (tc.body) v.push('--ink:' + tc.body, '--muted:' + mix(tc.body, pageBg, 0.4), '--lotdesc:' + mix(tc.body, pageBg, 0.2));
    if (tc.heading) v.push('--heading:' + tc.heading);
    if (tc.link) v.push('--link:' + tc.link);
    if (tc.buttontext) v.push('--on-forest:' + tc.buttontext);
    if (buttonOk(t.button || '', tc.buttontext)) v.push('--forest:' + t.button, '--forest-2:' + mix(t.button, '#ffffff', 0.12));
    return v;
  }

  // Dark mode is built from the same three colors: the page turns into a deep shade of the button color,
  // the background color becomes the text color, and buttons flip to a light shade with dark text.
  function darkVars(t) {
    const d = PALETTES[0];
    const bgL = HEX.test(t.bg || '') ? t.bg : d.bg;
    const acc = HEX.test(t.accent || '') ? t.accent : d.accent;
    const btn = buttonOk(t.button || '') ? t.button : d.button;
    const bg = mix(btn, '#000000', 0.72);
    return [
      '--cream:' + bg, '--cream-2:' + mix(bg, '#ffffff', 0.06), '--card:' + mix(bg, '#ffffff', 0.08), '--line:' + mix(bg, '#ffffff', 0.17),
      '--ink:' + bgL, '--muted:' + mix(bgL, bg, 0.45), '--lotdesc:' + mix(bgL, bg, 0.2),
      '--rose:' + acc, '--rose-2:' + mix(acc, bg, 0.75), '--rose-ink:' + mix(acc, '#000000', 0.72),
      '--forest:' + mix(btn, '#ffffff', 0.55), '--forest-2:' + mix(btn, '#ffffff', 0.65), '--on-forest:' + bg,
      '--clay:' + mix('#c4533d', '#ffffff', 0.25), '--field:' + mix(bg, '#ffffff', 0.05), '--hover:rgba(255,255,255,.07)', '--receipt-bg:' + mix(bg, '#ffffff', 0.08),
      '--shadow:0 1px 2px rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.3)',
      '--ok-bg:#1d3a2a', '--ok-ink:#8fd6a8', '--info-bg:#1f2d44', '--info-ink:#9bb8e6', '--mute-bg:' + mix(bg, '#ffffff', 0.12), '--mute-ink:' + mix(bgL, bg, 0.4),
      '--warn-bg:#46350f', '--warn-ink:#f1c36b', '--msg-bg:#1c3329', '--err-bg:#432019', '--err-ink:#f2a496', '--out-bg:#432019',
      '--heading:initial', '--link:initial', 'color-scheme:dark',
    ];
  }

  const MODES = ['light', 'dark', 'auto'];
  function css(t) {
    t = t || {};
    const mode = MODES.includes(t.mode) ? t.mode : 'light';
    const light = lightVars(t);
    if (mode === 'dark') return ':root{' + darkVars(t).join(';') + '}';
    let out = light.length ? ':root{' + light.join(';') + '}' : '';
    if (mode === 'auto') out += '@media (prefers-color-scheme: dark){:root{' + darkVars(t).join(';') + '}}';
    return out;
  }

  const api = { css, PALETTES, buttonOk, HEX, MODES, TEXTMODES, textColors, contrast };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined') {
    const DEFAULTS = { mascot: '/art/mascot.svg', sold: '/art/sold.svg' };
    api.apply = function (s) {
      s = s || {};
      let st = document.getElementById('outpost-theme');
      if (!st) { st = document.createElement('style'); st.id = 'outpost-theme'; document.head.appendChild(st); }
      st.textContent = css(s.theme);
      document.querySelectorAll('[data-brand="name"]').forEach((el) => {
        const name = s.store_name || 'Outpost';
        if (s.logo_url) {
          if (el.dataset.logo !== s.logo_url) { el.dataset.logo = s.logo_url; el.textContent = ''; const im = document.createElement('img'); im.className = 'logo'; im.alt = name; im.src = s.logo_url; el.appendChild(im); }
        } else { delete el.dataset.logo; el.textContent = name; }
      });
      const hasAbout = !!(s.about_text || Object.keys(s.social || {}).length);
      document.querySelectorAll('.shop-brand nav, header nav').forEach((nav) => {
        const cur = nav.querySelector('[data-about]');
        if (!hasAbout) { if (cur) cur.remove(); return; }
        if (cur) return;
        const a = document.createElement('a'); a.href = 'about.html'; a.dataset.about = '1';
        if (document.body.dataset.page === 'about') a.className = 'on';
        const hasIcons = !!nav.querySelector('svg');
        a.innerHTML = (hasIcons ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg><span>About</span>' : 'About');
        nav.appendChild(a);
        if (a.className === 'on') nav.querySelectorAll('a.on').forEach((x) => { if (x !== a) x.classList.remove('on'); });
      });
      ['mascot', 'sold'].forEach((k) => {
        document.querySelectorAll('img[data-brand="' + k + '"]').forEach((im) => {
          const src = s[k + '_url'] || DEFAULTS[k];
          if (im.dataset.src === src) return;
          im.dataset.src = src; im.hidden = true;
          im.onload = () => { im.hidden = false; };
          im.onerror = () => { im.hidden = true; };
          im.src = src;
        });
      });
    };
    root.OutpostBrand = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
