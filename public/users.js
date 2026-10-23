(function () {
  function redirectToLogin() {
    window.location.href = 'login.html?next=users.html';
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

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, onClick) {
    var b = el('button', 'small', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function fail(err) { alert(err.message); }

  // "Move to [choose a household… ▾]": nothing preselected, and the button
  // stays off until a household is picked.
  function householdChooser(label, choices, onChoose) {
    var select = el('select');
    select.setAttribute('aria-label', label);
    var placeholder = el('option', '', 'choose\u2026');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    choices.forEach(function (h) {
      var opt = el('option', '', h.name);
      opt.value = String(h.id);
      select.appendChild(opt);
    });
    var btn = button(label, function () {
      var chosen = choices.filter(function (h) { return String(h.id) === select.value; })[0];
      if (chosen) onChoose(chosen);
    });
    btn.disabled = true;
    btn.title = 'Choose a household first';
    select.addEventListener('change', function () {
      btn.disabled = !select.value;
      btn.title = select.value ? '' : 'Choose a household first';
    });
    return [btn, select];
  }

  var LEFT_NOTE = ' Its invite code is replaced so they can\'t use it to rejoin; everyone else in it stays logged in and unaffected.';

  function post(path, body) {
    return apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) }).then(refresh).catch(fail);
  }

  function describe(u) {
    if (u.isAdmin && !u.householdId) return 'admin · no household';
    if (u.status === 'pending') return 'no household · waiting for approval';
    if (u.status === 'rejected') return 'no household · blocked';
    return u.householdName + (u.isAdmin ? ' · also an admin' : '');
  }

  function controlsFor(u, households) {
    var out = [];
    var inHousehold = u.status === 'active' && u.householdId;

    if (u.isAdmin && !u.householdId) {
      out.push(el('span', 'manage-count', 'managed from the server command line'));
      return out;
    }

    if (inHousehold) {
      var others = households.filter(function (h) { return h.id !== u.householdId; });
      if (others.length) {
        out = out.concat(householdChooser('Move to', others, function (h) {
          if (!confirm('Move ' + u.username + ' from "' + u.householdName + '" to "' + h.name + '"?\n\n' +
            'Items they added stay with "' + u.householdName + '".' + LEFT_NOTE)) return;
          post('/admin/users/' + u.id + '/move', { householdId: h.id });
        }));
      }
      out.push(button('Remove', function () {
        if (!confirm('Remove ' + u.username + ' from "' + u.householdName + '"?\n\n' +
          'They go back to waiting for approval.' + LEFT_NOTE)) return;
        post('/admin/users/' + u.id + '/remove');
      }));
    } else if (u.status === 'pending' && households.length) {
      out = out.concat(householdChooser('Add to', households, function (h) {
        if (!confirm('Add ' + u.username + ' to "' + h.name + '"?')) return;
        post('/admin/users/' + u.id + '/approve', { householdId: h.id });
      }));
    }

    if (u.status === 'rejected') {
      out.push(button('Unblock', function () {
        if (!confirm('Unblock ' + u.username + '? They go back to waiting for approval.')) return;
        post('/admin/users/' + u.id + '/unblock');
      }));
    } else if (!u.isAdmin) {
      out.push(button('Block', function () {
        var msg = 'Block ' + u.username + '? They won\'t be able to log in.';
        if (inHousehold) msg += '\n\nThey leave "' + u.householdName + '".' + LEFT_NOTE;
        if (!confirm(msg)) return;
        post('/admin/users/' + u.id + '/block');
      }));
    }
    return out;
  }

  function render(users, households) {
    var counts = { active: 0, pending: 0, rejected: 0 };
    users.forEach(function (u) { if (!u.isAdmin) counts[u.status] += 1; });
    document.getElementById('userSummary').textContent =
      users.length + ' accounts: ' + counts.active + ' in a household, ' + counts.pending +
      ' waiting for approval, ' + counts.rejected + ' blocked.';

    var list = document.getElementById('usersList');
    list.innerHTML = '';
    users.forEach(function (u) {
      var row = el('div', 'manage-row admin-row user-row' + (u.status === 'rejected' ? ' used' : ''));
      var info = el('div');
      info.appendChild(el('div', '', u.username));
      info.appendChild(el('div', 'manage-count', describe(u) + ' · signed up ' + u.createdAt.slice(0, 10)));
      row.appendChild(info);
      var controls = el('div', 'admin-controls');
      controlsFor(u, households).forEach(function (c) { controls.appendChild(c); });
      row.appendChild(controls);
      list.appendChild(row);
    });
  }

  function refresh() {
    return Promise.all([apiFetch('/admin/users'), apiFetch('/admin/households')])
      .then(function (r) { render(r[0], r[1]); })
      .catch(fail);
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(redirectToLogin);
  });

  fetch('/api/auth/me').then(function (res) {
    if (!res.ok) {
      redirectToLogin();
      return null;
    }
    return res.json();
  }).then(function (me) {
    if (!me) return;
    if (!me.isAdmin) {
      window.location.href = me.status === 'pending' ? 'pending.html' : 'index.html';
      return;
    }
    document.getElementById('whoami').textContent = 'Signed in as ' + me.username;
    refresh();
  });
})();
