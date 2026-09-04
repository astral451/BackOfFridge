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

  // Quick +/- for the common "used/added one" case, with no prompt - the
  // one deliberate exception to this page's otherwise read-only design.
  // Count-tracked items step by 1; fill-level items step by 10 percentage
  // points, and a - at or below 10% fully consumes the item instead of
  // going negative (mirrors reduceQuantity's floor-at-zero on the server).
  function quickAdjust(item, delta) {
    if (item.tracking_mode === 'fill_level') {
      var current = item.fill_percent != null ? item.fill_percent : 100;
      if (delta < 0 && current <= 10) {
        apiFetch('/items/' + item.id + '/consume', { method: 'POST', body: JSON.stringify({}) })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
        return;
      }
      var newPct = Math.max(0, Math.min(100, current + delta * 10));
      apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify({ fill_percent: newPct }) })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    } else if (delta < 0) {
      apiFetch('/items/' + item.id + '/consume', {
        method: 'POST',
        body: JSON.stringify({ quantity: Math.min(1, item.quantity) }),
      })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    } else {
      apiFetch('/items/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify({ quantity: item.quantity + 1 }),
      })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    }
  }

  function buildQtyAdjustButtons(item) {
    var wrap = document.createElement('div');
    wrap.className = 'qty-adjust';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.textContent = '−';
    minusBtn.className = 'small';
    minusBtn.title = item.tracking_mode === 'fill_level' ? '-10%' : '-1';
    minusBtn.addEventListener('click', function () { quickAdjust(item, -1); });

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.textContent = '+';
    plusBtn.className = 'small';
    plusBtn.title = item.tracking_mode === 'fill_level' ? '+10%' : '+1';
    plusBtn.addEventListener('click', function () { quickAdjust(item, 1); });

    wrap.appendChild(minusBtn);
    wrap.appendChild(plusBtn);
    return wrap;
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
      var countSpan = document.createElement('span');
      countSpan.textContent = countText(item);
      countTd.appendChild(countSpan);
      countTd.appendChild(buildQtyAdjustButtons(item));
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
