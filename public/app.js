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

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(dateStr + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  }

  // Returns a body object for the throw-out/consume request, or null if the
  // user cancelled. Only asks when there's more than one unit on hand.
  function promptQuantity(item, verb) {
    if (!(item.quantity > 1)) return {};
    var input = window.prompt(
      'How many "' + item.name + '" to mark as ' + verb + '? (' + item.quantity + ' on hand)',
      item.quantity
    );
    if (input === null) return null;
    var qty = parseFloat(input);
    if (!(qty > 0)) {
      alert('Enter a positive number.');
      return null;
    }
    return { quantity: qty };
  }

  // Pre-fills the purchase form from an existing item, so buying more of
  // something already tracked doesn't mean retyping name/category/location/unit.
  // Quantity, purchase date, and expiration are left for the user since those
  // typically differ on a new purchase.
  function fillFormFromItem(item) {
    document.getElementById('f-name').value = item.name;
    document.getElementById('f-category').value = item.category;
    document.getElementById('f-location-select').value = item.location;
    document.getElementById('f-location-new').classList.add('hidden');
    document.getElementById('f-tag-select').value = item.tag || '';
    document.getElementById('f-tag-new').classList.add('hidden');
    document.getElementById('f-unit').value = item.unit;
    document.getElementById('f-quantity').value = item.quantity > 0 ? item.quantity : 1;
    document.getElementById('f-purchase').value = new Date().toISOString().slice(0, 10);
    document.getElementById('f-expiration').value = '';
    document.getElementById('f-notes').value = '';
    document.querySelector('.add-form').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('f-expiration').focus();
  }

  // Dictation quirks to normalize before parsing: iOS/Android speech-to-text
  // (and plenty of people typing manually) write quantities as words rather
  // than digits, and spell units out in full rather than abbreviating them.
  var NUMBER_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, half: 0.5, quarter: 0.25, dozen: 12,
  };
  // Dictation sometimes splits a teen number at the syllable boundary
  // ("four teen" for "fourteen") - joined back to a numeral before anything
  // else runs. Not extended past nineteen: "twenty" already works standalone
  // via NUMBER_WORDS above, and beyond that dictation reliably gives plain
  // digits, so there's no equivalent split-word case to handle there.
  var TEEN_JOIN_WORDS = { two: 12, three: 13, four: 14, five: 15, six: 16, seven: 17, eight: 18, nine: 19 };
  var UNIT_WORDS = {
    ounce: 'oz', ounces: 'oz',
    pound: 'lb', pounds: 'lb', lbs: 'lb',
    gallon: 'gal', gallons: 'gal',
    quart: 'qt', quarts: 'qt',
    pint: 'pt', pints: 'pt',
    liter: 'L', liters: 'L', litre: 'L', litres: 'L',
    milliliter: 'mL', milliliters: 'mL',
    gram: 'g', grams: 'g',
    kilogram: 'kg', kilograms: 'kg',
  };
  var MONTH_NAMES = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
    sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
    dec: 11, december: 11,
  };
  var QTY_REGEX = /^(\d+(?:\.\d+)?)\s*(.*)$/;
  var FUZZY_THRESHOLD = 0.72;

  function joinSplitTeens(text) {
    return text.replace(/\b(two|three|four|five|six|seven|eight|nine)\s+teen\b/gi, function (m, word) {
      return String(TEEN_JOIN_WORDS[word.toLowerCase()]);
    });
  }

  // Replaces a leading number word ("two" -> "2") and normalizes a trailing
  // unit word ("ounces" -> "oz") so the existing digit+unit regex below
  // still does the actual splitting - this only rewrites the words it knows
  // about and leaves anything else untouched.
  function normalizeQuickAddSegment(seg) {
    var words = seg.trim().split(/\s+/);
    if (words.length && NUMBER_WORDS.hasOwnProperty(words[0].toLowerCase())) {
      words[0] = String(NUMBER_WORDS[words[0].toLowerCase()]);
    }
    var lastWord = words[words.length - 1].toLowerCase();
    if (UNIT_WORDS.hasOwnProperty(lastWord)) {
      words[words.length - 1] = UNIT_WORDS[lastWord];
    }
    return words.join(' ');
  }

  // Resolves "one"/"a"/"14" (already joined by joinSplitTeens if it was
  // "four teen")/plain digit strings to a number, or null if it isn't one.
  function resolveNumberWord(token) {
    var lower = token.toLowerCase();
    if (NUMBER_WORDS.hasOwnProperty(lower)) return NUMBER_WORDS[lower];
    if (lower === 'a' || lower === 'an') return 1;
    var n = parseFloat(token);
    return isNaN(n) ? null : n;
  }

  // Plain Levenshtein edit distance, for fuzzy-matching a dictated location/
  // tag ("Dinng Fridge") against the managed list ("Dining Fridge") instead
  // of requiring an exact (case-insensitive) match.
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    var dp = [];
    for (var i = 0; i <= m; i++) { dp.push([i]); }
    for (var j = 0; j <= n; j++) { dp[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / Math.max(a.length, b.length);
  }

  // Best entry in `list` for `candidate`, or null if nothing clears the
  // threshold. An exact (case-insensitive) match has similarity 1, so this
  // is a strict superset of a plain equality check.
  function fuzzyMatch(candidate, list) {
    var best = null;
    var bestScore = 0;
    list.forEach(function (item) {
      var score = similarity(candidate, item);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    });
    return bestScore >= FUZZY_THRESHOLD ? best : null;
  }

  function formatISODate(year, monthIndex, day) {
    var mm = String(monthIndex + 1);
    if (mm.length < 2) mm = '0' + mm;
    var dd = String(day);
    if (dd.length < 2) dd = '0' + dd;
    return year + '-' + mm + '-' + dd;
  }

  // Parses an "expires ..." phrase into an ISO date: a duration relative to
  // the purchase date ("1 week"), a month-name date ("August 10th 2026"),
  // or a numeric month/day/year date ("08 10 2026") - matching this app's
  // own <input type="date"> fields, month before day. Returns null on
  // anything else, rather than guessing wrong.
  function parseExpirationPhrase(phrase, purchaseDateISO) {
    phrase = phrase.trim();
    if (!phrase) return null;

    var durationMatch = phrase.match(/^(\S+)\s*(day|days|week|weeks|month|months|year|years)$/i);
    if (durationMatch) {
      var n = resolveNumberWord(durationMatch[1]);
      if (n !== null) {
        var base = purchaseDateISO ? new Date(purchaseDateISO + 'T00:00:00') : new Date();
        var unit = durationMatch[2].toLowerCase();
        if (unit.indexOf('day') === 0) base.setDate(base.getDate() + n);
        else if (unit.indexOf('week') === 0) base.setDate(base.getDate() + n * 7);
        else if (unit.indexOf('month') === 0) base.setMonth(base.getMonth() + n);
        else base.setFullYear(base.getFullYear() + n);
        return base.toISOString().slice(0, 10);
      }
    }

    var monthNameMatch = phrase.match(/^([a-zA-Z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (monthNameMatch && MONTH_NAMES.hasOwnProperty(monthNameMatch[1].toLowerCase())) {
      var day1 = parseInt(monthNameMatch[2], 10);
      if (day1 >= 1 && day1 <= 31) {
        return formatISODate(parseInt(monthNameMatch[3], 10), MONTH_NAMES[monthNameMatch[1].toLowerCase()], day1);
      }
    }

    var numericMatch = phrase.match(/^(\d{1,2})[\s\/-](\d{1,2})[\s\/-](\d{2,4})$/);
    if (numericMatch) {
      var mm = parseInt(numericMatch[1], 10);
      var dd = parseInt(numericMatch[2], 10);
      var yyyy = parseInt(numericMatch[3], 10);
      if (yyyy < 100) yyyy += 2000;
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return formatISODate(yyyy, mm - 1, dd);
      }
    }

    return null;
  }

  // Finds "expires"/"expiration"/"exp" (optionally followed by "in"/"on"/
  // ":") and strips it plus everything up to the next comma (or the end of
  // the string) out of `text`, handing that phrase to parseExpirationPhrase.
  function extractExpiration(text) {
    var match = text.match(/\b(?:expires?|expiration|exp)\b\s*(?:in|on|:)?\s*([^,]*)/i);
    if (!match) return { text: text, expiration: null };
    var expiration = parseExpirationPhrase(match[1], document.getElementById('f-purchase').value);
    var cleaned = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    return { text: cleaned.trim(), expiration: expiration };
  }

  // Finds an explicit "quantity <value>" keyword phrase and strips it out,
  // so "Raw carrots quantity 1, 5 pounds, ..." sets quantity from the
  // keyword rather than from the "5 pounds" segment later.
  function extractQuantityKeyword(text) {
    var match = text.match(/\bquantity\b\s*[:]?\s*([^\s,]+)/i);
    if (!match) return { text: text, quantity: null };
    var value = resolveNumberWord(match[1]);
    if (value === null) return { text: text, quantity: null };
    var cleaned = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    return { text: cleaned.trim(), quantity: value };
  }

  // Heuristic parser for the quick-add box. Dictation itself needs no app
  // code - the phone keyboard's mic button dictates into any text field;
  // this just turns the resulting freeform line into a best-guess set of
  // form fields. Deliberately does NOT submit anything itself - it only
  // pre-fills the existing detailed form for the user to review/adjust.
  //
  // Commas are treated as absolute separators when present (segment 0 is
  // always the name). Without a comma - or a dropped one - falls back to a
  // space-tokenized pass that works from the outer boundaries inward: strip
  // a trailing location match, then a trailing tag match, then a trailing
  // quantity/unit match, and whatever's left at the front is the name. This
  // is what keeps "Raw carrots 1 5lb kitchen fridge" and "Raw carrots
  // quantity 1, 5 pounds, kitchen fridge" landing on the same parsed result.
  function parseQuickAdd(text) {
    text = joinSplitTeens(text.trim());

    var expirationResult = extractExpiration(text);
    text = expirationResult.text;

    var quantityResult = extractQuantityKeyword(text);
    text = quantityResult.text;

    var result = {
      name: '', quantity: quantityResult.quantity, unit: '', location: '', tag: '',
      notes: '', expiration: expirationResult.expiration,
    };

    var locations = Array.prototype.map.call(document.querySelectorAll('#f-location-select option'), function (o) { return o.value; })
      .filter(function (v) { return v && v !== '__new__'; });
    var tags = Array.prototype.map.call(document.querySelectorAll('#f-tag-select option'), function (o) { return o.value; })
      .filter(function (v) { return v && v !== '__new__'; });

    if (text.indexOf(',') !== -1) {
      var segments = text.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!segments.length) return result;
      result.name = segments[0];

      var leftover = [];
      for (var i = 1; i < segments.length; i++) {
        var seg = normalizeQuickAddSegment(segments[i]);
        var qtyMatch = seg.match(QTY_REGEX);
        var matchedLocation = fuzzyMatch(segments[i], locations);
        var matchedTag = fuzzyMatch(segments[i], tags);

        if (qtyMatch && result.quantity === null) {
          result.quantity = parseFloat(qtyMatch[1]);
          result.unit = qtyMatch[2].trim();
        } else if (qtyMatch && !result.unit) {
          // Quantity already known (explicit "quantity" keyword) - this
          // segment is a pure unit descriptor, kept as one string ("5 lb").
          result.unit = seg;
        } else if (matchedLocation && !result.location) {
          result.location = matchedLocation;
        } else if (matchedTag && !result.tag) {
          result.tag = matchedTag;
        } else {
          leftover.push(segments[i]);
        }
      }
      result.notes = leftover.join(', ');
    } else if (text) {
      var tokens = text.split(/\s+/).filter(Boolean);

      // A window starting on a numeric-looking token ("5lb kitchen fridge")
      // is never a real location/tag name - skipping it stops a longer
      // window from scoring deceptively well against a real location just
      // because Levenshtein similarity is lenient on a short prefix addition.
      function startsNumeric(startIdx) {
        return /^\d/.test(tokens[startIdx]);
      }

      for (var w = Math.min(3, tokens.length); w >= 1 && !result.location; w--) {
        var locStart = tokens.length - w;
        if (startsNumeric(locStart)) continue;
        var loc = fuzzyMatch(tokens.slice(locStart).join(' '), locations);
        if (loc) {
          result.location = loc;
          tokens = tokens.slice(0, locStart);
        }
      }

      for (var w2 = Math.min(2, tokens.length); w2 >= 1 && !result.tag; w2--) {
        var tagStart = tokens.length - w2;
        if (startsNumeric(tagStart)) continue;
        var tag = fuzzyMatch(tokens.slice(tagStart).join(' '), tags);
        if (tag) {
          result.tag = tag;
          tokens = tokens.slice(0, tagStart);
        }
      }

      // Smallest window first: a single trailing token ("5lb", a bare "3")
      // is checked before a 2-token phrase ("5 pounds") - otherwise a
      // 2-token window would too eagerly swallow a separate leading
      // quantity ("1 5lb") as one spurious quantity+unit match instead of
      // leaving "1" for the preceding-token check below to find.
      var qtyFound = null;
      var qtyConsumed = 0;
      for (var w3 = 1; w3 <= Math.min(2, tokens.length) && !qtyFound; w3++) {
        var qtyCandidate = normalizeQuickAddSegment(tokens.slice(tokens.length - w3).join(' '));
        var m = qtyCandidate.match(QTY_REGEX);
        if (m) {
          qtyFound = { number: parseFloat(m[1]), unit: m[2].trim() };
          qtyConsumed = w3;
        }
      }

      if (qtyFound) {
        tokens = tokens.slice(0, tokens.length - qtyConsumed);
        var qtyDisplay = qtyFound.unit ? (qtyFound.number + ' ' + qtyFound.unit) : String(qtyFound.number);

        // A separate bare number immediately before the match ("1 5lb") is
        // the real quantity, with the matched number+unit becoming the unit
        // description instead of overwriting it - only the immediately
        // preceding token is checked, not the whole name, to avoid an
        // ordinary name word being mistaken for a count.
        var precedingVal = tokens.length ? resolveNumberWord(tokens[tokens.length - 1]) : null;

        if (result.quantity === null && precedingVal !== null && qtyFound.unit) {
          result.quantity = precedingVal;
          result.unit = qtyDisplay;
          tokens = tokens.slice(0, tokens.length - 1);
        } else if (result.quantity === null) {
          result.quantity = qtyFound.number;
          result.unit = qtyFound.unit;
        } else {
          result.unit = qtyDisplay;
        }
      }

      result.name = tokens.join(' ');
    }

    return result;
  }

  // Pre-fills the purchase form from a parsed quick-add line and scrolls to
  // it for review - mirrors fillFormFromItem's "pre-fill, don't submit"
  // behavior, but only touches fields the parser actually found something
  // for, leaving the rest (category, etc.) as the user last left them.
  function fillFormFromQuickAdd(parsed) {
    document.getElementById('f-name').value = parsed.name;
    if (parsed.quantity !== null) document.getElementById('f-quantity').value = parsed.quantity;
    if (parsed.unit) document.getElementById('f-unit').value = parsed.unit;
    if (parsed.location) {
      document.getElementById('f-location-select').value = parsed.location;
      document.getElementById('f-location-new').classList.add('hidden');
    }
    if (parsed.tag) {
      document.getElementById('f-tag-select').value = parsed.tag;
      document.getElementById('f-tag-new').classList.add('hidden');
    }
    if (parsed.expiration) document.getElementById('f-expiration').value = parsed.expiration;
    if (parsed.notes) document.getElementById('f-notes').value = parsed.notes;
    document.getElementById('f-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('f-name').focus();
  }

  // Replaces the whole row with a single wide cell holding a vertical,
  // one-row-per-field grid covering every editable field - name, category,
  // location, tag, quantity/unit (or fill %), purchase/expiration dates,
  // and notes - reusing the same <select>s built for the purchase form
  // rather than inventing new controls. Folds in what used to be the
  // separate "Edit dates" prompt sequence, since dates are just two more
  // rows here. Cancel/refresh discards unsaved changes and redraws the row
  // normally, same pattern as the location-only editor this replaces.
  function startFullFieldEdit(item, tr) {
    var colCount = tr.children.length;
    tr.innerHTML = '';

    var td = document.createElement('td');
    td.colSpan = colCount;
    td.className = 'full-edit-cell';

    var grid = document.createElement('div');
    grid.className = 'full-edit-grid';

    function row(labelText, inputEl) {
      var label = document.createElement('label');
      label.textContent = labelText;
      grid.appendChild(label);
      grid.appendChild(inputEl);
    }

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = item.name;
    row('Name', nameInput);

    var categorySelect = document.createElement('select');
    [['perishable', 'Perishable'], ['nonperishable', 'Non-perishable']].forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      categorySelect.appendChild(opt);
    });
    categorySelect.value = item.category;
    row('Category', categorySelect);

    var locationSelect = document.createElement('select');
    locationSelect.disabled = true;
    var loadingLocOpt = document.createElement('option');
    loadingLocOpt.textContent = 'Loading...';
    locationSelect.appendChild(loadingLocOpt);
    row('Location', locationSelect);

    var tagSelect = document.createElement('select');
    tagSelect.disabled = true;
    var loadingTagOpt = document.createElement('option');
    loadingTagOpt.textContent = 'Loading...';
    tagSelect.appendChild(loadingTagOpt);
    row('Tag', tagSelect);

    var quantityInput, unitInput, fillInput;
    if (item.tracking_mode === 'fill_level') {
      fillInput = document.createElement('input');
      fillInput.type = 'number';
      fillInput.min = 0;
      fillInput.max = 100;
      fillInput.value = item.fill_percent != null ? item.fill_percent : 100;
      row('Fill %', fillInput);
    } else {
      quantityInput = document.createElement('input');
      quantityInput.type = 'number';
      quantityInput.step = 'any';
      quantityInput.value = item.quantity;
      row('Quantity', quantityInput);

      unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.value = item.unit || '';
      row('Unit', unitInput);
    }

    var purchaseInput = document.createElement('input');
    purchaseInput.type = 'date';
    purchaseInput.value = item.purchase_date || '';
    row('Purchased', purchaseInput);

    var expirationInput = document.createElement('input');
    expirationInput.type = 'date';
    expirationInput.value = item.expiration_date || '';
    row('Expires', expirationInput);

    var notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.value = item.notes || '';
    row('Notes', notesInput);

    td.appendChild(grid);

    var buttons = document.createElement('div');
    buttons.className = 'full-edit-buttons';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'small';
    saveBtn.addEventListener('click', function () {
      var name = nameInput.value.trim();
      if (!name) {
        alert('Name is required.');
        return;
      }
      var updates = {
        name: name,
        category: categorySelect.value,
        location: locationSelect.value,
        tag: tagSelect.value,
        purchase_date: purchaseInput.value || null,
        expiration_date: expirationInput.value || null,
        notes: notesInput.value,
      };
      if (item.tracking_mode === 'fill_level') {
        var pct = parseFloat(fillInput.value);
        if (!(pct >= 0 && pct <= 100)) {
          alert('Fill % must be between 0 and 100.');
          return;
        }
        updates.fill_percent = pct;
      } else {
        var quantity = parseFloat(quantityInput.value);
        if (!(quantity >= 0)) {
          alert('Enter a quantity of zero or more.');
          return;
        }
        updates.quantity = quantity;
        updates.unit = unitInput.value;
      }
      apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify(updates) })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'small';
    cancelBtn.addEventListener('click', refresh);

    buttons.appendChild(saveBtn);
    buttons.appendChild(cancelBtn);
    td.appendChild(buttons);
    tr.appendChild(td);

    Promise.all([apiFetch('/locations'), apiFetch('/tags')]).then(function (results) {
      var locations = results[0];
      var tags = results[1];

      locationSelect.innerHTML = '';
      locations.forEach(function (loc) {
        var opt = document.createElement('option');
        opt.value = loc;
        opt.textContent = loc;
        locationSelect.appendChild(opt);
      });
      locationSelect.value = item.location;
      locationSelect.disabled = false;

      tagSelect.innerHTML = '<option value="">(none)</option>';
      tags.forEach(function (tag) {
        var opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        tagSelect.appendChild(opt);
      });
      tagSelect.value = item.tag || '';
      tagSelect.disabled = false;
    }).catch(function (err) { alert(err.message); });
  }

  // Builds a vertical fill-level meter: a normal horizontal <input
  // type="range"> rotated with CSS (not the vendor-specific "orient" or
  // "-webkit-appearance: slider-vertical" APIs, which only work in some
  // browsers) so dragging works anywhere plain CSS transforms do. Updates a
  // percent label live while dragging (no network calls); only PATCHes on
  // release, so a slow connection isn't hit on every pixel of drag.
  function buildFillMeter(item) {
    var wrap = document.createElement('div');
    wrap.className = 'fill-meter';

    var track = document.createElement('div');
    track.className = 'fill-meter-track';

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = item.fill_percent != null ? item.fill_percent : 100;

    var label = document.createElement('span');
    label.className = 'fill-label';
    label.textContent = slider.value + '%';

    slider.addEventListener('input', function () {
      label.textContent = slider.value + '%';
    });
    slider.addEventListener('change', function () {
      apiFetch('/items/' + item.id, {
        method: 'PATCH',
        body: JSON.stringify({ fill_percent: parseFloat(slider.value) }),
      })
        .then(refresh)
        .catch(function (err) { alert(err.message); });
    });

    track.appendChild(slider);
    wrap.appendChild(track);
    wrap.appendChild(label);
    return wrap;
  }

  // Quick +/- for the common "used/added one" case, with no prompt. Count-
  // tracked items step by 1 (consume for -, a plain quantity PATCH for +);
  // fill-level items step by 10 percentage points, and a - at or below 10%
  // fully consumes the item instead of going negative - mirroring how
  // reduceQuantity (server-side) floors a count-based consume at zero.
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

  // Builds the -/+ button pair for the Qty cell (see quickAdjust above).
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

  function rowClass(item) {
    if (item.status !== 'active') return item.status;
    var d = daysUntil(item.expiration_date);
    if (d === null) return '';
    if (d < 0) return 'expired';
    if (d <= 3) return 'expiring-soon';
    return '';
  }

  function renderItems(items) {
    var body = document.getElementById('itemsBody');
    body.innerHTML = '';
    items.forEach(function (item) {
      var tr = document.createElement('tr');
      tr.className = rowClass(item);

      function cell(label, text) {
        var td = document.createElement('td');
        td.setAttribute('data-label', label);
        td.textContent = text || '';
        tr.appendChild(td);
      }

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

      cell('Category', item.category);
      cell('Location', item.location);
      cell('Tag', item.tag);

      var qtyTd = document.createElement('td');
      qtyTd.setAttribute('data-label', 'Qty');
      if (item.tracking_mode === 'fill_level') {
        qtyTd.appendChild(buildFillMeter(item));
      } else {
        var qtyText = document.createElement('span');
        qtyText.textContent = item.quantity + ' ' + (item.unit || '');
        qtyTd.appendChild(qtyText);
      }
      if (item.status === 'active') {
        qtyTd.appendChild(buildQtyAdjustButtons(item));
      }
      tr.appendChild(qtyTd);

      cell('Purchased', item.purchase_date);
      cell('Expires', item.expiration_date);
      cell('Status', item.status);

      var actionsTd = document.createElement('td');
      actionsTd.setAttribute('data-label', 'Actions');
      if (item.status === 'active') {
        var throwBtn = document.createElement('button');
        throwBtn.textContent = 'Throw out';
        throwBtn.className = 'small';
        throwBtn.addEventListener('click', function () {
          var body = promptQuantity(item, 'thrown out');
          if (body === null) return;
          apiFetch('/items/' + item.id + '/throw-out', { method: 'POST', body: JSON.stringify(body) })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
        var consumeBtn = document.createElement('button');
        consumeBtn.textContent = 'Consumed';
        consumeBtn.className = 'small';
        consumeBtn.addEventListener('click', function () {
          var body = promptQuantity(item, 'consumed');
          if (body === null) return;
          apiFetch('/items/' + item.id + '/consume', { method: 'POST', body: JSON.stringify(body) })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
        actionsTd.appendChild(throwBtn);
        actionsTd.appendChild(consumeBtn);
      }
      if (item.prev_status) {
        var undoBtn = document.createElement('button');
        undoBtn.textContent = 'Undo';
        undoBtn.className = 'small';
        undoBtn.addEventListener('click', function () {
          apiFetch('/items/' + item.id + '/undo', { method: 'POST' })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
        actionsTd.appendChild(undoBtn);
      }
      var editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.className = 'small';
      editBtn.addEventListener('click', function () {
        startFullFieldEdit(item, tr);
      });
      actionsTd.appendChild(editBtn);

      var modeBtn = document.createElement('button');
      modeBtn.className = 'small';
      if (item.tracking_mode === 'fill_level') {
        modeBtn.textContent = 'Track by count';
        modeBtn.addEventListener('click', function () {
          apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify({ tracking_mode: 'count' }) })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
      } else {
        modeBtn.textContent = 'Track by fill level';
        modeBtn.addEventListener('click', function () {
          var input = window.prompt('Roughly how full is "' + item.name + '" right now? (0-100%)', '100');
          if (input === null) return;
          var pct = parseFloat(input);
          if (!(pct >= 0 && pct <= 100)) {
            alert('Enter a number between 0 and 100.');
            return;
          }
          apiFetch('/items/' + item.id, {
            method: 'PATCH',
            body: JSON.stringify({ tracking_mode: 'fill_level', fill_percent: pct }),
          })
            .then(refresh)
            .catch(function (err) { alert(err.message); });
        });
      }
      actionsTd.appendChild(modeBtn);

      var buyAgainBtn = document.createElement('button');
      buyAgainBtn.textContent = 'Buy again';
      buyAgainBtn.className = 'small';
      buyAgainBtn.addEventListener('click', function () {
        fillFormFromItem(item);
      });
      actionsTd.appendChild(buyAgainBtn);

      var delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'small';
      delBtn.addEventListener('click', function () {
        if (confirm('Delete "' + item.name + '"?')) {
          apiFetch('/items/' + item.id, { method: 'DELETE' }).then(refresh);
        }
      });
      actionsTd.appendChild(delBtn);
      tr.appendChild(actionsTd);

      body.appendChild(tr);
    });
  }

  function renderStats(stats) {
    document.getElementById('stats').textContent =
      stats.active + ' active · ' + stats.expiringSoon + ' expiring soon · ' + stats.expired + ' expired';
  }

  function renderLocations(locations) {
    var filterSelect = document.getElementById('filterLocation');
    var currentFilterVal = filterSelect.value;
    filterSelect.innerHTML = '<option value="">All</option>';
    locations.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = currentFilterVal;

    var formSelect = document.getElementById('f-location-select');
    var currentFormVal = formSelect.value;
    formSelect.innerHTML = '<option value="">Select location...</option>';
    locations.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      formSelect.appendChild(opt);
    });
    var addNewOpt = document.createElement('option');
    addNewOpt.value = '__new__';
    addNewOpt.textContent = '+ Add new location...';
    formSelect.appendChild(addNewOpt);
    formSelect.value = currentFormVal;
  }

  function renderTags(tags) {
    var filterSelect = document.getElementById('filterTag');
    var currentFilterVal = filterSelect.value;
    filterSelect.innerHTML = '<option value="">All</option>';
    tags.forEach(function (tag) {
      var opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = tag;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = currentFilterVal;

    var formSelect = document.getElementById('f-tag-select');
    var currentFormVal = formSelect.value;
    formSelect.innerHTML = '<option value="">Select tag...</option>';
    tags.forEach(function (tag) {
      var opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = tag;
      formSelect.appendChild(opt);
    });
    var addNewOpt = document.createElement('option');
    addNewOpt.value = '__new__';
    addNewOpt.textContent = '+ Add new tag...';
    formSelect.appendChild(addNewOpt);
    formSelect.value = currentFormVal;
  }

  var lastItems = [];

  // Case-insensitive substring match across every field worth searching,
  // then a sort - both operate on the already-fetched item list client-side
  // rather than round-tripping to the server, since the full list is
  // already loaded for the status/location filters.
  function applyFiltersAndRender() {
    var query = document.getElementById('searchBox').value.trim().toLowerCase();
    var filtered = lastItems;
    if (query) {
      filtered = lastItems.filter(function (item) {
        return [item.name, item.location, item.category, item.tag, item.notes, item.unit, item.status]
          .some(function (field) { return field && field.toLowerCase().indexOf(query) !== -1; });
      });
    }

    var sortBy = document.getElementById('sortBy').value;
    if (sortBy === 'recent') {
      filtered = filtered.slice().sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
    } else if (sortBy === 'name') {
      filtered = filtered.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    }

    renderItems(filtered);
  }

  function refresh() {
    var params = new URLSearchParams();
    if (document.getElementById('filterActiveOnly').checked) {
      params.set('status', 'active');
    }
    var loc = document.getElementById('filterLocation').value;
    if (loc) params.set('location', loc);
    var tag = document.getElementById('filterTag').value;
    if (tag) params.set('tag', tag);

    apiFetch('/items?' + params.toString()).then(function (items) {
      lastItems = items;
      applyFiltersAndRender();
    });
    apiFetch('/stats').then(renderStats);
    apiFetch('/locations').then(renderLocations);
    apiFetch('/tags').then(renderTags);
  }

  function currentFormLocation() {
    var select = document.getElementById('f-location-select');
    if (select.value === '__new__') {
      return document.getElementById('f-location-new').value;
    }
    return select.value;
  }

  function currentFormTag() {
    var select = document.getElementById('f-tag-select');
    if (select.value === '__new__') {
      return document.getElementById('f-tag-new').value;
    }
    return select.value;
  }

  document.getElementById('f-location-select').addEventListener('change', function () {
    var newInput = document.getElementById('f-location-new');
    if (this.value === '__new__') {
      newInput.classList.remove('hidden');
      newInput.focus();
    } else {
      newInput.classList.add('hidden');
      newInput.value = '';
    }
  });

  document.getElementById('f-tag-select').addEventListener('change', function () {
    var newInput = document.getElementById('f-tag-new');
    if (this.value === '__new__') {
      newInput.classList.remove('hidden');
      newInput.focus();
    } else {
      newInput.classList.add('hidden');
      newInput.value = '';
    }
  });

  document.getElementById('itemForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var payload = {
      name: document.getElementById('f-name').value,
      category: document.getElementById('f-category').value,
      location: currentFormLocation(),
      tag: currentFormTag(),
      quantity: parseFloat(document.getElementById('f-quantity').value) || 1,
      unit: document.getElementById('f-unit').value,
      purchase_date: document.getElementById('f-purchase').value || null,
      expiration_date: document.getElementById('f-expiration').value || null,
      notes: document.getElementById('f-notes').value,
    };
    apiFetch('/items', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
      e.target.reset();
      document.getElementById('f-category').value = 'perishable';
      document.getElementById('f-location-new').classList.add('hidden');
      document.getElementById('f-tag-new').classList.add('hidden');
      setDefaultPurchaseDate();
      refresh();
    }).catch(function (err) {
      alert(err.message);
    });
  });

  document.getElementById('quickAddForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('quickAddInput');
    var text = input.value.trim();
    if (!text) return;
    fillFormFromQuickAdd(parseQuickAdd(text));
    input.value = '';
  });

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('filterActiveOnly').addEventListener('change', refresh);
  document.getElementById('filterLocation').addEventListener('change', refresh);
  document.getElementById('filterTag').addEventListener('change', refresh);
  document.getElementById('searchBox').addEventListener('input', applyFiltersAndRender);
  document.getElementById('sortBy').addEventListener('change', applyFiltersAndRender);

  // Defaults the purchase date to today, since that's true for the large
  // majority of purchases logged - saves a tap/dictation on every add, and
  // is still trivially overridable for a backdated entry.
  function setDefaultPurchaseDate() {
    document.getElementById('f-purchase').value = new Date().toISOString().slice(0, 10);
  }

  setDefaultPurchaseDate();
  loadWhoAmI();
  refresh();
})();
