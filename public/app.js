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

      cell('Name', item.name);
      cell('Category', item.category);
      cell('Location', item.location);
      cell('Qty', item.quantity + ' ' + (item.unit || ''));
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
          apiFetch('/items/' + item.id + '/throw-out', { method: 'POST' }).then(refresh);
        });
        var consumeBtn = document.createElement('button');
        consumeBtn.textContent = 'Consumed';
        consumeBtn.className = 'small';
        consumeBtn.addEventListener('click', function () {
          apiFetch('/items/' + item.id + '/consume', { method: 'POST' }).then(refresh);
        });
        actionsTd.appendChild(throwBtn);
        actionsTd.appendChild(consumeBtn);
      }
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
    var listEl = document.getElementById('locationList');
    var selectEl = document.getElementById('filterLocation');
    listEl.innerHTML = '';
    var currentVal = selectEl.value;
    selectEl.innerHTML = '<option value="">All</option>';
    locations.forEach(function (loc) {
      var opt1 = document.createElement('option');
      opt1.value = loc;
      listEl.appendChild(opt1);

      var opt2 = document.createElement('option');
      opt2.value = loc;
      opt2.textContent = loc;
      selectEl.appendChild(opt2);
    });
    selectEl.value = currentVal;
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

  document.getElementById('itemForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var payload = {
      name: document.getElementById('f-name').value,
      category: document.getElementById('f-category').value,
      location: document.getElementById('f-location').value,
      quantity: parseFloat(document.getElementById('f-quantity').value) || 1,
      unit: document.getElementById('f-unit').value,
      purchase_date: document.getElementById('f-purchase').value || null,
      expiration_date: document.getElementById('f-expiration').value || null,
      notes: document.getElementById('f-notes').value,
    };
    apiFetch('/items', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
      e.target.reset();
      document.getElementById('f-category').value = 'perishable';
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
