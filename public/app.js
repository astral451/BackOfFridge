(function () {
  var KEY_STORAGE = 'backoffridge_api_key';

  function getKey() {
    return localStorage.getItem(KEY_STORAGE) || '';
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, {
      'Content-Type': 'application/json',
      'x-api-key': getKey(),
    });
    return fetch('/api' + path, opts).then(function (res) {
      if (res.status === 401) {
        showKeyGate();
        throw new Error('unauthorized');
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

  function showKeyGate() {
    document.getElementById('keyGate').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }

  function hideKeyGate() {
    document.getElementById('keyGate').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  }

  document.getElementById('keySave').addEventListener('click', function () {
    var val = document.getElementById('keyInput').value.trim();
    localStorage.setItem(KEY_STORAGE, val);
    hideKeyGate();
    init();
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
    document.getElementById('f-unit').value = item.unit;
    document.getElementById('f-quantity').value = item.quantity > 0 ? item.quantity : 1;
    document.getElementById('f-purchase').value = new Date().toISOString().slice(0, 10);
    document.getElementById('f-expiration').value = '';
    document.getElementById('f-notes').value = '';
    document.querySelector('.add-form').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('f-expiration').focus();
  }

  // Returns a partial-update body for PATCH /items/:id, or null if the user
  // cancelled. Asks for location and quantity — the two fields people need to
  // correct most often (moved it, or the count was wrong/changed).
  function promptEdits(item) {
    var location = window.prompt('Location for "' + item.name + '":', item.location || '');
    if (location === null) return null;

    var qtyInput = window.prompt('Quantity on hand for "' + item.name + '":', item.quantity);
    if (qtyInput === null) return null;
    var quantity = parseFloat(qtyInput);
    if (!(quantity >= 0)) {
      alert('Enter a number of zero or more.');
      return null;
    }

    return { location: location, quantity: quantity };
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
        var updates = promptEdits(item);
        if (updates === null) return;
        apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify(updates) })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
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

  function refresh() {
    var params = new URLSearchParams();
    if (document.getElementById('filterActiveOnly').checked) {
      params.set('status', 'active');
    }
    var loc = document.getElementById('filterLocation').value;
    if (loc) params.set('location', loc);

    apiFetch('/items?' + params.toString()).then(renderItems);
    apiFetch('/stats').then(renderStats);
    apiFetch('/locations').then(renderLocations);
  }

  function currentFormLocation() {
    var select = document.getElementById('f-location-select');
    if (select.value === '__new__') {
      return document.getElementById('f-location-new').value;
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

  document.getElementById('itemForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var payload = {
      name: document.getElementById('f-name').value,
      category: document.getElementById('f-category').value,
      location: currentFormLocation(),
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
      refresh();
    }).catch(function (err) {
      alert(err.message);
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('filterActiveOnly').addEventListener('change', refresh);
  document.getElementById('filterLocation').addEventListener('change', refresh);

  function init() {
    refresh();
  }

  if (getKey()) {
    hideKeyGate();
    init();
  } else {
    showKeyGate();
  }
})();
