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
    if (d === null) return null;
    if (d < 0) return Math.abs(d) + (Math.abs(d) === 1 ? ' day ago' : ' days ago');
    if (d === 0) return 'expires today';
    return 'in ' + d + (d === 1 ? ' day' : ' days');
  }

  function rowClass(item) {
    var d = daysUntil(item.expiration_date);
    if (d === null) return '';
    if (d < 0) return 'expired';
    if (d <= 3) return 'expiring-soon';
    return '';
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

  // Same fixed-width stepper as the main inventory page - fill-level items
  // get a percentage track stacked below the button row instead of beside
  // it, so every row's buttons line up in the same column.
  function buildStepper(item) {
    var wrap = document.createElement('div');
    wrap.className = 'stepper-wrap';

    var stepper = document.createElement('div');
    stepper.className = 'stepper';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.textContent = '−';
    minusBtn.title = item.tracking_mode === 'fill_level' ? '-10%' : '-1';
    minusBtn.addEventListener('click', function () { quickAdjust(item, -1); });

    var qtyVal = document.createElement('span');
    qtyVal.className = 'qty-val';
    qtyVal.textContent = item.tracking_mode === 'fill_level'
      ? (item.fill_percent != null ? item.fill_percent : 100) + '%'
      : item.quantity + (item.unit ? ' ' + item.unit : '');

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.textContent = '+';
    plusBtn.title = item.tracking_mode === 'fill_level' ? '+10%' : '+1';
    plusBtn.addEventListener('click', function () { quickAdjust(item, 1); });

    stepper.appendChild(minusBtn);
    stepper.appendChild(qtyVal);
    stepper.appendChild(plusBtn);
    wrap.appendChild(stepper);

    if (item.tracking_mode === 'fill_level') {
      var track = document.createElement('div');
      track.className = 'fill-track';
      var bar = document.createElement('div');
      bar.className = 'fill-bar';
      bar.style.width = (item.fill_percent != null ? item.fill_percent : 100) + '%';
      track.appendChild(bar);
      wrap.appendChild(track);
    }

    return wrap;
  }

  function buildItemRow(item) {
    var row = document.createElement('div');
    row.className = 'item-row ' + rowClass(item);

    var main = document.createElement('div');
    main.className = 'row-main';

    var nameLine = document.createElement('div');
    nameLine.className = 'row-name';
    var nameSpan = document.createElement('span');
    nameSpan.textContent = item.name;
    nameLine.appendChild(nameSpan);
    if (item.low_stock) {
      var lowBadge = document.createElement('span');
      lowBadge.className = 'badge low';
      lowBadge.textContent = 'Low stock';
      nameLine.appendChild(lowBadge);
    }
    if (rowClass(item) === 'expiring-soon') {
      var soonBadge = document.createElement('span');
      soonBadge.className = 'badge soon';
      soonBadge.textContent = 'Expiring';
      nameLine.appendChild(soonBadge);
    }
    main.appendChild(nameLine);

    var meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = expiresText(item) || '—';
    main.appendChild(meta);

    row.appendChild(main);
    row.appendChild(buildStepper(item));
    return row;
  }

  var collapsedGroups = {};

  function renderItems(items) {
    var container = document.getElementById('itemGroups');
    container.innerHTML = '';

    var byLoc = {};
    items.forEach(function (item) {
      var key = item.location || '(no location)';
      (byLoc[key] = byLoc[key] || []).push(item);
    });

    Object.keys(byLoc).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (loc) {
      var group = document.createElement('div');
      group.className = 'group';

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'group-head' + (collapsedGroups[loc] ? ' collapsed' : '');

      var labelSpan = document.createElement('span');
      labelSpan.textContent = loc.toUpperCase() + ' (' + byLoc[loc].length + ')';
      var chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '▾';
      head.appendChild(labelSpan);
      head.appendChild(chev);

      var rows = document.createElement('div');
      rows.className = 'rows';
      rows.hidden = !!collapsedGroups[loc];

      head.addEventListener('click', function () {
        collapsedGroups[loc] = !collapsedGroups[loc];
        head.classList.toggle('collapsed', collapsedGroups[loc]);
        rows.hidden = collapsedGroups[loc];
      });

      byLoc[loc].forEach(function (item) {
        rows.appendChild(buildItemRow(item));
      });

      group.appendChild(head);
      group.appendChild(rows);
      container.appendChild(group);
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
