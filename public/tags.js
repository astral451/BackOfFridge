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

  function renderTags(tags) {
    var list = document.getElementById('tagsList');
    list.innerHTML = '';
    tags.forEach(function (tag) {
      var row = document.createElement('div');
      row.className = 'manage-row';

      var info = document.createElement('div');
      var nameDiv = document.createElement('div');
      nameDiv.textContent = tag.name;
      var countDiv = document.createElement('div');
      countDiv.className = 'manage-count';
      countDiv.textContent = tag.itemCount + ' item' + (tag.itemCount === 1 ? '' : 's');
      info.appendChild(nameDiv);
      info.appendChild(countDiv);
      row.appendChild(info);

      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'small';
      delBtn.addEventListener('click', function () {
        if (!confirm('Delete tag "' + tag.name + '"?')) return;
        apiFetch('/tags/' + encodeURIComponent(tag.name), { method: 'DELETE' })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
      row.appendChild(delBtn);

      list.appendChild(row);
    });
  }

  function refresh() {
    apiFetch('/tags/detail').then(renderTags).catch(function (err) {
      alert(err.message);
    });
  }

  document.getElementById('tagForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var nameInput = document.getElementById('t-name');
    var name = nameInput.value.trim();
    if (!name) return;
    apiFetch('/tags', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function () {
        nameInput.value = '';
        refresh();
      })
      .catch(function (err) { alert(err.message); });
  });

  loadWhoAmI();
  refresh();
})();
