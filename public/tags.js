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
    var body = document.getElementById('tagsBody');
    body.innerHTML = '';
    tags.forEach(function (tag) {
      var tr = document.createElement('tr');

      var nameTd = document.createElement('td');
      nameTd.setAttribute('data-label', 'Tag');
      nameTd.textContent = tag.name;
      tr.appendChild(nameTd);

      var countTd = document.createElement('td');
      countTd.setAttribute('data-label', 'Items');
      countTd.textContent = tag.itemCount;
      tr.appendChild(countTd);

      var actionsTd = document.createElement('td');
      actionsTd.setAttribute('data-label', 'Actions');
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'small';
      delBtn.addEventListener('click', function () {
        if (!confirm('Delete tag "' + tag.name + '"?')) return;
        apiFetch('/tags/' + encodeURIComponent(tag.name), { method: 'DELETE' })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
      actionsTd.appendChild(delBtn);
      tr.appendChild(actionsTd);

      body.appendChild(tr);
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
