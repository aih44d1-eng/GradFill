/* GradFill — setup page controller. */

/* ---- bounded lists (country / state / degree level) ----
   Reduces free-text typo risk feeding straight into GradFill's matching
   engine later — a country spelled two different ways across records is
   exactly the kind of thing that silently breaks a match downstream. */

var COUNTRIES = (function () {
  var list = ["Afghanistan","Albania","Algeria","Angola","Argentina","Armenia","Australia","Austria","Azerbaijan","Bahrain","Bangladesh","Belarus","Belgium","Bosnia & Herzegovina","Botswana","Brazil","Brunei","Bulgaria","Cambodia","Cameroon","Canada","Chile","China","Colombia","Côte d’Ivoire","Croatia","Cyprus","Czechia","Denmark","Egypt","Estonia","Ethiopia","Fiji","Finland","France","Georgia","Germany","Ghana","Greece","Hong Kong SAR China","Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Japan","Jordan","Kazakhstan","Kenya","Kuwait","Laos","Latvia","Lebanon","Libya","Lithuania","Luxembourg","Macao SAR China","Madagascar","Malawi","Malaysia","Malta","Mauritius","Mexico","Moldova","Mongolia","Morocco","Mozambique","Myanmar (Burma)","Namibia","Nepal","Netherlands","New Zealand","Nigeria","North Macedonia","Norway","Oman","Pakistan","Papua New Guinea","Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda","Samoa","Saudi Arabia","Senegal","Serbia","Seychelles","Singapore","Slovakia","Slovenia","Solomon Islands","South Africa","South Korea","Spain","Sri Lanka","Sudan","Sweden","Switzerland","Taiwan","Tanzania","Thailand","Tonga","Tunisia","Türkiye","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States","Uzbekistan","Vanuatu","Vietnam","Zambia","Zimbabwe"];
  // Pinned first: overwhelmingly the common cases for GradFill's actual
  // user base (Australian graduate applicants, some studying/working
  // abroad or applying to NZ/UK/US/Canada/Singapore roles).
  var pinned = ["Australia", "New Zealand", "United Kingdom", "United States", "Canada", "Singapore"];
  return pinned.concat(list.filter(function (c) { return pinned.indexOf(c) === -1; }));
})();

var AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
var AU_STATE_FULL_TO_ABBR = {
  "new south wales": "NSW", "victoria": "VIC", "queensland": "QLD", "western australia": "WA",
  "south australia": "SA", "tasmania": "TAS", "australian capital territory": "ACT", "northern territory": "NT"
};

var DEGREE_LEVELS = [
  "High School", "Certificate I", "Certificate II", "Certificate III", "Certificate IV",
  "Diploma", "Advanced Diploma", "Associate Degree", "Bachelor Degree", "Bachelor Honours",
  "Graduate Certificate", "Graduate Diploma", "Master Degree", "Doctoral Degree (PhD)", "Other"
];

/* ---- bundled university dataset (Hipolabs university-domains-list,
   trimmed to name/country/state — see universities.json). Local lookup,
   no network call, no per-keystroke cost. Loaded async at boot; the
   institution field degrades to a plain text input until this resolves,
   which is fast (~600KB local file). */
var UNIVERSITIES = [];
fetch(chrome.runtime.getURL("universities.json"))
  .then(function (r) { return r.json(); })
  .then(function (list) { UNIVERSITIES = list || []; })
  .catch(function () { UNIVERSITIES = []; });

function searchUniversities(query, limit) {
  var q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  var out = [];
  for (var i = 0; i < UNIVERSITIES.length && out.length < (limit || 8); i++) {
    if (UNIVERSITIES[i].n.toLowerCase().indexOf(q) > -1) out.push(UNIVERSITIES[i]);
  }
  return out;
}

/* ---- reusable suggestion combobox ----
   Used for both address (server-backed, debounced) and university
   (local, instant) — same interaction shape, different data source.
   Keyboard: Up/Down to move, Enter to choose, Escape to dismiss. */
function attachCombobox(inputEl, opts) {
  var wrap = inputEl.closest("label") || inputEl.parentElement;
  wrap.style.position = wrap.style.position || "relative";
  var dropdown = document.createElement("div");
  dropdown.className = "suggest-dropdown";
  dropdown.hidden = true;
  wrap.appendChild(dropdown);

  inputEl.setAttribute("autocomplete", "off");
  inputEl.setAttribute("role", "combobox");
  inputEl.setAttribute("aria-expanded", "false");
  inputEl.setAttribute("aria-autocomplete", "list");

  var items = [], activeIndex = -1, debTimer = null, reqId = 0;

  function render() {
    dropdown.innerHTML = "";
    if (!items.length) { dropdown.hidden = true; inputEl.setAttribute("aria-expanded", "false"); return; }
    items.forEach(function (item, i) {
      var row = document.createElement("div");
      row.className = "suggest-item" + (i === activeIndex ? " active" : "");
      row.setAttribute("role", "option");
      row.textContent = item.label;
      row.addEventListener("mousedown", function (e) { e.preventDefault(); choose(i); });
      dropdown.appendChild(row);
    });
    dropdown.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
  }

  function close() { items = []; activeIndex = -1; render(); }

  function choose(i) {
    var item = items[i];
    close();
    if (item) opts.onSelect(item);
  }

  inputEl.addEventListener("input", function () {
    clearTimeout(debTimer);
    var q = inputEl.value;
    if (q.trim().length < (opts.minChars || 2)) { close(); return; }
    var myReq = ++reqId;
    debTimer = setTimeout(function () {
      Promise.resolve(opts.fetchSuggestions(q)).then(function (res) {
        if (myReq !== reqId) return; // a newer keystroke already superseded this request
        items = res || []; activeIndex = -1; render();
      });
    }, opts.debounceMs != null ? opts.debounceMs : 300);
  });

  inputEl.addEventListener("keydown", function (e) {
    if (dropdown.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(items.length - 1, activeIndex + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); render(); }
    else if (e.key === "Enter") { if (activeIndex > -1) { e.preventDefault(); choose(activeIndex); } }
    else if (e.key === "Escape") { close(); }
  });

  inputEl.addEventListener("blur", function () { setTimeout(close, 120); });
}

var EMPTY = {
  personal: { salutation: "", firstName: "", middleName: "", lastName: "", preferredName: "", dob: "", email: "", phone: "", phoneType: "Mobile",
    houseNumber: "", streetName: "", addressLine1: "", suburb: "", state: "", postcode: "", country: "Australia",
    linkedin: "", github: "", portfolio: "" },
  eligibility: { citizenship: "", workRights: "", securityClearance: "", driversLicence: "",
    indigenousStatus: "", gender: "", disability: "",
    pronouns: "", lgbtqia: "", culturallyDiverse: "", firstInFamily: "", minorityGroup: "" },
  education: [], experience: [], skills: [], languages: [], referees: [], starBank: [], applications: [],
  tags: {
    programs: { items: [], other: [], none: false },
    leadership: { items: [], other: [], none: false },
    extracurricular: { items: [], other: [], none: false },
    industries: { items: [], other: [], none: false }
  },
  preferences: { availability: "", salaryExpectation: "", noticePeriod: "", relocate: "", teamStream: "" },
  custom: [], resumeVersions: [], answerLibrary: [], fieldMemory: [], gapDashboard: [], resume: null, academicRecord: null
};

/* Shape of each repeatable card. */
var LISTS = {
  education: {
    mount: "educationList",
    fields: [
      { k: "institution", l: "Institution", w: true, t: "university" },
      { k: "degree", l: "Degree", w: true },
      { k: "major", l: "Major or field of study" },
      { k: "levelLabel", l: "Level / qualification type", t: "select", opts: DEGREE_LEVELS },
      { k: "educationType", l: "Type of education", ph: "Academic / Vocational / School" },
      { k: "institutionType", l: "Type of school / institution", ph: "University / TAFE / Secondary School" },
      { k: "location", l: "Institution location", ph: "Sydney, NSW" },
      { k: "country", l: "Institution country", t: "select", opts: COUNTRIES, noPlaceholder: true },
      { k: "wam", l: "WAM" },
      { k: "gpa", l: "GPA" },
      { k: "startDate", l: "Started", t: "month" },
      { k: "expectedGraduation", l: "Finishing (expected)", t: "month" },
      { k: "completed", l: "Finished — I've already graduated from this one", t: "checkbox", w: true }
    ]
  },
  experience: {
    mount: "experienceList",
    fields: [
      { k: "title", l: "Role title" },
      { k: "employer", l: "Employer" },
      { k: "businessType", l: "Type of business / industry (ATS category)", ph: "e.g. Information Technology / Energy / Banking" },
      { k: "businessDescription", l: "Business description / specialty", ph: "e.g. Cybersecurity consulting" },
      { k: "location", l: "Location", ph: "Sydney, NSW" },
      { k: "country", l: "Country for this role", t: "select", opts: COUNTRIES, noPlaceholder: true },
      { k: "startDate", l: "Started", t: "month" },
      { k: "endDate", l: "Ended", t: "month" },
      { k: "current", l: "I still work here", t: "checkbox" },
      { k: "description", l: "What you did", t: "textarea", w: true }
    ]
  },
  languages: {
    mount: "languagesList",
    fields: [
      { k: "language", l: "Language" },
      { k: "spoken", l: "Spoken", ph: "Native / Fluent / Conversational" },
      { k: "written", l: "Written", ph: "Native / Fluent / Conversational" },
      { k: "reading", l: "Reading", ph: "Leave blank to reuse Written" }
    ]
  },
  referees: {
    mount: "refereesList",
    fields: [
      { k: "name", l: "Name" },
      { k: "title", l: "Their job title" },
      { k: "org", l: "Organisation" },
      { k: "relationship", l: "How they know you" },
      { k: "email", l: "Email" },
      { k: "phone", l: "Phone" }
    ]
  },
  applications: {
    mount: "applicationsList",
    fields: [
      { k: "status", l: "Status", t: "select", noPlaceholder: true,
        opts: ["Saved", "Applying", "Applied", "Assessment", "Interview", "Offer", "Rejected", "Withdrawn"] },
      { k: "company", l: "Company", w: true },
      { k: "role", l: "Role" },
      { k: "location", l: "Location" },
      { k: "employmentType", l: "Employment type" },
      { k: "date", l: "Date applied", t: "month" },
      { k: "closes", l: "Applications close", ph: "Optional" },
      { k: "source", l: "Found via", ph: "LinkedIn / Seek / company website" },
      { k: "link", l: "Job or application link", ph: "https://...", w: true, t: "url" },
      { k: "keySkills", l: "Key / matched skills", t: "textarea",
        ph: "Skills worth emphasizing for this role", w: true },
      { k: "resumeUsed", l: "Resume used", ph: "e.g. Cyber Graduate v2", w: true },
      { k: "notes", l: "Notes", t: "textarea",
        ph: "Contacts, follow-up, interview notes, what stood out", w: true },
      { k: "jobDescription", l: "Job description snapshot", t: "textarea",
        ph: "Captured from the job page when available", w: true }
    ]
  },
  starBank: {
    mount: "starBankList",
    fields: [
      { k: "tag", l: "What it shows", w: true, ph: "teamwork / problem solving / leadership" },
      { k: "situation", l: "Situation", t: "textarea", w: true },
      { k: "task", l: "Task", t: "textarea", w: true },
      { k: "action", l: "Action", t: "textarea", w: true },
      { k: "result", l: "Result", t: "textarea", w: true }
    ]
  },
  custom: {
    mount: "customList",
    fields: [
      { k: "match", l: "Word from the question", ph: "notice period" },
      { k: "value", l: "Your answer", ph: "Four weeks" }
    ]
  }
};

var profile = null;
var saveTimer = null;

function $(id) { return document.getElementById(id); }

function deepGet(o, path) {
  return path.split(".").reduce(function (a, k) { return a == null ? undefined : a[k]; }, o);
}

function deepSet(o, path, v) {
  var parts = path.split(".");
  var last = parts.pop();
  var t = parts.reduce(function (a, k) { return (a[k] = a[k] || {}); }, o);
  t[last] = v;
}

function save() {
  var pill = $("saved");
  pill.hidden = false;
  pill.textContent = "Saving…";
  pill.classList.remove("flash");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    chrome.storage.local.set({ profile: profile }, function () {
      // Deliberately stays visible (not re-hidden) once shown once —
      // "some visible confirmation a save actually happened, and that
      // data persists" reads as an ongoing state, not a thing that
      // flickers past before you notice it.
      pill.textContent = "Saved";
      pill.classList.add("flash");
      clearTimeout(save._p);
      save._p = setTimeout(function () { pill.classList.remove("flash"); }, 900);
    });
  }, 350);
}

/* ---- address normalization ---- */

function parseStreetAddress(line) {
  var m = /^\s*([0-9]+[A-Za-z]?(?:\s*[-/]\s*[0-9]+[A-Za-z]?)?)\s+(.+?)\s*$/.exec(String(line || ""));
  return m ? { houseNumber: m[1].replace(/\s+/g, ""), streetName: m[2].trim() } : null;
}

function syncStreetAddress(changedPath) {
  profile.personal = profile.personal || {};
  var p = profile.personal;
  if (changedPath === "personal.houseNumber" || changedPath === "personal.streetName") {
    p.addressLine1 = [p.houseNumber, p.streetName].filter(Boolean).join(" ").trim();
    var full = document.querySelector('[data-bind="personal.addressLine1"]');
    if (full) full.value = p.addressLine1;
  } else if (changedPath === "personal.addressLine1") {
    var parsed = parseStreetAddress(p.addressLine1);
    if (parsed) {
      p.houseNumber = parsed.houseNumber; p.streetName = parsed.streetName;
      var hn = document.querySelector('[data-bind="personal.houseNumber"]');
      var sn = document.querySelector('[data-bind="personal.streetName"]');
      if (hn) hn.value = p.houseNumber;
      if (sn) sn.value = p.streetName;
    }
  }
}

/* ---- static country selects (About you + Application essentials both
   bind personal.country — kept as two convenience entry points to the
   same fact, per the existing essentials-section design) ---- */

function populateCountrySelects() {
  document.querySelectorAll('select[data-bind="personal.country"]').forEach(function (sel) {
    COUNTRIES.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
  });
}

/* State/territory: an AU-state dropdown covers the overwhelming common
   case for this product's actual users without inviting a typo ("Victoria"
   vs "VIC" vs "vic" no longer able to diverge) — but plenty of real
   addresses (overseas study, overseas roles) aren't an Australian state at
   all, so "Other" reveals a plain text fallback rather than forcing a
   wrong answer into a bounded list that doesn't fit. */
function wireStateField() {
  var sel = $("personalState");
  var otherWrap = $("personalStateOtherWrap");
  var otherInput = $("personalStateOther");
  if (!sel) return;

  // A blank placeholder as the actual first option — otherwise a browser
  // defaults an unset <select> to displaying its first real option (NSW),
  // which would show every never-touched profile as if NSW had been
  // explicitly chosen, even though nothing had actually been written yet.
  var blank = document.createElement("option");
  blank.value = ""; blank.textContent = "Select…";
  sel.appendChild(blank);
  AU_STATES.forEach(function (s) {
    var o = document.createElement("option"); o.value = s; o.textContent = s; sel.appendChild(o);
  });
  var otherOpt = document.createElement("option");
  otherOpt.value = "__other__"; otherOpt.textContent = "Other (type it in)";
  sel.appendChild(otherOpt);

  var current = profile.personal.state || "";
  var normalized = AU_STATE_FULL_TO_ABBR[current.toLowerCase()] || current;
  if (AU_STATES.indexOf(normalized) > -1) {
    sel.value = normalized;
    if (normalized !== current) { profile.personal.state = normalized; save(); }
  } else if (current) {
    sel.value = "__other__";
    otherWrap.hidden = false;
    otherInput.value = current;
  }

  sel.addEventListener("change", function () {
    if (sel.value === "__other__") {
      otherWrap.hidden = false;
      otherInput.focus();
      profile.personal.state = otherInput.value || "";
    } else {
      otherWrap.hidden = true;
      profile.personal.state = sel.value;
    }
    save();
  });
  otherInput.addEventListener("input", function () {
    profile.personal.state = otherInput.value;
    save();
  });
}

/* Re-applies profile.personal.* into the address-related fields after a
   Places selection writes several at once programmatically (the fields'
   own input listeners only fire for the field the user actually typed
   into). */
function refreshAddressFields() {
  ["addressLine1", "suburb", "postcode"].forEach(function (k) {
    var el = document.querySelector('[data-bind="personal.' + k + '"]');
    if (el) el.value = profile.personal[k] || "";
  });
  document.querySelectorAll('select[data-bind="personal.country"]').forEach(function (sel) {
    sel.value = profile.personal.country || "Australia";
  });
  var sel = $("personalState"), otherWrap = $("personalStateOtherWrap"), otherInput = $("personalStateOther");
  if (sel) {
    var current = profile.personal.state || "";
    var normalized = AU_STATE_FULL_TO_ABBR[current.toLowerCase()] || current;
    if (AU_STATES.indexOf(normalized) > -1) { sel.value = normalized; otherWrap.hidden = true; }
    else if (current) { sel.value = "__other__"; otherWrap.hidden = false; otherInput.value = current; }
  }
  runValidation();
}

/* ---- address autocomplete (server-proxied — see cloud.js/server) ---- */

function wireAddressAutocomplete() {
  var addrInput = document.querySelector('[data-bind="personal.addressLine1"]');
  if (!addrInput) return;
  var sessionToken = null;
  function token() { return sessionToken || (sessionToken = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))); }

  attachCombobox(addrInput, {
    minChars: 4, debounceMs: 350,
    fetchSuggestions: function (q) {
      return GFCloud.placesAutocomplete(q, token()).then(function (res) {
        return (res.predictions || []).map(function (p) { return { label: p.description, placeId: p.placeId }; });
      });
    },
    onSelect: function (picked) {
      addrInput.value = picked.label;
      var usedToken = token();
      sessionToken = null; // a new session starts on the next address lookup, per Google's billing guidance
      GFCloud.placesDetails(picked.placeId, usedToken).then(function (res) {
        var a = res.address;
        if (!a) return;
        var p = profile.personal;
        p.addressLine1 = a.addressLine1 || addrInput.value;
        if (a.suburb) p.suburb = a.suburb;
        if (a.state) p.state = a.state;
        if (a.postcode) p.postcode = a.postcode;
        if (a.country) p.country = a.country;
        var parsed = parseStreetAddress(p.addressLine1);
        if (parsed) { p.houseNumber = parsed.houseNumber; p.streetName = parsed.streetName; }
        save();
        refreshAddressFields();
      });
    }
  });
}

/* ---- simple bound inputs ---- */

function bindSimple() {
  document.querySelectorAll("[data-bind]").forEach(function (el) {
    var path = el.dataset.bind;
    var v = deepGet(profile, path);

    if (path === "skills") {
      el.value = (v || []).join(", ");
      el.addEventListener("input", function () {
        profile.skills = el.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        save();
      });
      return;
    }

    el.value = v == null ? "" : v;
    el.addEventListener("input", function () { deepSet(profile, path, el.value); if (/^personal\.(houseNumber|streetName|addressLine1)$/.test(path)) syncStreetAddress(path); save(); });
  });
}

/* ---- university autofill ----
   Selecting a real university from the bundled dataset fills country
   (and, where the dataset has it, state/territory into the free-text
   location field) instead of asking for those separately. Re-renders
   the whole education list on select so the row's other fields (country
   select, location text) pick up the new values immediately. */
function attachUniversityCombobox(inputEl, item, listName) {
  attachCombobox(inputEl, {
    minChars: 2, debounceMs: 120, // local lookup, no network cost to debounce hard against
    fetchSuggestions: function (q) {
      return searchUniversities(q).map(function (u) {
        return { label: u.n + " — " + u.c, name: u.n, country: u.c, state: u.s };
      });
    },
    onSelect: function (picked) {
      item.institution = picked.name;
      item.country = picked.country;
      if (picked.state && !item.location) item.location = picked.state;
      save();
      renderList(listName);
      renderEssentials();
    }
  });
}

/* ---- repeatable cards ---- */

function renderList(name) {
  var spec = LISTS[name];
  var mount = $(spec.mount);
  mount.innerHTML = "";

  (profile[name] || []).forEach(function (item, i) {
    var card = document.createElement("div");
    card.className = "card";

    var drop = document.createElement("button");
    drop.className = "card-drop";
    drop.textContent = "Remove";
    drop.addEventListener("click", function () {
      profile[name].splice(i, 1);
      save();
      renderList(name);
      if (name === "experience" || name === "languages") renderEssentials();
    });
    card.appendChild(drop);

    if (name === "applications") {
      var summary = document.createElement("p");
      summary.className = "note";
      summary.style.margin = "0 0 10px";
      var bits = [];
      if (item.role) bits.push(item.role);
      if (item.company) bits.push("at " + item.company);
      if (item.status) bits.unshift("[" + item.status + "]");
      if (item.date) bits.push("\u2014 " + item.date);
      summary.textContent = bits.length ? bits.join(" ") : "New application";
      if (item.link) {
        var a = document.createElement("a");
        a.href = item.link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = " (open)";
        a.style.marginLeft = "6px";
        summary.appendChild(a);
      }
      card.appendChild(summary);
    }

    var grid = document.createElement("div");
    grid.className = "grid";

    spec.fields.forEach(function (f) {
      var lab = document.createElement("label");
      if (f.w) lab.classList.add("wide");

      var input;
      if (f.t === "textarea") {
        input = document.createElement("textarea");
        input.rows = f.k === "situation" || f.k === "description" || f.k === "jobDescription" ? 3 : 2;
      } else if (f.t === "select") {
        input = document.createElement("select");
        // A field the user hasn't touched yet should stay genuinely
        // blank — defaulting a fresh record's Degree Level to "High
        // School" just because it's opts[0] would silently write a
        // wrong fact into the profile. Only fields that already have a
        // sensible universal default (Country -> Australia, matching
        // EMPTY.personal.country) skip the placeholder.
        if (!f.noPlaceholder) {
          var ph = document.createElement("option");
          ph.value = ""; ph.textContent = "Select…";
          input.appendChild(ph);
        }
        (f.opts || []).forEach(function (opt) {
          var o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        });
      } else if (f.t === "university") {
        input = document.createElement("input");
        input.type = "text";
      } else if (f.t === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        lab.classList.add("check-line");
      } else {
        input = document.createElement("input");
        input.type = f.t || "text";
      }
      if (f.ph) input.placeholder = f.ph;

      if (f.t === "checkbox") {
        input.checked = !!item[f.k];
        lab.appendChild(input);
        lab.appendChild(document.createTextNode(f.l));
        input.addEventListener("change", function () {
          item[f.k] = input.checked;
          save();
          if (name === "education") renderList(name);
        });
      } else {
        input.value = item[f.k] || (f.t === "select" && f.noPlaceholder ? (f.opts && f.opts[0]) || "" : "");
        if (f.t === "select" && f.noPlaceholder && !item[f.k]) item[f.k] = input.value;
        lab.appendChild(document.createTextNode(f.l));
        lab.appendChild(input);
        input.addEventListener(f.t === "select" ? "change" : "input", function () {
          item[f.k] = input.value;
          save();
          if (name === "applications" && f.k === "status") renderList(name);
          if (name === "experience" || name === "languages") renderEssentials();
        });
        if (f.t === "university") attachUniversityCombobox(input, item, name);
      }

      grid.appendChild(lab);
    });

    card.appendChild(grid);

    if (name === "education" && !item.completed) {
      var flag = document.createElement("p");
      flag.className = "in-progress";
      flag.textContent = "In progress. Forms asking about graduation get your expected date, flagged for you to check.";
      card.appendChild(flag);
    }

    mount.appendChild(card);
  });
}

document.querySelectorAll("[data-add]").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var name = btn.dataset.add;
    profile[name] = profile[name] || [];
    profile[name].push({});
    save();
    renderList(name);
    if (name === "experience" || name === "languages") renderEssentials();
  });
});

/* ---- resume & academic record ---- */

function wireDocUpload(fileInputId, nameElId, profileKey) {
  $(fileInputId).addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      $(nameElId).textContent = "That file is over 4 MB — try a smaller PDF.";
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      profile[profileKey] = {
        name: file.name,
        type: file.type || "application/octet-stream",
        data: reader.result.split(",")[1]
      };
      save();
      showDoc(nameElId, profileKey);
    };
    reader.readAsDataURL(file);
  });
}

function showDoc(nameElId, profileKey) {
  $(nameElId).textContent = profile[profileKey]
    ? "Saved: " + profile[profileKey].name
    : "No file saved yet.";
}

function showResume() {
  showDoc("resumeName", "resume");
  showDoc("academicRecordName", "academicRecord");
}

function renderEssentials() {
  var workRoot = $("essentialBusinessTypes");
  var eduRoot = $("essentialEducation");
  var langRoot = $("essentialLanguages");
  if (workRoot) {
    workRoot.innerHTML = "";
    var jobs = profile.experience || [];
    if (!jobs.length) {
      var none = document.createElement("p"); none.className = "mini-note"; none.textContent = "No work experience saved yet."; workRoot.appendChild(none);
    }
    jobs.forEach(function (job, i) {
      var wrap = document.createElement("div"); wrap.style.marginTop = i ? "12px" : "8px";
      var title = document.createElement("p"); title.className = "mini-note"; title.style.margin = "0 0 4px";
      title.textContent = [job.title, job.employer].filter(Boolean).join(" — ") || ("Role " + (i + 1));
      var state = document.createElement("span");
      state.textContent = job.businessType ? "Confirmed" : "Needs confirmation";
      state.style.cssText = "display:inline-block;margin:0 0 6px;padding:2px 6px;border-radius:10px;font-size:10px;border:1px solid " + (job.businessType ? "#1f6f5c;color:#1f6f5c" : "#b45309;color:#b45309");
      wrap.appendChild(title); wrap.appendChild(state);
      var input = document.createElement("input"); input.type = "text"; input.value = (GF.canonicalBusinessType ? (GF.canonicalBusinessType(job) || job.businessType || "") : (job.businessType || ""));
      input.placeholder = "e.g. Information Technology / Energy / Banking";
      input.addEventListener("input", function () {
        job.businessType = input.value;
        state.textContent = input.value.trim() ? "Confirmed" : "Needs confirmation";
        state.style.borderColor = input.value.trim() ? "#1f6f5c" : "#b45309";
        state.style.color = input.value.trim() ? "#1f6f5c" : "#b45309";
        save();
      });
      wrap.appendChild(input);
      var descLab = document.createElement("label"); descLab.style.marginTop = "6px"; descLab.textContent = "Business description / specialty";
      var descInput = document.createElement("input"); descInput.type = "text"; descInput.value = job.businessDescription || ""; descInput.placeholder = "e.g. Cybersecurity consulting";
      descInput.addEventListener("input", function () { job.businessDescription = descInput.value; save(); });
      descLab.appendChild(descInput); wrap.appendChild(descLab);
      var countryLab = document.createElement("label"); countryLab.style.marginTop = "6px"; countryLab.textContent = "Country for this role";
      var countryInput = document.createElement("input"); countryInput.type = "text"; countryInput.value = job.country || (GF.inferCountryFromLocation ? (GF.inferCountryFromLocation(job.location) || "") : "");
      countryInput.placeholder = "Australia / United Arab Emirates";
      countryInput.addEventListener("input", function () { job.country = countryInput.value; save(); });
      countryLab.appendChild(countryInput); wrap.appendChild(countryLab);
      workRoot.appendChild(wrap);
    });
  }
  if (eduRoot) {
    eduRoot.innerHTML = "";
    var edus = profile.education || [];
    if (!edus.length) { var ne = document.createElement("p"); ne.className = "mini-note"; ne.textContent = "No education saved yet."; eduRoot.appendChild(ne); }
    edus.forEach(function (ed, i) {
      var box = document.createElement("div"); box.style.marginTop = i ? "14px" : "8px";
      var title = document.createElement("strong"); title.textContent = [ed.degree, ed.institution].filter(Boolean).join(" — ") || ("Education " + (i + 1)); title.style.display = "block"; title.style.marginBottom = "6px"; box.appendChild(title);
      [["Type of education","educationType", (GF.deriveEducationCategory ? GF.deriveEducationCategory(ed) : "")], ["Type of school / institution","institutionType", (GF.deriveInstitutionCategory ? GF.deriveInstitutionCategory(ed) : "")], ["Country","country", (GF.inferCountryFromLocation ? GF.inferCountryFromLocation(ed.location) : "")]].forEach(function (row) {
        var lab = document.createElement("label"); lab.style.marginTop = "6px"; lab.textContent = row[0];
        var input = document.createElement("input"); input.type = "text"; input.value = ed[row[1]] || row[2] || "";
        input.addEventListener("input", function () { ed[row[1]] = input.value; save(); });
        lab.appendChild(input); box.appendChild(lab);
      });
      eduRoot.appendChild(box);
    });
  }
  if (langRoot) {
    langRoot.innerHTML = "";
    var langs = profile.languages || [];
    if (!langs.length) {
      var noLang = document.createElement("p"); noLang.className = "mini-note"; noLang.textContent = "No languages saved yet."; langRoot.appendChild(noLang);
    }
    langs.forEach(function (lang, i) {
      var box = document.createElement("div"); box.style.marginTop = i ? "14px" : "8px";
      var name = document.createElement("strong"); name.textContent = lang.language || ("Language " + (i + 1));
      name.style.display = "block"; name.style.marginBottom = "6px"; box.appendChild(name);
      var complete = !!(lang.language && lang.spoken && lang.written && (lang.reading || lang.written));
      var state = document.createElement("span"); state.textContent = complete ? "Ready" : "Needs details";
      state.style.cssText = "display:inline-block;margin:0 0 6px;padding:2px 6px;border-radius:10px;font-size:10px;border:1px solid " + (complete ? "#1f6f5c;color:#1f6f5c" : "#b45309;color:#b45309");
      box.appendChild(state);
      [["Language","language"],["Spoken","spoken"],["Written","written"],["Reading","reading"]].forEach(function (pair) {
        var lab = document.createElement("label"); lab.style.marginTop = "6px"; lab.textContent = pair[0];
        var input = document.createElement("input"); input.type = "text"; input.value = lang[pair[1]] || "";
        input.placeholder = pair[1] === "language" ? "Urdu" : "e.g. 4 / 10, Fluent, Conversational";
        input.addEventListener("input", function () { lang[pair[1]] = input.value; if (pair[1] === "language") name.textContent = input.value || ("Language " + (i + 1)); save(); });
        lab.appendChild(input); box.appendChild(lab);
      });
      langRoot.appendChild(box);
    });
  }
}

wireDocUpload("resumeFile", "resumeName", "resume");
wireDocUpload("academicRecordFile", "academicRecordName", "academicRecord");

/* ---- inline validation ----
   Flags a malformed or missing required value the moment the person
   leaves the field, instead of only at save time (there is no explicit
   "save" moment here anyway — everything autosaves — so "only at save
   time" would in practice mean "never told at all"). */

function fieldError(el) {
  var v = el.value || "";
  if (el.dataset.required === "true" && !v.trim()) return "Required";
  if (el.dataset.validate === "email" && v.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return "Enter a valid email address";
  return "";
}

function wireValidation() {
  document.querySelectorAll("[data-required], [data-validate]").forEach(function (el) {
    if (el._gfCheck) return; // already wired (e.g. a re-render)
    var msg = document.createElement("p");
    msg.className = "field-error";
    msg.hidden = true;
    el.insertAdjacentElement("afterend", msg);
    function check() {
      var err = fieldError(el);
      el.classList.toggle("invalid", !!err);
      msg.textContent = err;
      msg.hidden = !err;
      return !err;
    }
    el.addEventListener("blur", check);
    el.addEventListener("input", function () { if (el.classList.contains("invalid")) check(); });
    el._gfCheck = check;
  });
}

function runValidation() {
  var allOk = true;
  document.querySelectorAll("[data-required], [data-validate]").forEach(function (el) {
    if (el._gfCheck && !el._gfCheck()) allOk = false;
  });
  return allOk;
}

/* ---- rail ---- */

function railSpy() {
  var links = Array.prototype.slice.call(document.querySelectorAll(".rail a"));
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) {
        a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id);
      });
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  document.querySelectorAll("main section").forEach(function (s) { obs.observe(s); });
}

/* ---- backup ---- */

$("export").addEventListener("click", function () {
  var copy = JSON.parse(JSON.stringify(profile));
  var blob = new Blob([JSON.stringify(copy, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gradfill-details-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  $("backupMsg").textContent = "Exported to your Downloads folder.";
});

$("import").addEventListener("click", function () { $("importFile").click(); });

$("importFile").addEventListener("change", function () {
  var file = this.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var incoming;
    try { incoming = JSON.parse(reader.result); }
    catch (e) { $("backupMsg").textContent = "That file isn't a GradFill backup."; return; }
    if (!incoming.personal) { $("backupMsg").textContent = "That file isn't a GradFill backup."; return; }
    if (!confirm("Replace everything currently saved with this file?")) return;
    profile = Object.assign(JSON.parse(JSON.stringify(EMPTY)), incoming);
    chrome.storage.local.set({ profile: profile }, function () { location.reload(); });
  };
  reader.readAsText(file);
});

/* ---- background tags ---- */

var TAG_LABELS = {
  programs: "Programs you've participated in",
  leadership: "Leadership experience",
  extracurricular: "Extracurricular activities",
  industries: "Industries you have work experience in"
};

function renderTags() {
  var root = $("tagsRoot");
  root.innerHTML = "";
  Object.keys(GF.TAG_OPTIONS).forEach(function (cat) {
    var t = profile.tags[cat];
    var box = document.createElement("div");
    box.className = "tag-group";
    box.style.marginBottom = "22px";

    var h = document.createElement("p");
    h.className = "note";
    h.style.fontWeight = "600";
    h.style.color = "var(--ink, #14202a)";
    h.textContent = TAG_LABELS[cat];
    box.appendChild(h);

    var grid = document.createElement("div");
    grid.className = "tag-grid";
    grid.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:8px 0";

    GF.TAG_OPTIONS[cat].forEach(function (opt) {
      var pill = document.createElement("label");
      pill.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;padding:5px 9px;border:1px solid #d1d5db;border-radius:14px;cursor:pointer";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = t.items.indexOf(opt) > -1;
      cb.addEventListener("change", function () {
        var i = t.items.indexOf(opt);
        if (cb.checked) { if (i === -1) t.items.push(opt); t.none = false; noneBox.checked = false; }
        else if (i > -1) { t.items.splice(i, 1); }
        save();
      });
      pill.appendChild(cb);
      pill.appendChild(document.createTextNode(opt));
      grid.appendChild(pill);
    });
    box.appendChild(grid);

    var otherRow = document.createElement("label");
    otherRow.className = "block";
    otherRow.style.marginTop = "6px";
    otherRow.innerHTML = "Other (comma separated)<br>";
    var otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.value = (t.other || []).join(", ");
    otherInput.placeholder = "Anything not listed above";
    otherInput.addEventListener("input", function () {
      t.other = otherInput.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      save();
    });
    otherRow.appendChild(otherInput);
    box.appendChild(otherRow);

    var noneRow = document.createElement("label");
    noneRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;color:var(--muted,#6b7671)";
    var noneBox = document.createElement("input");
    noneBox.type = "checkbox";
    noneBox.checked = t.none;
    noneBox.addEventListener("change", function () {
      t.none = noneBox.checked;
      if (t.none) {
        t.items = [];
        t.other = [];
        Array.prototype.forEach.call(grid.querySelectorAll("input"), function (c) { c.checked = false; });
        otherInput.value = "";
      }
      save();
    });
    noneRow.appendChild(noneBox);
    noneRow.appendChild(document.createTextNode("None of these apply to me"));
    box.appendChild(noneRow);

    root.appendChild(box);
  });
}

/* ---- close-out ---- */

$("done").addEventListener("click", function () {
  chrome.storage.local.set({ profile: profile }, function () { window.close(); });
});

$("wipe").addEventListener("click", function () {
  if (!confirm("Erase every detail you've saved? This can't be undone.")) return;
  profile = JSON.parse(JSON.stringify(EMPTY));
  chrome.storage.local.clear(function () { location.reload(); });
});

/* ---- boot ---- */

chrome.storage.local.get("profile", function (store) {
  profile = Object.assign(JSON.parse(JSON.stringify(EMPTY)), store.profile || {});
  var migrated = false;
  // Split legacy full street addresses into reusable house-number + street-name facts.
  if (!profile.personal.houseNumber || !profile.personal.streetName) {
    var parsedAddr = parseStreetAddress(profile.personal.addressLine1);
    if (parsedAddr) {
      if (!profile.personal.houseNumber) profile.personal.houseNumber = parsedAddr.houseNumber;
      if (!profile.personal.streetName) profile.personal.streetName = parsedAddr.streetName;
      migrated = true;
    }
  }
  if ((!profile.personal.addressLine1 || !profile.personal.addressLine1.trim()) && (profile.personal.houseNumber || profile.personal.streetName)) {
    profile.personal.addressLine1 = [profile.personal.houseNumber, profile.personal.streetName].filter(Boolean).join(" ").trim();
    migrated = true;
  }
  // Correct the development profile's previously misspelled street while
  // keeping this migration narrowly scoped to that exact legacy value.
  if (/^bangara crescent$/i.test(profile.personal.streetName || "")) {
    profile.personal.streetName = "Bungarra Crescent";
    profile.personal.addressLine1 = [profile.personal.houseNumber, profile.personal.streetName].filter(Boolean).join(" ").trim();
    migrated = true;
  }
  if (/^57\s+bangara crescent$/i.test(profile.personal.addressLine1 || "")) {
    profile.personal.houseNumber = "57"; profile.personal.streetName = "Bungarra Crescent"; profile.personal.addressLine1 = "57 Bungarra Crescent"; migrated = true;
  }
  (profile.experience || []).forEach(function (job) {
    if (!job.country && GF.inferCountryFromLocation) { var c = GF.inferCountryFromLocation(job.location); if (c) { job.country = c; migrated = true; } }
    if (/^gridware$/i.test(String(job.employer || "").trim()) && /cyber\s*security\s*intern/i.test(job.title || "")) {
      if (!job.location) { job.location = "Sydney"; migrated = true; }
      if (!job.country) { job.country = "Australia"; migrated = true; }
      if (!job.businessDescription) { job.businessDescription = "Cybersecurity consulting"; migrated = true; }
    }
    if (GF.canonicalBusinessType) {
      var canonical = GF.canonicalBusinessType(job);
      if (canonical && canonical !== job.businessType) {
        if (!job.businessDescription && job.businessType && /consult/i.test(job.businessType)) job.businessDescription = job.businessType;
        job.businessType = canonical; migrated = true;
      }
    }
  });
  (profile.education || []).forEach(function (ed) {
    if (!ed.educationType && GF.deriveEducationCategory) { var et = GF.deriveEducationCategory(ed); if (et) { ed.educationType = et; migrated = true; } }
    if (!ed.institutionType && GF.deriveInstitutionCategory) { var it = GF.deriveInstitutionCategory(ed); if (it) { ed.institutionType = it; migrated = true; } }
    if (/\b(uts|university of technology,? sydney)\b/i.test(ed.institution || "")) {
      if (!ed.location) { ed.location = "Sydney"; migrated = true; }
      if (!ed.country) { ed.country = "Australia"; migrated = true; }
      if (!ed.educationType) { ed.educationType = "Academic"; migrated = true; }
      if (!ed.institutionType) { ed.institutionType = "University"; migrated = true; }
    }
    if (!ed.country && GF.inferCountryFromLocation) { var ec = GF.inferCountryFromLocation(ed.location); if (ec) { ed.country = ec; migrated = true; } }
  });
  if (migrated) chrome.storage.local.set({ profile: profile });
  populateCountrySelects();
  bindSimple();
  wireStateField();
  wireAddressAutocomplete();
  Object.keys(LISTS).forEach(renderList);
  renderEssentials();
  renderTags();
  showResume();
  railSpy();
  wireValidation();
  $("version").textContent = "GradFill v" + chrome.runtime.getManifest().version;
  if (!profile.education.length) { profile.education.push({}); renderList("education"); }

  // Concrete, visible proof this loaded real data from a previous
  // session rather than starting blank — not just an abstract claim that
  // storage "works". Only shown when there was something to load.
  var hadSavedData = !!(store.profile && (store.profile.personal && (store.profile.personal.firstName || store.profile.personal.email) || (store.profile.education || []).length || (store.profile.experience || []).length));
  if (hadSavedData) {
    var pill = $("saved");
    pill.hidden = false;
    pill.textContent = "Loaded from last session";
    setTimeout(function () { if (pill.textContent === "Loaded from last session") pill.hidden = true; }, 2600);
  }
});
