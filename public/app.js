(function () {
  function redirectToLogin() {
    window.location.href = 'login.html?next=' + encodeURIComponent(window.location.pathname.split('/').pop());
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
    return fetch('/api' + path, opts).then(function (res) {
      if (res.status === 401) {
        redirectToLogin();
        throw new Error('not logged in');
      }
      if (!res.ok) {
        return res.json().then(function (body) {
          throw new Error(body.error || 'request failed');
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function loadWhoAmI() {
    fetch('/api/auth/me').then(function (res) {
      if (!res.ok) {
        redirectToLogin();
        return null;
      }
      return res.json();
    }).then(function (me) {
      if (me) document.getElementById('whoami').textContent = 'Signed in as ' + me.username;
    });
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(redirectToLogin);
  });

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(dateStr + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  }

  // Returns a body object for the throw-out/consume request, or null if the
  // user cancelled. Only asks when there's more than one unit on hand.
  function promptQuantity(item, verb) {
    if (!(item.quantity > 1)) return {};
    var input = window.prompt(
      'How many "' + item.name + '" to mark as ' + verb + '? (' + item.quantity + ' on hand)',
      item.quantity
    );
    if (input === null) return null;
    var qty = parseFloat(input);
    if (!(qty > 0)) {
      alert('Enter a positive number.');
      return null;
    }
    return { quantity: qty };
  }

  // Pre-fills the purchase form from an existing item, so buying more of
  // something already tracked doesn't mean retyping name/category/location/unit.
  // Quantity, purchase date, and expiration are left for the user since those
  // typically differ on a new purchase.
  function fillFormFromItem(item) {
    document.getElementById('f-name').value = item.name;
    document.getElementById('f-category').value = item.category;
    document.getElementById('f-location-select').value = item.location;
    document.getElementById('f-location-new').classList.add('hidden');
    document.getElementById('f-tag-select').value = item.tag || '';
    document.getElementById('f-tag-new').classList.add('hidden');
    document.getElementById('f-unit').value = item.unit;
    document.getElementById('f-quantity').value = item.quantity > 0 ? item.quantity : 1;
    document.getElementById('f-purchase').value = new Date().toISOString().slice(0, 10);
    document.getElementById('f-expiration').value = '';
    document.getElementById('f-notes').value = '';
    document.querySelector('.add-form').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('f-expiration').focus();
  }

  // Dictation quirks to normalize before parsing: iOS/Android speech-to-text
  // (and plenty of people typing manually) write quantities as words rather
  // than digits, and spell units out in full rather than abbreviating them.
  var NUMBER_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, half: 0.5, quarter: 0.25, dozen: 12,
  };
  var UNIT_WORDS = {
    ounce: 'oz', ounces: 'oz',
    pound: 'lb', pounds: 'lb', lbs: 'lb',
    gallon: 'gal', gallons: 'gal',
    quart: 'qt', quarts: 'qt',
    pint: 'pt', pints: 'pt',
    liter: 'L', liters: 'L', litre: 'L', litres: 'L',
    milliliter: 'mL', milliliters: 'mL',
    gram: 'g', grams: 'g',
    kilogram: 'kg', kilograms: 'kg',
  };

  // Replaces a leading number word ("two" -> "2") and normalizes a trailing
  // unit word ("ounces" -> "oz") so the existing digit+unit regex below
  // still does the actual splitting - this only rewrites the words it knows
  // about and leaves anything else untouched.
  function normalizeQuickAddSegment(seg) {
    var words = seg.trim().split(/\s+/);
    if (words.length && NUMBER_WORDS.hasOwnProperty(words[0].toLowerCase())) {
      words[0] = String(NUMBER_WORDS[words[0].toLowerCase()]);
    }
    var lastWord = words[words.length - 1].toLowerCase();
    if (UNIT_WORDS.hasOwnProperty(lastWord)) {
      words[words.length - 1] = UNIT_WORDS[lastWord];
    }
    return words.join(' ');
  }

  // Naive heuristic parser for the quick-add box. Dictation itself needs no
  // app code - the phone keyboard's mic button dictates into any text field;
  // this just turns the resulting freeform line into a best-guess set of
  // form fields. Deliberately does NOT submit anything itself - it only
  // pre-fills the existing detailed form for the user to review/adjust,
  // since a naive comma/keyword split is fragile on odd phrasing.
  function parseQuickAdd(text) {
    var segments = text.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var result = { name: '', quantity: null, unit: '', location: '', tag: '', notes: '' };
    if (!segments.length) return result;
    result.name = segments[0];

    var locations = Array.prototype.map.call(document.querySelectorAll('#f-location-select option'), function (o) { return o.value; })
      .filter(function (v) { return v && v !== '__new__'; });
    var tags = Array.prototype.map.call(document.querySelectorAll('#f-tag-select option'), function (o) { return o.value; })
      .filter(function (v) { return v && v !== '__new__'; });

    var leftover = [];
    for (var i = 1; i < segments.length; i++) {
      var seg = normalizeQuickAddSegment(segments[i]);
      var qtyMatch = seg.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
      var matchedLocation = locations.filter(function (loc) { return loc.toLowerCase() === seg.toLowerCase(); })[0];
      var matchedTag = tags.filter(function (t) { return t.toLowerCase() === seg.toLowerCase(); })[0];

      if (qtyMatch && result.quantity === null) {
        result.quantity = parseFloat(qtyMatch[1]);
        result.unit = qtyMatch[2].trim();
      } else if (matchedLocation && !result.location) {
        result.location = matchedLocation;
      } else if (matchedTag && !result.tag) {
        result.tag = matchedTag;
      } else {
        leftover.push(seg);
      }
    }
    result.notes = leftover.join(', ');
    return result;
  }

  // Pre-fills the purchase form from a parsed quick-add line and scrolls to
  // it for review - mirrors fillFormFromItem's "pre-fill, don't submit"
  // behavior, but only touches fields the parser actually found something
  // for, leaving the rest (category, dates, etc.) as the user last left them.
  function fillFormFromQuickAdd(parsed) {
    document.getElementById('f-name').value = parsed.name;
    if (parsed.quantity !== null) document.getElementById('f-quantity').value = parsed.quantity;
    if (parsed.unit) document.getElementById('f-unit').value = parsed.unit;
    if (parsed.location) {
      document.getElementById('f-location-select').value = parsed.location;
      document.getElementById('f-location-new').classList.add('hidden');
    }
    if (parsed.tag) {
      document.getElementById('f-tag-select').value = parsed.tag;
      document.getElementById('f-tag-new').classList.add('hidden');
    }
    if (parsed.notes) document.getElementById('f-notes').value = parsed.notes;
    document.getElementById('f-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('f-name').focus();
  }

  // Replaces the actions cell with an inline location <select> (a real
  // dropdown, unlike window.prompt() which is plain text only and can't
  // render one) plus a quantity input and Save/Cancel. Cancel just calls
  // refresh() to redraw the row normally rather than trying to restore the
  // original buttons by hand.
  function startInlineLocationEdit(item, actionsTd) {
    actionsTd.innerHTML = '';

    var select = document.createElement('select');
    select.disabled = true;
    var loadingOpt = document.createElement('option');
    loadingOpt.textContent = 'Loading locations...';
    select.appendChild(loadingOpt);

    var qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.step = 'any';
    qtyInput.value = item.quantity;
    qtyInput.className = 'inline-edit-qty';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'small';
    saveBtn.addEventListener('click', function () {
      var quantity = parseFloat(qtyInput.value);
      if (!(quantity >= 0)) {
        alert('Enter a number of zero or more.');
        return;
      }
      apiFetch('/items/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify({ location: select.value, quantity: quantity }),
      })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'small';
    cancelBtn.addEventListener('click', refresh);

    actionsTd.appendChild(select);
    actionsTd.appendChild(qtyInput);
    actionsTd.appendChild(saveBtn);
    actionsTd.appendChild(cancelBtn);

    apiFetch('/locations').then(function (locations) {
      select.innerHTML = '';
      locations.forEach(function (loc) {
        var opt = document.createElement('option');
        opt.value = loc;
        opt.textContent = loc;
        select.appendChild(opt);
      });
      select.value = item.location;
      select.disabled = false;
    }).catch(function (err) { alert(err.message); });
  }

  var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  // Returns a partial-update body of just date fields, or null if cancelled.
  // Kept separate from promptEdits so a pure date correction (fixing a wrong
  // expiration date) sends a PATCH containing only date fields - the server
  // uses that to leave it out of consumption-pattern tracking.
  function promptDates(item) {
    var purchaseInput = window.prompt(
      'Purchase date for "' + item.name + '" (YYYY-MM-DD, blank for none):',
      item.purchase_date || ''
    );
    if (purchaseInput === null) return null;
    if (purchaseInput !== '' && !DATE_PATTERN.test(purchaseInput)) {
      alert('Enter a date as YYYY-MM-DD, or leave blank.');
      return null;
    }

    var expirationInput = window.prompt(
      'Expiration date for "' + item.name + '" (YYYY-MM-DD, blank for none):',
      item.expiration_date || ''
    );
    if (expirationInput === null) return null;
    if (expirationInput !== '' && !DATE_PATTERN.test(expirationInput)) {
      alert('Enter a date as YYYY-MM-DD, or leave blank.');
      return null;
    }

    return { purchase_date: purchaseInput || null, expiration_date: expirationInput || null };
  }

  // Builds a vertical fill-level meter: a normal horizontal <input
  // type="range"> rotated with CSS (not the vendor-specific "orient" or
  // "-webkit-appearance: slider-vertical" APIs, which only work in some
  // browsers) so dragging works anywhere plain CSS transforms do. Updates a
  // percent label live while dragging (no network calls); only PATCHes on
  // release, so a slow connection isn't hit on every pixel of drag.
  function buildFillMeter(item) {
    var wrap = document.createElement('div');
    wrap.className = 'fill-meter';

    var track = document.createElement('div');
    track.className = 'fill-meter-track';

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = item.fill_percent != null ? item.fill_percent : 100;

    var label = document.createElement('span');
    label.className = 'fill-label';
    label.textContent = slider.value + '%';

    slider.addEventListener('input', function () {
      label.textContent = slider.value + '%';
    });
    slider.addEventListener('change', function () {
      apiFetch('/items/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify({ fill_percent: parseFloat(slider.value) }),
      })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    });

    track.appendChild(slider);
    wrap.appendChild(track);
    wrap.appendChild(label);
    return wrap;
  }

  function rowClass(item) {
    if (item.status !== 'active') return item.status;
    var d = daysUntil(item.expiration_date);
    if (d === null) return '';
    if (d < 0) return 'expired';
    if (d <= 3) return 'expiring-soon';
    return '';
  }

  function renderItems(items) {
    var body = document.getElementById('itemsBody');
    body.innerHTML = '';
    items.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.className = rowClass(item);

      function cell(label, text) {
        var td = document.createElement('td');
        td.setAttribute('data-label', label);
        td.textContent = text || '';
        tr.appendChild(td);
      }

      var nameTd = document.createElement('td');
      nameTd.setAttribute('data-label', 'Name');
      nameTd.textContent = item.name;
      if (item.low_stock) {
        var badge = document.createElement('span');
        badge.className = 'low-stock-badge';
        badge.textContent = 'Low stock';
        nameTd.appendChild(document.createTextNode(' '));
        nameTd.appendChild(badge);
      }
      tr.appendChild(nameTd);

      cell('Category', item.category);
      cell('Location', item.location);
      cell('Tag', item.tag);

      var qtyTd = document.createElement('td');
      qtyTd.setAttribute('data-label', 'Qty');
      if (item.tracking_mode === 'fill_level') {
        qtyTd.appendChild(buildFillMeter(item));
      } else {
        qtyTd.textContent = item.quantity + ' ' + (item.unit || '');
      }
      tr.appendChild(qtyTd);

      cell('Purchased', item.purchase_date);
      cell('Expires', item.expiration_date);
      cell('Status', item.status);

      var actionsTd = document.createElement('td');
      actionsTd.setAttribute('data-label', 'Actions');
      if (item.status === 'active') {
        var throwBtn = document.createElement('button');
        throwBtn.textContent = 'Throw out';
        throwBtn.className = 'small';
        throwBtn.addEventListener('click', function () {
          var body = promptQuantity(item, 'thrown out');
          if (body === null) return;
          apiFetch('/items/' + item.id + '/throw-out', { method: 'POST', body: JSON.stringify(body) })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
        var consumeBtn = document.createElement('button');
        consumeBtn.textContent = 'Consumed';
        consumeBtn.className = 'small';
        consumeBtn.addEventListener('click', function () {
          var body = promptQuantity(item, 'consumed');
          if (body === null) return;
          apiFetch('/items/' + item.id + '/consume', { method: 'POST', body: JSON.stringify(body) })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
        actionsTd.appendChild(throwBtn);
        actionsTd.appendChild(consumeBtn);
      }
      if (item.prev_status) {
        var undoBtn = document.createElement('button');
        undoBtn.textContent = 'Undo';
        undoBtn.className = 'small';
        undoBtn.addEventListener('click', function () {
          apiFetch('/items/' + item.id + '/undo', { method: 'POST' })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
        actionsTd.appendChild(undoBtn);
      }
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.className = 'small';
      editBtn.addEventListener('click', function () {
        startInlineLocationEdit(item, actionsTd);
      });
      actionsTd.appendChild(editBtn);

      var editDatesBtn = document.createElement('button');
      editDatesBtn.textContent = 'Edit dates';
      editDatesBtn.className = 'small';
      editDatesBtn.addEventListener('click', function () {
        var updates = promptDates(item);
        if (updates === null) return;
        apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify(updates) })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
      actionsTd.appendChild(editDatesBtn);

      var modeBtn = document.createElement('button');
      modeBtn.className = 'small';
      if (item.tracking_mode === 'fill_level') {
        modeBtn.textContent = 'Track by count';
        modeBtn.addEventListener('click', function () {
          apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify({ tracking_mode: 'count' }) })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
      } else {
        modeBtn.textContent = 'Track by fill level';
        modeBtn.addEventListener('click', function () {
          var input = window.prompt('Roughly how full is "' + item.name + '" right now? (0-100%)', '100');
          if (input === null) return;
          var pct = parseFloat(input);
          if (!(pct >= 0 && pct <= 100)) {
            alert('Enter a number between 0 and 100.');
            return;
          }
          apiFetch('/items/' + item.id, {
            method: 'PATCH',
            body: JSON.stringify({ tracking_mode: 'fill_level', fill_percent: pct }),
          })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
      }
      actionsTd.appendChild(modeBtn);

      var buyAgainBtn = document.createElement('button');
      buyAgainBtn.textContent = 'Buy again';
      buyAgainBtn.className = 'small';
      buyAgainBtn.addEventListener('click', function () {
        fillFormFromItem(item);
      });
      actionsTd.appendChild(buyAgainBtn);

      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'small';
      delBtn.addEventListener('click', function () {
        if (confirm('Delete "' + item.name + '"?')) {
          apiFetch('/items/' + item.id, { method: 'DELETE' }).then(refresh);
        }
      });
      actionsTd.appendChild(delBtn);
      tr.appendChild(actionsTd);

      body.appendChild(tr);
    });
  }

  function renderStats(stats) {
    document.getElementById('stats').textContent =
      stats.active + ' active · ' + stats.expiringSoon + ' expiring soon · ' + stats.expired + ' expired';
  }

  function renderLocations(locations) {
    var filterSelect = document.getElementById('filterLocation');
    var currentFilterVal = filterSelect.value;
    filterSelect.innerHTML = '<option value="">All</option>';
    locations.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = currentFilterVal;

    var formSelect = document.getElementById('f-location-select');
    var currentFormVal = formSelect.value;
    formSelect.innerHTML = '<option value="">Select location...</option>';
    locations.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      formSelect.appendChild(opt);
    });
    var addNewOpt = document.createElement('option');
    addNewOpt.value = '__new__';
    addNewOpt.textContent = '+ Add new location...';
    formSelect.appendChild(addNewOpt);
    formSelect.value = currentFormVal;
  }

  function renderTags(tags) {
    var filterSelect = document.getElementById('filterTag');
    var currentFilterVal = filterSelect.value;
    filterSelect.innerHTML = '<option value="">All</option>';
    tags.forEach(function (tag) {
      var opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = tag;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = currentFilterVal;

    var formSelect = document.getElementById('f-tag-select');
    var currentFormVal = formSelect.value;
    formSelect.innerHTML = '<option value="">Select tag...</option>';
    tags.forEach(function (tag) {
      var opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = tag;
      formSelect.appendChild(opt);
    });
    var addNewOpt = document.createElement('option');
    addNewOpt.value = '__new__';
    addNewOpt.textContent = '+ Add new tag...';
    formSelect.appendChild(addNewOpt);
    formSelect.value = currentFormVal;
  }

  var lastItems = [];

  // Case-insensitive substring match across every field worth searching,
  // then a sort - both operate on the already-fetched item list client-side
  // rather than round-tripping to the server, since the full list is
  // already loaded for the status/location filters.
  function applyFiltersAndRender() {
    var query = document.getElementById('searchBox').value.trim().toLowerCase();
    var filtered = lastItems;
    if (query) {
      filtered = lastItems.filter(function (item) {
        return [item.name, item.location, item.category, item.tag, item.notes, item.unit, item.status]
          .some(function (field) { return field && field.toLowerCase().indexOf(query) !== -1; });
      });
    }

    var sortBy = document.getElementById('sortBy').value;
    if (sortBy === 'recent') {
      filtered = filtered.slice().sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
    } else if (sortBy === 'name') {
      filtered = filtered.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    }

    renderItems(filtered);
  }

  function refresh() {
    var params = new URLSearchParams();
    if (document.getElementById('filterActiveOnly').checked) {
      params.set('status', 'active');
    }
    var loc = document.getElementById('filterLocation').value;
    if (loc) params.set('location', loc);
    var tag = document.getElementById('filterTag').value;
    if (tag) params.set('tag', tag);

    apiFetch('/items?' + params.toString()).then(function (items) {
      lastItems = items;
      applyFiltersAndRender();
    });
    apiFetch('/stats').then(renderStats);
    apiFetch('/locations').then(renderLocations);
    apiFetch('/tags').then(renderTags);
  }

  function currentFormLocation() {
    var select = document.getElementById('f-location-select');
    if (select.value === '__new__') {
      return document.getElementById('f-location-new').value;
    }
    return select.value;
  }

  function currentFormTag() {
    var select = document.getElementById('f-tag-select');
    if (select.value === '__new__') {
      return document.getElementById('f-tag-new').value;
    }
    return select.value;
  }

  document.getElementById('f-location-select').addEventListener('change', function () {
    var newInput = document.getElementById('f-location-new');
    if (this.value === '__new__') {
      newInput.classList.remove('hidden');
      newInput.focus();
    } else {
      newInput.classList.add('hidden');
      newInput.value = '';
    }
  });

  document.getElementById('f-tag-select').addEventListener('change', function () {
    var newInput = document.getElementById('f-tag-new');
    if (this.value === '__new__') {
      newInput.classList.remove('hidden');
      newInput.focus();
    } else {
      newInput.classList.add('hidden');
      newInput.value = '';
    }
  });

  document.getElementById('itemForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var payload = {
      name: document.getElementById('f-name').value,
      category: document.getElementById('f-category').value,
      location: currentFormLocation(),
      tag: currentFormTag(),
      quantity: parseFloat(document.getElementById('f-quantity').value) || 1,
      unit: document.getElementById('f-unit').value,
      purchase_date: document.getElementById('f-purchase').value || null,
      expiration_date: document.getElementById('f-expiration').value || null,
      notes: document.getElementById('f-notes').value,
    };
    apiFetch('/items', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
      e.target.reset();
      document.getElementById('f-category').value = 'perishable';
      document.getElementById('f-location-new').classList.add('hidden');
      document.getElementById('f-tag-new').classList.add('hidden');
      setDefaultPurchaseDate();
      refresh();
    }).catch(function (err) {
      alert(err.message);
    });
  });

  document.getElementById('quickAddForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('quickAddInput');
    var text = input.value.trim();
    if (!text) return;
    fillFormFromQuickAdd(parseQuickAdd(text));
    input.value = '';
  });

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('filterActiveOnly').addEventListener('change', refresh);
  document.getElementById('filterLocation').addEventListener('change', refresh);
  document.getElementById('filterTag').addEventListener('change', refresh);
  document.getElementById('searchBox').addEventListener('input', applyFiltersAndRender);
  document.getElementById('sortBy').addEventListener('change', applyFiltersAndRender);

  // Defaults the purchase date to today, since that's true for the large
  // majority of purchases logged - saves a tap/dictation on every add, and
  // is still trivially overridable for a backdated entry.
  function setDefaultPurchaseDate() {
    document.getElementById('f-purchase').value = new Date().toISOString().slice(0, 10);
  }

  setDefaultPurchaseDate();
  loadWhoAmI();
  refresh();
})();
