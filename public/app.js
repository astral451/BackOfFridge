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

  function openSheet() {
    document.getElementById('itemSheet').hidden = false;
  }
  function closeSheet() {
    document.getElementById('itemSheet').hidden = true;
  }
  function expandMoreFields() {
    document.getElementById('moreFields').hidden = false;
  }

  // Pre-fills the purchase form from an existing item, so buying more of
  // something already tracked doesn't mean retyping name/category/location/unit.
  // Quantity, purchase date, and expiration are left for the user since those
  // typically differ on a new purchase.
  function fillFormFromItem(item) {
    openSheet();
    setAddMode();
    document.getElementById('f-name').value = (item.name || '').trim();
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
    expandMoreFields();
    document.getElementById('itemSheet').scrollIntoView({ behavior: 'smooth' });
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
  // Unit spellings that are already short enough to keep as-is, and
  // count-style units kept exactly as spoken ("cans", "bags").
  var UNIT_ABBREVIATIONS = ['oz', 'lb', 'gal', 'qt', 'pt', 'l', 'ml', 'g', 'kg', 'fl'];
  var COUNT_UNITS = [
    'cup', 'cups', 'can', 'cans', 'bag', 'bags', 'box', 'boxes', 'bottle', 'bottles',
    'jar', 'jars', 'pack', 'packs', 'roll', 'rolls', 'loaf', 'loaves', 'bunch', 'bunches',
    'carton', 'cartons', 'stick', 'sticks', 'piece', 'pieces', 'count', 'ct', 'each',
  ];
  var FUZZY_THRESHOLD = 0.72;

  function joinSplitTeens(text) {
    return text.replace(/\b(two|three|four|five|six|seven|eight|nine)\s+teen\b/gi, function (m, word) {
      return String(TEEN_JOIN_WORDS[word.toLowerCase()]);
    });
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

  // Date shapes the parser recognizes. A month-name date or a slashed/dashed
  // numeric date with a year is unambiguous on its own, so it's taken as the
  // expiration date even without "expires" (the purchase date already
  // defaults to today, so a bare date in a quick-add line is almost always
  // the expiration). Commas are allowed between the parts because dictation
  // drops them in unpredictably ("October, 10th 2026"). The looser shapes -
  // a year-less month date, space-separated numbers, a duration - are only
  // trusted right after an "expires" keyword.
  var MONTH_PATTERN = '(' + Object.keys(MONTH_NAMES).sort(function (a, b) { return b.length - a.length; }).join('|') + ')';
  var MONTH_DATE_RE = new RegExp('\\b' + MONTH_PATTERN + '\\.?[\\s,]+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:[\\s,]+(\\d{4}))?', 'i');
  var NUMERIC_DATE_RE = /\b(\d{1,2})([\/.-])(\d{1,2})\2(\d{2,4})\b/;
  var SPACED_DATE_RE = /^(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/;
  var DURATION_RE = /^(\S+)\s+(days?|weeks?|months?|years?)\b(?:\s+from\s+(?:today|now|purchase))?/i;
  // A duration said without "expires" - "in two weeks", "a month from
  // today". Needs "in" before it or "from today/now" after it: a bare "2
  // weeks" is left alone, since that could just as well be a quantity.
  var DURATION_NUMBER = '(\\d+(?:\\.\\d+)?|a|an|' + Object.keys(NUMBER_WORDS).join('|') + ')';
  var DURATION_UNIT = '(days?|weeks?|months?|years?)';
  var RELATIVE_DURATION_RES = [
    new RegExp('\\bin\\s+' + DURATION_NUMBER + '\\s+' + DURATION_UNIT + '\\b(?:\\s+from\\s+(?:today|now|purchase))?(?:[\\s,]+in\\b)?', 'i'),
    new RegExp('\\b' + DURATION_NUMBER + '\\s+' + DURATION_UNIT + '\\s+from\\s+(?:today|now|purchase)\\b', 'i'),
  ];
  var EXPIRES_KEYWORD_RE = /\b(?:expires?|expiring|expiration(?:\s+date)?|exp|best\s+by|use\s+by)\b[\s,:]*(?:(?:in|on)\b[\s,]*)?/i;

  function validDate(year, monthIndex, day) {
    if (year < 100) year += 2000;
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
    return formatISODate(year, monthIndex, day);
  }

  // A year-less "May 16" means the next May 16 on or after the purchase
  // date, so it never lands in the past.
  function monthDateToISO(m, purchaseDateISO) {
    var monthIndex = MONTH_NAMES[m[1].toLowerCase()];
    var day = parseInt(m[2], 10);
    if (m[3]) return validDate(parseInt(m[3], 10), monthIndex, day);
    var base = purchaseDateISO ? new Date(purchaseDateISO + 'T00:00:00') : new Date();
    var iso = validDate(base.getFullYear(), monthIndex, day);
    if (iso && iso < formatISODate(base.getFullYear(), base.getMonth(), base.getDate())) {
      iso = validDate(base.getFullYear() + 1, monthIndex, day);
    }
    return iso;
  }

  // Tries every date shape against the start of `rest` (the text right
  // after an "expires" keyword). Returns { iso, length } or null.
  function parseDateAfterKeyword(rest, purchaseDateISO) {
    var m = rest.match(new RegExp('^' + MONTH_DATE_RE.source.slice(2), 'i'));
    if (m) {
      var iso = monthDateToISO(m, purchaseDateISO);
      if (iso) return { iso: iso, length: m[0].length };
    }
    m = rest.match(new RegExp('^' + NUMERIC_DATE_RE.source.slice(2)));
    if (m) {
      iso = validDate(parseInt(m[4], 10), parseInt(m[1], 10) - 1, parseInt(m[3], 10));
      if (iso) return { iso: iso, length: m[0].length };
    }
    m = rest.match(SPACED_DATE_RE);
    if (m) {
      iso = validDate(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
      if (iso) return { iso: iso, length: m[0].length };
    }
    m = rest.match(DURATION_RE);
    if (m) {
      iso = durationToISO(m[1], m[2], purchaseDateISO);
      if (iso) return { iso: iso, length: m[0].length };
    }
    return null;
  }

  // "two" + "weeks" -> the ISO date that long after the purchase date (which
  // defaults to today, so "from today" and "from purchase" agree).
  function durationToISO(numberWord, unitWord, purchaseDateISO) {
    var n = resolveNumberWord(numberWord);
    if (n === null) return null;
    var base = purchaseDateISO ? new Date(purchaseDateISO + 'T00:00:00') : new Date();
    var unit = unitWord.toLowerCase();
    if (unit.indexOf('day') === 0) base.setDate(base.getDate() + n);
    else if (unit.indexOf('week') === 0) base.setDate(base.getDate() + n * 7);
    else if (unit.indexOf('month') === 0) base.setMonth(base.getMonth() + n);
    else base.setFullYear(base.getFullYear() + n);
    return formatISODate(base.getFullYear(), base.getMonth(), base.getDate());
  }

  // Cuts text[start, end) out and leaves a comma in its place, so whatever
  // was on either side of a removed phrase is never read as one run of
  // words (e.g. a location split across it).
  function cutOut(text, start, end) {
    return text.slice(0, start) + ' , ' + text.slice(end);
  }

  // Finds the expiration date: "expires <date or duration>" first, then
  // (no keyword) any unambiguous full date anywhere in the line, then a
  // relative duration ("in two weeks", "a month from today").
  function extractExpiration(text) {
    var purchaseDateISO = document.getElementById('f-purchase').value;
    var kw = text.match(EXPIRES_KEYWORD_RE);
    if (kw) {
      var restStart = kw.index + kw[0].length;
      var parsed = parseDateAfterKeyword(text.slice(restStart), purchaseDateISO);
      if (parsed) {
        return { text: cutOut(text, kw.index, restStart + parsed.length), expiration: parsed.iso };
      }
      // Keyword with nothing recognizable after it - drop just the keyword
      // and let the rest fall through (it ends up in name or notes, where
      // it's visible on the review form, rather than silently vanishing).
      text = cutOut(text, kw.index, restStart);
    }

    var m = text.match(MONTH_DATE_RE);
    if (m && m[3]) {
      var iso = monthDateToISO(m, purchaseDateISO);
      if (iso) return { text: cutOut(text, m.index, m.index + m[0].length), expiration: iso };
    }
    m = text.match(NUMERIC_DATE_RE);
    if (m) {
      iso = validDate(parseInt(m[4], 10), parseInt(m[1], 10) - 1, parseInt(m[3], 10));
      if (iso) return { text: cutOut(text, m.index, m.index + m[0].length), expiration: iso };
    }
    for (var r = 0; r < RELATIVE_DURATION_RES.length; r++) {
      m = text.match(RELATIVE_DURATION_RES[r]);
      if (m) {
        iso = durationToISO(m[1], m[2], purchaseDateISO);
        if (iso) return { text: cutOut(text, m.index, m.index + m[0].length), expiration: iso };
      }
    }
    return { text: text, expiration: null };
  }

  // Number words accepted when scanning a line for a quantity. "half",
  // "quarter" and "dozen" are left out here (still fine after an explicit
  // "quantity" keyword) because they show up in ordinary item names
  // ("half and half") far more often than as a spoken count.
  function scanNumber(token) {
    if (/^\d+(?:\.\d+)?$/.test(token)) return parseFloat(token);
    var lower = token.toLowerCase();
    if (NUMBER_WORDS.hasOwnProperty(lower) && ['half', 'quarter', 'dozen'].indexOf(lower) === -1) {
      return NUMBER_WORDS[lower];
    }
    return null;
  }

  // Abbreviates a spoken unit ("ounces" -> "oz"), keeps a known count-style
  // unit as spoken ("cans"), or returns null for anything that isn't a unit.
  function normalizeUnit(word) {
    if (!word) return null;
    var lower = word.toLowerCase().replace(/\.$/, '');
    if (UNIT_WORDS.hasOwnProperty(lower)) return UNIT_WORDS[lower];
    if (UNIT_ABBREVIATIONS.indexOf(lower) !== -1) return lower === 'l' ? 'L' : lower === 'ml' ? 'mL' : lower;
    if (COUNT_UNITS.indexOf(lower) !== -1) return lower;
    return null;
  }

  // "24oz"/"5lb" written as one token -> { number, unit }, else null.
  function splitAttachedUnit(token) {
    var m = token.match(/^(\d+(?:\.\d+)?)([a-zA-Z]+\.?)$/);
    if (!m) return null;
    var unit = normalizeUnit(m[2]);
    return unit ? { number: parseFloat(m[1]), unit: unit } : null;
  }

  // Reads "<number> [unit]" (or one "24oz" token) at the start of `s`, for
  // the phrase right after a quantity/size keyword. Returns { number, unit,
  // length } or null.
  function readNumberAndUnit(s) {
    var m = s.match(/^(\S+?)(?=[\s,]|$)(?:\s+([a-zA-Z]+\.?)(?=[\s,]|$))?/);
    if (!m) return null;
    var attached = splitAttachedUnit(m[1]);
    if (attached) return { number: attached.number, unit: attached.unit, length: m[1].length };
    var n = resolveNumberWord(m[1]);
    if (n === null || m[1].toLowerCase() === 'a' || m[1].toLowerCase() === 'an') return null;
    var unit = normalizeUnit(m[2]);
    return { number: n, unit: unit, length: unit ? m[0].length : m[1].length };
  }

  // "quantity two" sets the count. A unit straight after it ("quantity 224
  // ounces") is kept as that count's unit.
  function extractQuantityKeyword(text) {
    var kw = text.match(/\bquantity\b[\s,:]*/i);
    if (!kw) return { text: text, quantity: null, unit: null };
    var read = readNumberAndUnit(text.slice(kw.index + kw[0].length));
    if (!read) return { text: text, quantity: null, unit: null };
    return {
      text: cutOut(text, kw.index, kw.index + kw[0].length + read.length),
      quantity: read.number,
      unit: read.unit,
    };
  }

  // "size/volume/weight 24 ounces" sets the per-item size, kept in the unit
  // field as one string ("24 oz") - the same convention "1 5lb" already
  // used. The keyword is what keeps a spoken "two ... twenty four ounces"
  // from being merged by dictation into "224 ounces".
  function extractSizeKeyword(text) {
    var kw = text.match(/\b(?:size|volume|weight)\b[\s,:]*/i);
    if (!kw) return { text: text, size: null };
    var read = readNumberAndUnit(text.slice(kw.index + kw[0].length));
    if (!read) return { text: text, size: null };
    return {
      text: cutOut(text, kw.index, kw.index + kw[0].length + read.length),
      size: read.number + (read.unit ? ' ' + read.unit : ''),
    };
  }

  // Best fuzzy match for any run of up to maxWords unused tokens against a
  // managed list (locations/tags), anywhere in the line - not just at the
  // end, so "kitchen fridge yogurt" works as well as "yogurt kitchen
  // fridge". A run never crosses a comma or starts on a number. Marks the
  // matched tokens used and returns the list entry, or ''.
  function takeListMatch(tokens, used, list, maxWords) {
    var best = null;
    for (var w = maxWords; w >= 1; w--) {
      for (var start = tokens.length - w; start >= 0; start--) {
        var ok = !/^\d/.test(tokens[start]);
        for (var k = start; ok && k < start + w; k++) {
          if (used[k] || tokens[k] === ',') ok = false;
        }
        if (!ok) continue;
        var phrase = tokens.slice(start, start + w).join(' ');
        list.forEach(function (entry) {
          var score = similarity(phrase, entry);
          // Strictly better only: ties keep the longer, later run found first.
          if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
            best = { entry: entry, start: start, w: w, score: score };
          }
        });
      }
    }
    if (!best) return '';
    for (var i = best.start; i < best.start + best.w; i++) used[i] = true;
    // Dictation stutter: a false start just before the match that's the
    // beginning of it ("pan pantry", "kitchen kitchen fridge") is dropped
    // rather than left in the name or notes.
    var prev = best.start - 1;
    if (prev >= 0 && !used[prev] && tokens[prev].length >= 2 &&
        best.entry.toLowerCase().indexOf(tokens[prev].toLowerCase()) === 0) {
      used[prev] = true;
    }
    return best.entry;
  }

  // Heuristic parser for the quick-add box. Dictation itself needs no app
  // code - the phone keyboard's mic button dictates into any text field;
  // this just turns the resulting freeform line into a best-guess set of
  // form fields. Deliberately does NOT submit anything itself - it only
  // pre-fills the existing detailed form for the user to review/adjust.
  //
  // Dictation places commas unreliably, so a comma is never what decides
  // which field is which. Each field is found by a keyword or by being
  // unambiguous on its own (see dictation_examples.md for the real lines
  // this was built against):
  //   - expiration: "expires ..." or any full date ("May 16, 2027")
  //   - quantity: "quantity two", or the first number in the line
  //   - size: "size/volume/weight 24 ounces", or a second number right
  //     after the count ("1 5lb", "two, 24 ounces") - a comma, typed or
  //     spoken as "comma", between two numbers marks exactly that split
  //   - location/tag: fuzzy-matched against the managed lists, anywhere
  //   - name: the words before the quantity, commas or not; anything
  //     after it is notes
  function parseQuickAdd(text) {
    text = joinSplitTeens(text.trim());
    text = text.replace(/\s*\bcomma\b\s*/gi, ', ');

    var expirationResult = extractExpiration(text);
    text = expirationResult.text;
    var quantityResult = extractQuantityKeyword(text);
    text = quantityResult.text;
    var sizeResult = extractSizeKeyword(text);
    text = sizeResult.text;

    var result = {
      name: '', quantity: quantityResult.quantity, unit: sizeResult.size || quantityResult.unit || '',
      location: '', tag: '', notes: '', expiration: expirationResult.expiration,
    };

    var locations = Array.prototype.map.call(document.querySelectorAll('#f-location-select option'), function (o) { return o.value; })
      .filter(function (v) { return v && v !== '__new__'; });
    var tags = Array.prototype.map.call(document.querySelectorAll('#f-tag-select option'), function (o) { return o.value; })
      .filter(function (v) { return v && v !== '__new__'; });

    var tokens = text.replace(/,/g, ' , ').split(/\s+/).filter(Boolean);
    var used = tokens.map(function () { return false; });

    result.location = takeListMatch(tokens, used, locations, 3);
    result.tag = takeListMatch(tokens, used, tags, 2);

    // The first number in what's left is the quantity (or, with "quantity"
    // already given, a size). What immediately follows decides the rest.
    var qtyStart = -1;
    var qtyEnd = -1;
    for (var i = 0; i < tokens.length && qtyStart === -1; i++) {
      if (used[i] || tokens[i] === ',') continue;
      if (scanNumber(tokens[i]) !== null || splitAttachedUnit(tokens[i])) qtyStart = i;
    }

    if (qtyStart !== -1) {
      var number;
      var unit = null;
      var size = null;
      var attached = splitAttachedUnit(tokens[qtyStart]);
      qtyEnd = qtyStart + 1;
      if (attached) {
        number = attached.number;
        unit = attached.unit;
      } else {
        number = scanNumber(tokens[qtyStart]);
        // A second number right after the first - directly, or after a
        // comma - is a size: "1 5lb", "two 24 ounces", "2, 24 ounces".
        var j = qtyEnd;
        if (tokens[j] === ',' && !used[j]) j++;
        var nextAttached = j < tokens.length && !used[j] ? splitAttachedUnit(tokens[j]) : null;
        var nextNumber = j < tokens.length && !used[j] ? scanNumber(tokens[j]) : null;
        if (nextAttached) {
          size = nextAttached.number + ' ' + nextAttached.unit;
          qtyEnd = j + 1;
        } else if (nextNumber !== null) {
          var sizeUnit = j + 1 < tokens.length && !used[j + 1] ? normalizeUnit(tokens[j + 1]) : null;
          size = nextNumber + (sizeUnit ? ' ' + sizeUnit : '');
          qtyEnd = sizeUnit ? j + 2 : j + 1;
        } else if (qtyEnd < tokens.length && !used[qtyEnd] && tokens[qtyEnd] !== ',') {
          unit = normalizeUnit(tokens[qtyEnd]);
          // An unrecognized word is still taken as the unit when it's the
          // last thing left ("yogurt 4 tubs") - otherwise it's notes.
          var isLast = true;
          for (var k = qtyEnd + 1; k < tokens.length; k++) {
            if (!used[k] && tokens[k] !== ',') isLast = false;
          }
          if (!unit && isLast) unit = tokens[qtyEnd];
          if (unit) qtyEnd++;
        }
      }

      if (size) {
        if (result.quantity === null) result.quantity = number;
        if (!sizeResult.size) result.unit = size;
      } else if (result.quantity === null) {
        result.quantity = number;
        if (unit && !result.unit) result.unit = unit;
      } else if (!result.unit) {
        // "quantity 1, 5 pounds" - the count was already given, so this
        // number is the size.
        result.unit = number + (unit ? ' ' + unit : '');
      }
      for (var u = qtyStart; u < qtyEnd; u++) used[u] = true;
    }

    // The name is everything before the quantity. Commas don't end it -
    // dictation drops them inside product names ("Lesser evil, Himalayan
    // pink salt popcorn").
    var nameEnd = qtyStart === -1 ? tokens.length : qtyStart;
    var before = [];
    var after = [];
    tokens.forEach(function (tok, idx) {
      if (used[idx] || tok === ',') return;
      if (idx < nameEnd) before.push(tok);
      else after.push(tok);
    });
    result.name = before.join(' ');
    result.notes = after.join(' ');
    if (!result.name) {
      // "2 gallons milk" - nothing before the quantity, so what follows is
      // the name rather than notes.
      result.name = result.notes;
      result.notes = '';
    }
    result.name = result.name.trim();
    result.notes = result.notes.trim();
    result.unit = String(result.unit).trim();

    return result;
  }
  // Pre-fills the purchase form from a parsed quick-add line and opens the
  // sheet for review - mirrors fillFormFromItem's "pre-fill, don't submit"
  // behavior, but only touches fields the parser actually found something
  // for, leaving the rest as the user last left them. Auto-expands "More
  // fields" whenever the parser populated something living in that section,
  // so a parsed tag/date/note isn't silently hidden from view.
  function fillFormFromQuickAdd(parsed) {
    openSheet();
    setAddMode();
    document.getElementById('f-name').value = parsed.name;
    if (parsed.quantity !== null) document.getElementById('f-quantity').value = parsed.quantity;
    if (parsed.unit) document.getElementById('f-unit').value = parsed.unit;
    if (parsed.location) {
      document.getElementById('f-location-select').value = parsed.location;
      document.getElementById('f-location-new').classList.add('hidden');
    }
    var touchedMoreFields = false;
    if (parsed.tag) {
      document.getElementById('f-tag-select').value = parsed.tag;
      document.getElementById('f-tag-new').classList.add('hidden');
      touchedMoreFields = true;
    }
    if (parsed.expiration) {
      document.getElementById('f-expiration').value = parsed.expiration;
      touchedMoreFields = true;
    }
    if (parsed.notes) {
      document.getElementById('f-notes').value = parsed.notes;
      touchedMoreFields = true;
    }
    if (touchedMoreFields) expandMoreFields();
    document.getElementById('f-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('f-name').focus();
  }

  // Which item (if any) the purchase sheet is currently editing, rather than
  // logging a new purchase - null in "add" mode. editingTrackingMode tracks
  // that item's tracking mode so submit knows whether to send quantity/unit
  // or fill_percent (the compact form only shows one set of inputs).
  var editingItemId = null;
  var editingTrackingMode = null;

  // Restores the sheet to its default "log a new purchase" mode: quantity/
  // unit visible, no fill %, title and button text reset. Does not touch
  // field values - callers that are about to fill the form (quick-add, Buy
  // again) call this first so they don't inherit a stale edit target.
  function setAddMode() {
    editingItemId = null;
    editingTrackingMode = null;
    document.getElementById('f-quantity').classList.remove('hidden');
    document.getElementById('f-unit').classList.remove('hidden');
    document.getElementById('f-fillpercent').classList.add('hidden');
    document.querySelector('#itemSheet h2').textContent = 'Log a purchase';
    document.querySelector('#itemForm .save-btn').textContent = 'Add item';
  }

  // Full reset for opening a blank form (the "+" button, and after a
  // successful add/save) - clears every field on top of setAddMode's mode
  // reset.
  function resetItemForm() {
    document.getElementById('itemForm').reset();
    document.getElementById('f-category').value = 'perishable';
    document.getElementById('f-location-new').classList.add('hidden');
    document.getElementById('f-tag-new').classList.add('hidden');
    document.getElementById('moreFields').hidden = true;
    setDefaultPurchaseDate();
    setAddMode();
  }

  // Opens the same purchase sheet used for adding, pre-filled with every
  // editable field on `item`, and switches submit to PATCH that item
  // instead of POSTing a new one. This is the "Edit" action from the
  // overflow menu - bringing up the full add form (rather than a separate
  // inline editor) means every field is reachable through controls that
  // already work correctly (location/tag pickers, date inputs, etc).
  function startEdit(item) {
    openSheet();
    editingItemId = item.id;
    editingTrackingMode = item.tracking_mode;

    document.getElementById('f-name').value = (item.name || '').trim();
    document.getElementById('f-category').value = item.category;
    document.getElementById('f-location-select').value = item.location;
    document.getElementById('f-location-new').classList.add('hidden');
    document.getElementById('f-tag-select').value = item.tag || '';
    document.getElementById('f-tag-new').classList.add('hidden');
    document.getElementById('f-purchase').value = item.purchase_date || '';
    document.getElementById('f-expiration').value = item.expiration_date || '';
    document.getElementById('f-notes').value = item.notes || '';

    if (item.tracking_mode === 'fill_level') {
      document.getElementById('f-quantity').classList.add('hidden');
      document.getElementById('f-unit').classList.add('hidden');
      document.getElementById('f-fillpercent').classList.remove('hidden');
      document.getElementById('f-fillpercent').value = item.fill_percent != null ? item.fill_percent : 100;
    } else {
      document.getElementById('f-quantity').classList.remove('hidden');
      document.getElementById('f-unit').classList.remove('hidden');
      document.getElementById('f-fillpercent').classList.add('hidden');
      document.getElementById('f-quantity').value = item.quantity;
      document.getElementById('f-unit').value = item.unit || '';
    }

    document.querySelector('#itemSheet h2').textContent = 'Edit item';
    document.querySelector('#itemForm .save-btn').textContent = 'Save changes';
    expandMoreFields();
    document.getElementById('itemSheet').scrollIntoView({ behavior: 'smooth' });
    document.getElementById('f-name').focus();
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

  // Builds the quantity display + -/+ stepper for an item row. Fill-level
  // items get a percentage track stacked below the button row rather than
  // squeezed beside it, so the buttons stay the same fixed width (and line
  // up in the same column) whether the row is fill- or count-tracked.
  function buildStepper(item) {
    var wrap = document.createElement('div');
    wrap.className = 'stepper-wrap';

    var stepper = document.createElement('div');
    stepper.className = 'stepper';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.textContent = '−';
    minusBtn.title = item.tracking_mode === 'fill_level' ? '-10%' : '-1';

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.textContent = '+';
    plusBtn.title = item.tracking_mode === 'fill_level' ? '+10%' : '+1';

    if (item.status === 'active') {
      minusBtn.addEventListener('click', function () { quickAdjust(item, -1); });
      plusBtn.addEventListener('click', function () { quickAdjust(item, 1); });
    } else {
      minusBtn.disabled = true;
      plusBtn.disabled = true;
    }

    stepper.appendChild(minusBtn);
    stepper.appendChild(plusBtn);
    wrap.appendChild(stepper);

    // Value sits on its own full-width line below the buttons rather than
    // squeezed between them - a long "quantity + unit" combo (e.g.
    // "2 gallon") has nowhere near enough room in that gap and gets
    // truncated, while the full stepper-wrap width comfortably fits it.
    var qtyVal = document.createElement('div');
    qtyVal.className = 'qty-val';
    qtyVal.textContent = item.tracking_mode === 'fill_level'
      ? (item.fill_percent != null ? item.fill_percent : 100) + '%'
      : item.quantity + (item.unit ? ' ' + item.unit : '');
    wrap.appendChild(qtyVal);

    var track = null;
    if (item.tracking_mode === 'fill_level') {
      track = document.createElement('div');
      track.className = 'fill-track';
      var bar = document.createElement('div');
      bar.className = 'fill-bar';
      bar.style.width = (item.fill_percent != null ? item.fill_percent : 100) + '%';
      track.appendChild(bar);
      wrap.appendChild(track);
    }

    if (item.status === 'active') {
      qtyVal.classList.add('editable');
      qtyVal.setAttribute('role', 'button');
      qtyVal.tabIndex = 0;
      qtyVal.title = 'Tap to set how much is left';
      qtyVal.addEventListener('click', function () { startQuickSet(item, qtyVal); });
      qtyVal.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          startQuickSet(item, qtyVal);
        }
      });
      if (track) {
        track.classList.add('editable');
        track.addEventListener('click', function () { startQuickSet(item, qtyVal); });
      }
    }

    return wrap;
  }

  // Quick set: tapping a row's amount swaps it for a number box to type
  // what's actually left ("3", "30%") - one action instead of tapping -
  // five or ten times to catch up on consumption that wasn't logged as it
  // happened. Saved as a single `recount` event (see PATCH /items/:id).
  // Done/Enter or tapping away saves, Escape cancels; 0 marks the item
  // consumed, the same way - does at the bottom of the range.
  function startQuickSet(item, qtyVal) {
    var isFill = item.tracking_mode === 'fill_level';
    var current = isFill ? (item.fill_percent != null ? item.fill_percent : 100) : item.quantity;

    var editor = document.createElement('div');
    editor.className = 'qty-edit';
    var input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = '0';
    if (isFill) input.max = '100';
    input.step = 'any';
    input.value = current;
    input.setAttribute('aria-label', 'How much "' + item.name + '" is left' + (isFill ? ' (%)' : item.unit ? ' (' + item.unit + ')' : ''));
    editor.appendChild(input);
    var suffix = isFill ? '%' : (item.unit || '');
    if (suffix) {
      var suffixSpan = document.createElement('span');
      suffixSpan.className = 'qty-edit-unit';
      suffixSpan.textContent = suffix;
      editor.appendChild(suffixSpan);
    }

    qtyVal.replaceWith(editor);
    input.focus();
    input.select();

    var finished = false;
    function cancel() {
      if (finished) return;
      finished = true;
      editor.replaceWith(qtyVal);
    }
    function save() {
      if (finished) return;
      var value = parseFloat(input.value);
      if (isNaN(value) || value === current) return cancel();
      if (value < 0 || (isFill && value > 100)) {
        finished = true;
        alert(isFill ? 'Enter a percentage from 0 to 100.' : 'Enter 0 or more.');
        editor.replaceWith(qtyVal);
        return;
      }
      finished = true;
      var request = value === 0
        ? apiFetch('/items/' + item.id + '/consume', { method: 'POST', body: JSON.stringify({}) })
        : apiFetch('/items/' + item.id, {
          method: 'PATCH',
          body: JSON.stringify(isFill ? { fill_percent: value, recount: true } : { quantity: value, recount: true }),
        });
      request.then(refresh).catch(function (err) {
        alert(err.message);
        refresh();
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
    input.addEventListener('blur', save);
  }

  function rowClass(item) {
    if (item.status !== 'active') return item.status;
    var d = daysUntil(item.expiration_date);
    if (d === null) return '';
    if (d < 0) return 'expired';
    if (d <= 3) return 'expiring-soon';
    return '';
  }

  // Closes any open row overflow menu - called before opening a new one,
  // and on any outside click.
  function closeOverflowMenus() {
    document.querySelectorAll('.overflow-menu').forEach(function (m) { m.remove(); });
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('.overflow-btn') || e.target.closest('.overflow-menu')) return;
    closeOverflowMenus();
  });

  // Builds the "⋯" menu of secondary actions for one row - everything that
  // used to be a row of buttons (throw out/consume/undo/edit/track mode/
  // buy again/delete), now tucked away so the row itself stays compact.
  function buildOverflowMenu(item, row) {
    var menu = document.createElement('div');
    menu.className = 'overflow-menu';

    function addAction(label, handler) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeOverflowMenus();
        handler();
      });
      menu.appendChild(btn);
    }

    if (item.status === 'active') {
      addAction('Throw out', function () {
        var body = promptQuantity(item, 'thrown out');
        if (body === null) return;
        apiFetch('/items/' + item.id + '/throw-out', { method: 'POST', body: JSON.stringify(body) })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
      addAction('Consumed', function () {
        var body = promptQuantity(item, 'consumed');
        if (body === null) return;
        apiFetch('/items/' + item.id + '/consume', { method: 'POST', body: JSON.stringify(body) })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
    }
    if (item.prev_status) {
      addAction('Undo', function () {
        apiFetch('/items/' + item.id + '/undo', { method: 'POST' })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
    }
    addAction('Edit', function () {
      startEdit(item);
    });
    if (item.tracking_mode === 'fill_level') {
      addAction('Track by count', function () {
        apiFetch('/items/' + item.id, { method: 'PATCH', body: JSON.stringify({ tracking_mode: 'count' }) })
          .then(refresh)
          .catch(function (err) { alert(err.message); });
      });
    } else {
      addAction('Track by fill level', function () {
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
    addAction('Buy again', function () { fillFormFromItem(item); });
    addAction('Delete', function () {
      if (confirm('Delete "' + item.name + '"?')) {
        apiFetch('/items/' + item.id, { method: 'DELETE' }).then(refresh);
      }
    });

    row.appendChild(menu);
    placeOverflowMenu(menu, row);
    return menu;
  }

  // Menus open downward by default, but near the bottom of the list that
  // runs them under the fixed quick-add bar (which sits above them) or off
  // the screen, leaving the last few actions untappable. Flip upward
  // whenever there's more room above the row than below it.
  function placeOverflowMenu(menu, row) {
    var bar = document.querySelector('.bottombar');
    var limit = window.innerHeight;
    if (bar && getComputedStyle(bar).position === 'fixed') limit = bar.getBoundingClientRect().top;
    var rowRect = row.getBoundingClientRect();
    var menuHeight = menu.getBoundingClientRect().height;
    var spaceBelow = limit - rowRect.bottom;
    var spaceAbove = rowRect.top;
    if (menuHeight + 8 > spaceBelow && spaceAbove > spaceBelow) menu.classList.add('open-up');
  }

  // Renders the relative-days expiry text used in a row's meta line, for
  // active items with an expiration date.
  function expiresText(item) {
    var d = daysUntil(item.expiration_date);
    if (d === null) return null;
    if (d < 0) return Math.abs(d) + (Math.abs(d) === 1 ? ' day ago' : ' days ago');
    if (d === 0) return 'expires today';
    return 'in ' + d + (d === 1 ? ' day' : ' days');
  }

  function buildItemRow(item, showLocation) {
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

    var metaParts = [];
    // In the flat view rows aren't under a location heading, so the row
    // itself has to say where the item is.
    if (showLocation) metaParts.push(item.location || '(no location)');
    metaParts.push(item.category);
    if (item.tag) metaParts.push(item.tag);
    if (item.status === 'active') {
      var expText = expiresText(item);
      if (expText) metaParts.push(expText);
    } else {
      metaParts.push(item.status);
    }
    var meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = metaParts.join(' · ');
    main.appendChild(meta);

    row.appendChild(main);
    row.appendChild(buildStepper(item));

    var overflowBtn = document.createElement('button');
    overflowBtn.type = 'button';
    overflowBtn.className = 'overflow-btn';
    overflowBtn.textContent = '⋯';
    overflowBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var existing = row.querySelector('.overflow-menu');
      if (existing) {
        existing.remove();
        return;
      }
      closeOverflowMenus();
      buildOverflowMenu(item, row);
    });
    row.appendChild(overflowBtn);

    return row;
  }

  // Persists which location groups are collapsed across re-renders (every
  // action re-fetches and re-renders the whole list).
  var collapsedGroups = {};

  // "grouped" (one collapsible section per location) or "flat" (every item
  // in one list, in the server's expiration-first order, for scanning
  // everything at once). Remembered per browser, like the theme.
  var viewMode = 'grouped';
  try {
    if (localStorage.getItem('listView') === 'flat') viewMode = 'flat';
  } catch (e) {}

  function renderItems(items) {
    var container = document.getElementById('itemGroups');
    container.innerHTML = '';

    if (viewMode === 'flat') {
      var flatRows = document.createElement('div');
      flatRows.className = 'rows';
      items.forEach(function (item) {
        flatRows.appendChild(buildItemRow(item, true));
      });
      container.appendChild(flatRows);
      return;
    }

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

  // Status chip state: all/active fetch from the server (see refresh());
  // soon/low reuse the already-active-filtered set and post-filter on data
  // already computed per item (rowClass/low_stock), no extra request needed.
  var statusChip = 'active';

  function matchesStatusChip(item) {
    if (statusChip === 'soon') return rowClass(item) === 'expiring-soon';
    if (statusChip === 'low') return !!item.low_stock;
    return true;
  }

  // Case-insensitive substring match across every field worth searching,
  // then a sort - both operate on the already-fetched item list client-side
  // rather than round-tripping to the server, since the full list is
  // already loaded for the status/location filters.
  function applyFiltersAndRender() {
    var filtered = lastItems.filter(matchesStatusChip);

    var query = document.getElementById('searchBox').value.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter(function (item) {
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
    updateResetFiltersVisibility();
  }

  // Shows the "Reset" button (next to the Filters toggle, visible
  // whether the panel is open or closed) whenever any of location/tag/
  // search/sort is non-default, so there's always a one-tap way back to
  // the unfiltered list without having to open the panel first.
  function updateResetFiltersVisibility() {
    var active = document.getElementById('filterLocation').value ||
      document.getElementById('filterTag').value ||
      document.getElementById('searchBox').value.trim() ||
      document.getElementById('sortBy').value;
    document.getElementById('resetFiltersBtn').hidden = !active;
  }

  function refresh() {
    var params = new URLSearchParams();
    if (statusChip !== 'all') {
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
    // Stray spaces before/after a typed or dictated value are stripped
    // here (the server strips them again, as a second line of defence).
    var payload = {
      name: document.getElementById('f-name').value.trim(),
      category: document.getElementById('f-category').value,
      location: currentFormLocation().trim(),
      tag: currentFormTag().trim(),
      purchase_date: document.getElementById('f-purchase').value || null,
      expiration_date: document.getElementById('f-expiration').value || null,
      notes: document.getElementById('f-notes').value.trim(),
    };
    if (!payload.name) {
      alert('Enter an item name.');
      return;
    }
    if (editingItemId && editingTrackingMode === 'fill_level') {
      var pct = parseFloat(document.getElementById('f-fillpercent').value);
      if (!(pct >= 0 && pct <= 100)) {
        alert('Fill % must be between 0 and 100.');
        return;
      }
      payload.fill_percent = pct;
    } else {
      payload.quantity = parseFloat(document.getElementById('f-quantity').value) || 1;
      payload.unit = document.getElementById('f-unit').value.trim();
    }

    var request = editingItemId
      ? apiFetch('/items/' + editingItemId, { method: 'PATCH', body: JSON.stringify(payload) })
      : apiFetch('/items', { method: 'POST', body: JSON.stringify(payload) });

    request.then(function () {
      resetItemForm();
      closeSheet();
      refresh();
    }).catch(function (err) {
      alert(err.message);
    });
  });

  function submitQuickAdd() {
    var input = document.getElementById('quickAddInput');
    var text = input.value.trim();
    if (!text) return false;
    fillFormFromQuickAdd(parseQuickAdd(text));
    input.value = '';
    return true;
  }

  document.getElementById('quickAddForm').addEventListener('submit', function (e) {
    e.preventDefault();
    submitQuickAdd();
  });

  // "+" doubles as "process whatever's dictated/typed into quick-add" - on
  // a phone keyboard, dictation often leaves text sitting in the field
  // without the user ever pressing Return, and tapping "+" would otherwise
  // silently discard it and open a blank form instead.
  document.getElementById('openSheetBtn').addEventListener('click', function () {
    if (submitQuickAdd()) return;
    resetItemForm();
    openSheet();
    document.getElementById('f-name').focus();
  });
  document.getElementById('closeSheetBtn').addEventListener('click', function () {
    resetItemForm();
    closeSheet();
  });

  // Generic disclosure toggles - "More fields" on the purchase form and
  // "Filters" above the list both just show/hide their target panel.
  document.querySelectorAll('[data-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-toggle'));
      if (target) target.hidden = !target.hidden;
    });
  });

  function syncViewToggle() {
    document.querySelectorAll('#viewToggle button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === viewMode);
    });
  }
  document.querySelectorAll('#viewToggle button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      viewMode = btn.getAttribute('data-view');
      try { localStorage.setItem('listView', viewMode); } catch (e) {}
      syncViewToggle();
      applyFiltersAndRender();
    });
  });
  syncViewToggle();

  document.querySelectorAll('#statusChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('#statusChips .chip').forEach(function (c) { c.classList.remove('active'); });
      chip.classList.add('active');
      statusChip = chip.getAttribute('data-filter');
      refresh();
    });
  });

  document.getElementById('filterLocation').addEventListener('change', refresh);
  document.getElementById('filterTag').addEventListener('change', refresh);
  document.getElementById('searchBox').addEventListener('input', applyFiltersAndRender);
  document.getElementById('sortBy').addEventListener('change', applyFiltersAndRender);

  document.getElementById('resetFiltersBtn').addEventListener('click', function () {
    document.getElementById('filterLocation').value = '';
    document.getElementById('filterTag').value = '';
    document.getElementById('searchBox').value = '';
    document.getElementById('sortBy').value = '';
    refresh();
  });

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
