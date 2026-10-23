/* Builds the Privacy Policy and Terms pages from the shop's settings.
   Plain-language starting templates. The shop owner fills in the details in Settings → Policies. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const para = (t) => String(t || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

  function regionsText(p) {
    if (p.ship_regions === 'us') return 'within the United States';
    if (p.ship_regions === 'usca') return 'to the United States and Canada';
    if (p.ship_regions === 'world') return 'worldwide';
    return '';
  }

  // The seller's own text: blank line = new paragraph, "## " starts a heading, "- " starts a bullet.
  function own(title, s, p, text) {
    const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
      if (/^##\s/.test(b)) return `<h2>${esc(b.replace(/^##\s+/, ''))}</h2>`;
      const lines = b.split('\n');
      if (lines.every((l) => /^-\s/.test(l.trim()))) return '<ul>' + lines.map((l) => `<li>${esc(l.trim().replace(/^-\s+/, ''))}</li>`).join('') + '</ul>';
      return `<p>${esc(b).replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return `<h1>${title}</h1><p class="muted">${esc(s.store_name)} · Last updated ${esc(p.updated || '')}</p>${blocks}`;
  }

  function privacy(s, p) {
    if (p.privacy_own && String(p.privacy_custom || '').trim()) return own('Privacy Policy', s, p, p.privacy_custom);
    const name = esc(s.store_name);
    const contact = p.contact_email ? `<a href="mailto:${esc(p.contact_email)}">${esc(p.contact_email)}</a>` : 'the shop’s contact details';
    return `<h1>Privacy Policy</h1>
      <p class="muted">${name} · Last updated ${esc(p.updated || '')}</p>
      <p>This explains what ${name} collects when you shop, bid or sign up, and what happens to it. We keep it short and we never sell your information.</p>
      <h2>What we collect</h2>
      <ul>
        <li><b>Orders:</b> your name, email and shipping address, so we can take payment and send your order.</li>
        <li><b>Auctions:</b> your name and email when you register to bid, and your bids.</li>
        ${s.mailing_list_on ? '<li><b>Email list:</b> your email address, if you choose to sign up for news from us.</li>' : ''}
        <li><b>Reviews:</b> what you write, shown with your first name and last initial.</li>
        <li><b>Safety checks:</b> your IP address and basic browser details, used only to stop spam and fraud.</li>
      </ul>
      <h2>Payments</h2>
      <p>Card payments are handled by Stripe. Your card number goes straight to Stripe and is never seen or stored by ${name}. Stripe’s own privacy policy covers how they handle it.</p>
      <h2>Who we share it with</h2>
      <p>Only the services needed to run the shop: Stripe for payments and shipping carriers to deliver your order. We don’t sell or rent your information, and we don’t show you third-party ads.</p>
      <h2>Cookies and storage</h2>
      <p>We store small items in your browser, like what’s in your cart and which bidder you are, so the shop works. We don’t use advertising or tracking cookies.</p>
      ${s.mailing_list_on ? `<h2>Our email list</h2><p>If you join, we use your email only to send news from ${name}. Every email has a way to unsubscribe, or you can ask us at ${contact} and we’ll remove you.</p>` : ''}
      ${p.privacy_extra ? `<h2>More from us</h2>${para(p.privacy_extra)}` : ''}
      <h2>Your choices and contact</h2>
      <p>You can ask to see, correct or delete your information, or ask us anything about this policy, by writing to ${contact}. We keep order records for as long as the law requires for tax and accounting.</p>`;
  }

  function terms(s, p) {
    if (p.terms_own && String(p.terms_custom || '').trim()) return own('Terms of Service', s, p, p.terms_custom);
    const name = esc(s.store_name);
    const contact = p.contact_email ? `<a href="mailto:${esc(p.contact_email)}">${esc(p.contact_email)}</a>` : 'the shop’s contact details';
    const where = regionsText(p);
    const ship = [
      s.ship_days ? `We usually ship within ${s.ship_days} day${s.ship_days === 1 ? '' : 's'} of payment.` : '',
      where ? `We ship ${where}.` : '',
      p.ship_note || '',
    ].filter(Boolean).join(' ');
    const refund = (s.refund_policy && s.refund_policy.text) || '';
    return `<h1>Terms of Service</h1>
      <p class="muted">${name} · Last updated ${esc(p.updated || '')}</p>
      <p>By ordering from or bidding at ${name}, you agree to these terms.</p>
      <h2>Orders and payment</h2>
      <p>Prices are shown in ${esc((s.currency || 'usd').toUpperCase())}. Sales tax is added at checkout where it applies. Payment is taken securely by Stripe. We may cancel and refund an order if an item turns out to be unavailable.</p>
      ${ship ? `<h2>Shipping</h2><p>${esc(ship)}</p>` : ''}
      ${refund ? `<h2>Returns and refunds</h2><p>${esc(refund)}</p>` : ''}
      <h2>Auctions</h2>
      <p>A bid is a promise to buy. If you hold the highest bid when an auction ends, you agree to pay for the item. Where a card is required to bid, it is only charged if you win. Bids can’t be withdrawn once placed. Anyone who bids and doesn’t pay may be blocked from future auctions.</p>
      <h2>Handmade work and copyright</h2>
      <p>The artwork, designs, photos and text on this site belong to ${name}. Please don’t copy, reproduce or sell them without written permission. Buying a piece gives you the physical item, not the right to reproduce the design.</p>
      <h2>Reviews</h2>
      <p>Reviews come from verified buyers. We may hide reviews that contain abuse, spam or personal information.</p>
      ${p.terms_extra ? `<h2>More from us</h2>${para(p.terms_extra)}` : ''}
      ${p.governing_law ? `<h2>Governing law</h2><p>These terms are governed by the laws of ${esc(p.governing_law)}.</p>` : ''}
      <p>Questions about these terms? Write to ${contact}.</p>`;
  }

  window.OutpostLegal = { privacy, terms, own };

  window.renderLegal = function (doc) {
    fetch('/api/settings').then((r) => r.json()).then((s) => {
      OutpostBrand.apply(s);
      const p = s.policy || {};
      document.title = (doc === 'privacy' ? 'Privacy Policy' : 'Terms of Service') + ' — ' + s.store_name;
      $('page').innerHTML = (doc === 'privacy' ? privacy : terms)(s, p);
    }).catch(() => { $('page').innerHTML = '<p>Couldn’t load this page. Please try again.</p>'; });
  };
})();
