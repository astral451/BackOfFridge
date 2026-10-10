(function () {
  function redirectToLogin() {
    window.location.href = 'login.html?next=admin.html';
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

  var households = [];

  // ----- Pending accounts -----

  function renderPending(users) {
    document.getElementById('pendingCount').textContent = users.length ? '(' + users.length + ')' : '';
    var list = document.getElementById('pendingList');
    list.innerHTML = '';
    if (!users.length) {
      list.appendChild(el('p', 'settings-desc', 'Nobody is waiting.'));
      return;
    }
    users.forEach(function (u) {
      var row = el('div', 'manage-row admin-row');
      var info = el('div');
      info.appendChild(el('div', '', u.username));
      info.appendChild(el('div', 'manage-count', 'signed up ' + u.createdAt + ' UTC'));
      row.appendChild(info);

      var controls = el('div', 'admin-controls');
      var select = el('select');
      households.forEach(function (h) {
        var opt = el('option', '', 'Add to ' + h.name);
        opt.value = String(h.id);
        select.appendChild(opt);
      });
      var newOpt = el('option', '', 'New household...');
      newOpt.value = 'new';
      select.appendChild(newOpt);
      var newName = el('input');
      newName.type = 'text';
      newName.placeholder = 'New household name';
      newName.className = households.length ? 'hidden' : '';
      select.addEventListener('change', function () {
        newName.classList.toggle('hidden', select.value !== 'new');
      });
      controls.appendChild(select);
      controls.appendChild(newName);

      controls.appendChild(button('Approve', function () {
        var body = select.value === 'new'
          ? { newHouseholdName: newName.value.trim() }
          : { householdId: Number(select.value) };
        if (select.value === 'new' && !body.newHouseholdName) {
          alert('Name the new household first.');
          return;
        }
        apiFetch('/admin/users/' + u.id + '/approve', { method: 'POST', body: JSON.stringify(body) })
          .then(refresh).catch(fail);
      }));
      controls.appendChild(button('Reject', function () {
        if (!confirm('Reject "' + u.username + '"? They won\'t be able to log in.')) return;
        apiFetch('/admin/users/' + u.id + '/reject', { method: 'POST' }).then(refresh).catch(fail);
      }));
      row.appendChild(controls);
      list.appendChild(row);
    });
  }

  // ----- New-household codes -----

  function renderCodes(codes) {
    var list = document.getElementById('codesList');
    list.innerHTML = '';
    codes.forEach(function (c) {
      var row = el('div', 'manage-row');
      var info = el('div');
      info.appendChild(el('div', 'code-text', c.code));
      var detail = c.usedAt
        ? 'used by ' + (c.usedBy || '?') + ' to start "' + (c.householdName || '?') + '"'
        : 'unused' + (c.note ? ' · for ' + c.note : '');
      if (c.usedAt && c.note) detail += ' · for ' + c.note;
      info.appendChild(el('div', 'manage-count', detail));
      row.appendChild(info);
      if (!c.usedAt) {
        row.appendChild(button('Revoke', function () {
          if (!confirm('Revoke code ' + c.code + '?')) return;
          apiFetch('/admin/codes/' + encodeURIComponent(c.code), { method: 'DELETE' }).then(refresh).catch(fail);
        }));
      } else {
        row.classList.add('used');
      }
      list.appendChild(row);
    });
  }

  document.getElementById('codeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var note = document.getElementById('codeNote');
    apiFetch('/admin/codes', { method: 'POST', body: JSON.stringify({ note: note.value }) })
      .then(function () { note.value = ''; refresh(); })
      .catch(fail);
  });

  // ----- Households -----

  function renderHouseholds(list) {
    var container = document.getElementById('householdsList');
    container.innerHTML = '';
    list.forEach(function (h) {
      var row = el('div', 'manage-row');
      var info = el('div');
      info.appendChild(el('div', '', h.name));
      info.appendChild(el('div', 'manage-count',
        h.memberCount + ' member' + (h.memberCount === 1 ? '' : 's') + ' · ' +
        h.itemCount + ' item' + (h.itemCount === 1 ? '' : 's') + ' · invite code ' + h.inviteCode));
      row.appendChild(info);
      row.appendChild(button('Rename', function () {
        var name = prompt('New name for "' + h.name + '":', h.name);
        if (name === null || !name.trim() || name.trim() === h.name) return;
        apiFetch('/admin/households/' + h.id, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) })
          .then(refresh).catch(fail);
      }));
      container.appendChild(row);
    });
  }

  document.getElementById('householdForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('householdName');
    var name = input.value.trim();
    if (!name) return;
    apiFetch('/admin/households', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function () { input.value = ''; refresh(); })
      .catch(fail);
  });

  function refresh() {
    return apiFetch('/admin/households').then(function (list) {
      households = list;
      renderHouseholds(list);
      return Promise.all([apiFetch('/admin/pending'), apiFetch('/admin/codes')]);
    }).then(function (results) {
      renderPending(results[0]);
      renderCodes(results[1]);
    }).catch(fail);
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
    if (me.household) document.getElementById('inventoryLink').classList.remove('hidden');
    refresh();
  });
})();
