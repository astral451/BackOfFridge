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

      var locationTd = document.createElement('td');
      locationTd.setAttribute('data-label', 'Location');
      locationTd.textContent = item.location;
      tr.appendChild(locationTd);

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

  function renderLocations(locations) {
    var selectEl = document.getElementById('filterLocation');
    var currentVal = selectEl.value;
    selectEl.innerHTML = '<option value="">All</option>';
    locations.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      selectEl.appendChild(opt);
    });
    selectEl.value = currentVal;
  }

  function refresh() {
    var params = new URLSearchParams({ status: 'active' });
    var loc = document.getElementById('filterLocation').value;
    if (loc) params.set('location', loc);

    apiFetch('/items?' + params.toString()).then(renderItems).catch(function (err) {
      alert(err.message);
    });
    apiFetch('/locations').then(renderLocations).catch(function (err) {
      alert(err.message);
    });
  }

  document.getElementById('filterLocation').addEventListener('change', refresh);

  loadWhoAmI();
  refresh();
})();
