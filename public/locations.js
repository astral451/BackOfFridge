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
    refresh();
  });

  function renderLocations(locations) {
    var body = document.getElementById('locationsBody');
    body.innerHTML = '';
    locations.forEach(function (loc) {
      var tr = document.createElement('tr');

      var nameTd = document.createElement('td');
      nameTd.setAttribute('data-label', 'Location');
      nameTd.textContent = loc.name;
      tr.appendChild(nameTd);

      var countTd = document.createElement('td');
      countTd.setAttribute('data-label', 'Items');
      countTd.textContent = loc.itemCount;
      tr.appendChild(countTd);

      var actionsTd = document.createElement('td');
      actionsTd.setAttribute('data-label', 'Actions');
      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'small';
      delBtn.addEventListener('click', function () {
        if (!confirm('Delete location "' + loc.name + '"?')) return;
        apiFetch('/locations/' + encodeURIComponent(loc.name), { method: 'DELETE' })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
      actionsTd.appendChild(delBtn);
      tr.appendChild(actionsTd);

      body.appendChild(tr);
    });
  }

  function refresh() {
    apiFetch('/locations/detail').then(renderLocations).catch(function (err) {
      alert(err.message);
    });
  }

  document.getElementById('locationForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var nameInput = document.getElementById('l-name');
    var name = nameInput.value.trim();
    if (!name) return;
    apiFetch('/locations', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function () {
        nameInput.value = '';
        refresh();
      })
      .catch(function (err) { alert(err.message); });
  });

  if (getKey()) {
    hideKeyGate();
    refresh();
  } else {
    showKeyGate();
  }
})();
