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
    refresh();
  });

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(dateStr + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  }

  function expiresText(item) {
    var d = daysUntil(item.expiration_date);
    if (d === null) return '—';
    if (d < 0) return Math.abs(d) + (Math.abs(d) === 1 ? ' day ago' : ' days ago');
    if (d === 0) return 'today';
    return 'in ' + d + (d === 1 ? ' day' : ' days');
  }

  function rowClass(item) {
    var d = daysUntil(item.expiration_date);
    if (d === null) return '';
    if (d < 0) return 'expired';
    if (d <= 3) return 'expiring-soon';
    return '';
  }

  function countText(item) {
    if (item.tracking_mode === 'fill_level') {
      return (item.fill_percent != null ? item.fill_percent : '?') + '%';
    }
    return item.quantity + (item.unit ? ' ' + item.unit : '');
  }

  function renderItems(items) {
    var body = document.getElementById('glanceBody');
    body.innerHTML = '';
    items.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.className = rowClass(item);

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

      var expiresTd = document.createElement('td');
      expiresTd.setAttribute('data-label', 'Expires');
      expiresTd.textContent = expiresText(item);
      tr.appendChild(expiresTd);

      var countTd = document.createElement('td');
      countTd.setAttribute('data-label', 'Count');
      countTd.textContent = countText(item);
      tr.appendChild(countTd);

      body.appendChild(tr);
    });
  }

  function refresh() {
    apiFetch('/items?status=active').then(renderItems).catch(function (err) {
      alert(err.message);
    });
  }

  if (getKey()) {
    hideKeyGate();
    refresh();
  } else {
    showKeyGate();
  }
})();
