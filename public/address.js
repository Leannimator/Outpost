/* Delivery address fields shared by the auction sign-up and the "add your address" box. */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const US = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
  const CA = { AB:'Alberta',BC:'British Columbia',MB:'Manitoba',NB:'New Brunswick',NL:'Newfoundland and Labrador',NS:'Nova Scotia',NT:'Northwest Territories',NU:'Nunavut',ON:'Ontario',PE:'Prince Edward Island',QC:'Quebec',SK:'Saskatchewan',YT:'Yukon' };
  const opts = (map, cur) => '<option value="">Choose…</option>' + Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  // Markup for the address fields (country, street, city, state, ZIP). Name and email are asked elsewhere.
  function html(a) {
    a = a || {}; const c = a.country === 'CA' ? 'CA' : 'US';
    return `<div class="addrbox">
      <label class="field"><span class="label">Country</span><select class="input" data-a="country" autocomplete="country"><option value="US"${c === 'US' ? ' selected' : ''}>United States</option><option value="CA"${c === 'CA' ? ' selected' : ''}>Canada</option></select></label>
      <label class="field"><span class="label">Delivery address</span><input class="input" data-a="line1" autocomplete="address-line1" maxlength="120" value="${esc(a.line1)}"></label>
      <label class="field"><span class="label">Apartment, suite, etc. (optional)</span><input class="input" data-a="line2" autocomplete="address-line2" maxlength="120" value="${esc(a.line2)}"></label>
      <div class="grid2">
        <label class="field"><span class="label">City</span><input class="input" data-a="city" autocomplete="address-level2" maxlength="80" value="${esc(a.city)}"></label>
        <label class="field"><span class="label" data-a-lab="state">${c === 'CA' ? 'Province' : 'State'}</span><select class="input" data-a="state" autocomplete="address-level1">${opts(c === 'CA' ? CA : US, a.state)}</select></label>
      </div>
      <label class="field"><span class="label" data-a-lab="zip">${c === 'CA' ? 'Postal code' : 'ZIP code'}</span><input class="input" data-a="zip" autocomplete="postal-code" maxlength="10" value="${esc(a.zip)}"></label>
    </div>`;
  }
  // Wire the country switch inside a container, then read the values back.
  function wire(root) {
    const q = (k) => root.querySelector(`[data-a="${k}"]`);
    q('country').onchange = () => {
      const c = q('country').value; q('state').innerHTML = opts(c === 'CA' ? CA : US, '');
      root.querySelector('[data-a-lab="state"]').textContent = c === 'CA' ? 'Province' : 'State';
      root.querySelector('[data-a-lab="zip"]').textContent = c === 'CA' ? 'Postal code' : 'ZIP code';
    };
  }
  function read(root) {
    const g = (k) => String((root.querySelector(`[data-a="${k}"]`) || {}).value || '').trim();
    return { country: g('country'), line1: g('line1'), line2: g('line2'), city: g('city'), state: g('state'), zip: g('zip').toUpperCase() };
  }
  window.OutpostAddress = { html, wire, read };
})();
