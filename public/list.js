(function () {
  function redirectToLogin() {
    window.location.href = 'login.html?next=' + encodeURIComponent(window.location.pathname.split('/').pop());
  }

  // Pages here show household data. A pending account goes to the waiting
  // page instead, and the admin account (no household) to the admin page.
  // Takes either /api/auth/me's user or a 403 body's { reason }.
  function redirectIfNoHousehold(info) {
    if (info.status === 'pending' || info.reason === 'pending') {
      window.location.href = 'pending.html';
      return true;
    }
    if ((info.isAdmin && !info.household) || info.reason === 'admin') {
      window.location.href = 'admin.html';
      return true;
    }
    return false;
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
          // Leaving the page: settle nothing, so no error alert flashes first.
          if (res.status === 403 && redirectIfNoHousehold(body)) return new Promise(function () {});
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
      if (!me || redirectIfNoHousehold(me)) return;
      document.getElementById('whoami').textContent = 'Signed in as ' + me.username;
    });
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(redirectToLogin);
  });

  // --- The shopping list (features.md, "Trips: shared shopping trips and
  // the shopping list"). Shared by the household: one list, kept on the
  // server as a 'planned' trip. "Start shopping" makes it the current
  // trip, and the trip page in the entry card takes over from there.

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var SOURCE_LABELS = { used: 'used up', low_stock: 'low stock', expiring: 'expiring', manual: '' };
  var current = null; // the last GET /trips/list answer

  function todayLocal() {
    var t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }
  function daysFromToday(dt) {
    var d = new Date(dt);
    d.setHours(0, 0, 0, 0);
    return Math.round((d - todayLocal()) / 86400000);
  }
  function shortDate(dt) {
    return WEEKDAYS[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate();
  }
  // The server's UTC "YYYY-MM-DD HH:MM:SS".
  function serverTime(s) { return new Date(s.replace(' ', 'T') + 'Z'); }
  function agoText(s) {
    var n = -daysFromToday(serverTime(s));
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago';
  }
  function qtyText(q, unit) {
    if (q == null) return unit || '';
    return '×' + q + (unit ? ' ' + unit : '');
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function rowText(button, name, detail) {
    button.appendChild(el('span', 'trip-name', name));
    if (detail) button.appendChild(el('span', 'trip-detail', detail));
  }

  function renderList(list) {
    var rows = list ? list.entries : [];
    var ul = document.getElementById('listRows');
    ul.textContent = '';
    document.getElementById('listEmpty').hidden = rows.length > 0;
    document.getElementById('onListCount').textContent = rows.length ? rows.length + (rows.length === 1 ? ' thing' : ' things') : '';
    document.getElementById('startBtn').disabled = !rows.length;
    var people = {};
    rows.forEach(function (r) { if (r.added_by) people[r.added_by] = true; });
    var showWho = Object.keys(people).length > 1;
    rows.forEach(function (r) {
      var li = el('li', 'list-row');
      // Tapping the row sets how many (optional; useful for a recipe).
      var main = el('button', 'trip-row');
      main.type = 'button';
      var detail = [qtyText(r.quantity, r.unit), SOURCE_LABELS[r.source] || '', showWho ? r.added_by : '']
        .filter(Boolean).join(' · ');
      rowText(main, r.name, detail || 'tap to set how many');
      main.addEventListener('click', function () { setQuantity(r); });
      var remove = el('button', 'row-icon-btn', '✕');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Take ' + r.name + ' off the list');
      remove.addEventListener('click', function () {
        apiFetch('/trips/entries/' + r.id, { method: 'DELETE' }).then(load).catch(function (err) { alert(err.message); });
      });
      li.appendChild(main);
      li.appendChild(remove);
      ul.appendChild(li);
    });
  }

  function setQuantity(r) {
    var input = window.prompt('How many "' + r.name + '"? (Leave empty for "some".)', r.quantity == null ? '' : r.quantity + (r.unit ? ' ' + r.unit : ''));
    if (input === null) return;
    var m = input.trim().match(/^(\d+(?:\.\d+)?)?\s*(.*)$/);
    var body = { quantity: m && m[1] ? parseFloat(m[1]) : null, unit: m ? m[2].trim() : '' };
    apiFetch('/trips/entries/' + r.id, { method: 'PATCH', body: JSON.stringify(body) }).then(load)
      .catch(function (err) { alert(err.message); });
  }

  function suggestionDetail(kind, s) {
    if (kind === 'used') return (s.how === 'thrown_out' ? 'thrown out ' : 'used up ') + agoText(s.at);
    if (kind === 'low_stock') {
      return s.tracking_mode === 'fill_level' && s.fill_percent != null
        ? s.fill_percent + '% left' + (s.quantity > 1 ? ' + ' + (s.quantity - 1) + ' full' : '')
        : s.quantity + (s.unit ? ' ' + s.unit : '') + ' left';
    }
    var dt = new Date(s.expiration_date + 'T00:00:00');
    var n = daysFromToday(dt);
    return n < 0 ? 'expired ' + shortDate(dt) : n === 0 ? 'expires today' : n === 1 ? 'expires tomorrow' : 'expires in ' + n + ' days';
  }

  var GROUPS = [
    { key: 'used', title: 'Used up lately' },
    { key: 'low_stock', title: 'Low stock' },
    { key: 'expiring', title: 'Expiring soon' },
  ];

  function renderSuggestions(sugg) {
    var box = document.getElementById('suggestGroups');
    box.textContent = '';
    var any = false;
    GROUPS.forEach(function (g) {
      var items = sugg[g.key] || [];
      if (!items.length) return;
      any = true;
      box.appendChild(el('h4', 'suggest-head', g.title));
      var ul = el('ul', 'plain-rows');
      items.forEach(function (s) {
        var li = el('li', 'list-row');
        var info = el('div', 'trip-row static');
        rowText(info, s.name, suggestionDetail(g.key, s));
        var add = el('button', 'row-add-btn', 'Add');
        add.type = 'button';
        add.setAttribute('aria-label', 'Add ' + s.name + ' to the list');
        add.addEventListener('click', function () {
          add.disabled = true;
          addEntry({ name: s.name, barcode: s.barcode, source: g.key });
        });
        li.appendChild(info);
        li.appendChild(add);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
    document.getElementById('suggestEmpty').hidden = any;
  }

  function addEntry(body) {
    return apiFetch('/trips/list/entries', { method: 'POST', body: JSON.stringify(body) }).then(load)
      .catch(function (err) { alert(err.message); load(); });
  }

  function load() {
    return apiFetch('/trips/list').then(function (r) {
      current = r;
      renderList(r.list);
      renderSuggestions(r.suggestions);
    });
  }

  document.getElementById('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('addName').value.trim();
    if (!name) return;
    var qtyRaw = document.getElementById('addQty').value.trim();
    var m = qtyRaw.match(/^(\d+(?:\.\d+)?)?\s*(.*)$/);
    var body = { name: name, source: 'manual' };
    if (m && m[1]) body.quantity = parseFloat(m[1]);
    if (m && m[2]) body.unit = m[2].trim();
    addEntry(body).then(function () {
      document.getElementById('addName').value = '';
      document.getElementById('addQty').value = '';
      document.getElementById('addName').focus();
    });
  });

  // Start shopping: the list becomes the household's current trip; the
  // entry card's trip page shows what's still to get.
  document.getElementById('startBtn').addEventListener('click', function () {
    if (!current || !current.list) return;
    var btn = this;
    btn.disabled = true;
    apiFetch('/trips/' + encodeURIComponent(current.list.id) + '/start', { method: 'POST' }).then(function () {
      window.location.href = 'index.html#trip';
    }).catch(function (err) {
      btn.disabled = false;
      alert(err.message);
    });
  });

  // Someone else may be adding to the list too.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load();
  });

  loadWhoAmI();
  load();
})();
