/* GradFill — page scanner and filler.
   Runs only when you click the extension. Never presses submit. */

(function () {
  if (window.__gradfillLoaded) return;
  window.__gradfillLoaded = true;

  var UID = 0;
  var LAST_REPORT = [];
  var revealed = false;
  var pendingSelects = false;
  var NEEDS_RELOCATE_PREF = false;
  var CORRECTION_WATCH_INSTALLED = false;
  var CORRECTION_DEBOUNCE = null;

  /* ---------- label discovery ----------
     A field's OWN label and its surrounding CONTEXT are kept apart.
     Mixing them lets a section heading like "Legal Name" outrank the
     field's actual label "Given Name", which fills three boxes the same. */

  function textOf(node) {
    if (!node) return "";
    return (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Workday and similar platforms label controls with identifier-style
  // attributes ("candidateIsPreviousWorker", "personalInfo--firstName")
  // rather than visible text. Useful as matching fodder, but only if the
  // words are actually separated — lowercasing alone collapses them into
  // one unbroken string ("candidateispreviousworker"), which defeats any
  // \bword\b-style match. Split camelCase/snake_case/separators into
  // spaced words first so those still work as normal matching text.
  function splitIdentifier(s) {
    return String(s || "")
      .replace(/[_\-.]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  }

  // Standards-based autocomplete tokens are one of the most reliable
  // cross-platform signals available. Workday, PageUp and other ATS forms
  // may expose them even when visible labels are wrapped in custom components.
  function autocompleteWords(value) {
    var map = {
      "given-name": "first name", "additional-name": "middle name", "family-name": "last name",
      "name": "full name", "honorific-prefix": "salutation title", "email": "email",
      "tel": "phone mobile telephone", "tel-national": "phone mobile telephone",
      "street-address": "street address", "address-line1": "street address",
      "address-line2": "address line 2", "address-level2": "city suburb locality",
      "address-level1": "state territory province", "postal-code": "postcode postal code zip",
      "country": "country", "country-name": "country"
    };
    return String(value || "").split(/\s+/).map(function (x) { return map[x] || splitIdentifier(x); }).join(" ");
  }

  function ownLabel(el) {
    var bits = [];

    // Labels may live in the same shadow root as the control rather than
    // in the top document. Resolve them from the control's own root first.
    var root = (el.getRootNode && el.getRootNode()) || document;
    if (!root.querySelector) root = document;

    if (el.id) {
      var lab = root.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (!lab && root !== document) lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) bits.push(textOf(lab));
    }

    var lb = el.getAttribute("aria-labelledby");
    if (lb) {
      lb.split(/\s+/).forEach(function (id) {
        var n = root.getElementById ? root.getElementById(id) : root.querySelector('#' + CSS.escape(id));
        if (!n && root !== document) n = document.getElementById(id);
        if (n) bits.push(textOf(n));
      });
    }

    // SAP SuccessFactors and other enterprise forms frequently attach
    // help/label text with aria-describedby rather than a for= label.
    var describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      describedBy.split(/\s+/).forEach(function (id) {
        var n = root.getElementById ? root.getElementById(id) : root.querySelector('#' + CSS.escape(id));
        if (!n && root !== document) n = document.getElementById(id);
        if (n) bits.push(textOf(n));
      });
    }

    // A wrapping <label> counts as the field's own, but strip out any other
    // field's text that happens to live inside it.
    var wrap = el.closest("label");
    if (wrap) {
      var clone = wrap.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, label, button, a, [role=\"option\"], [role=\"listbox\"], [role=\"menu\"], .dropdown-menu, .select2-results").forEach(function (n) { n.remove(); });
      bits.push(textOf(clone));
    }

    bits.push(el.getAttribute("aria-label") || "");

    // Everything up to here reads as prose; the rest is matching fodder only.
    var prose = bits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    bits.push(el.placeholder || "");
    bits.push(el.getAttribute("title") || "");
    bits.push(autocompleteWords(el.getAttribute("autocomplete")));
    bits.push(splitIdentifier(el.name));
    bits.push(splitIdentifier(el.id));
    // Identifier attributes used by Workday, SAP SuccessFactors, UI5 and
    // other ATS/component libraries. These are matching hints only; they
    // never replace the visible human label when one exists.
    ["data-automation-id", "data-automation-label", "data-field-id", "field-id", "data-field",
     "data-field-name", "data-testid", "data-test-id", "data-qa", "data-key", "data-name",
     "data-control-id", "data-help-id", "data-uxi-element-id", "data-uxi-widget-type"].forEach(function (attr) {
      bits.push(splitIdentifier(el.getAttribute(attr)));
    });

    return {
      prose: prose.slice(0, 300),
      all: bits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 300)
    };
  }

  function contextLabel(el) {
    var bits = [];

    var fs = el.closest("fieldset");
    if (fs) {
      var lg = fs.querySelector("legend");
      if (lg) bits.push(textOf(lg));
    }

    // The nearest actual question text — usually plain or bold paragraph
    // text right above the field, not a semantic heading — takes priority.
    // Checked before the wider heading search below, or a page-level
    // title like "DIVERSITY & INCLUSION" (which technically precedes
    // every field on the page) gets mistaken for every field's context.
    if (!bits.length) {
      var near = nearestPrecedingText(el);
      if (near) bits.push(near);
    }

    // Fall back to the nearest heading directly above this field, but
    // only within a couple of container levels — a section heading a
    // couple of hops up is fair game; the page's main title many levels
    // up is not.
    if (!bits.length) {
      var scope = el.closest("fieldset, section, div, form");
      var hops = 0;
      while (scope && hops < 2) {
        var h = scope.querySelector("h1, h2, h3, h4, h5, h6, legend");
        if (h && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
          bits.push(textOf(h));
          break;
        }
        scope = scope.parentElement;
        hops++;
      }
    }

    return bits.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function looksLikeAnswerOption(node) {
    // Only a genuine radio/checkbox choice counts as an "answer option"
    // boundary — that's the case this exists for (walking past a "Yes"/
    // "No" option's own label to find the shared question above it). A
    // label wrapping a normal text input, select, or textarea is just
    // that field's own label — a completely normal, expected sibling on
    // the way back to a section heading, not a boundary to stop at.
    // Treating every label as a stop point meant any field with a few
    // ordinary preceding fields (a very common pattern) could never walk
    // far enough back to find its real section heading at all.
    if (!node || node.nodeType !== 1) return false;
    if (node.matches && node.matches('input[type="radio"], input[type="checkbox"]')) return true;
    return !!node.querySelector('input[type="radio"], input[type="checkbox"]');
  }

  function looksLikeOrdinaryFieldLabel(node) {
    // A real <label> wrapping a plain text/select/date field is that
    // field's own label — worth walking past on the way to a genuine
    // section heading or description, but not worth collecting as if it
    // were describing the CURRENT field. Skipping it (rather than
    // stopping at it) is what lets a field reach a heading positioned
    // behind several ordinary fields; not collecting it is what stops an
    // unrelated field's label from being mistaken for shared context
    // when there's nothing more relevant nearby. Component-based markup
    // often wraps a field as a plain <div> holding a <label> and an
    // <input> as siblings, rather than the label directly wrapping the
    // input — recognised the same way either shape appears.
    if (!node || node.nodeType !== 1) return false;
    var control = node.querySelector('input:not([type="radio"]):not([type="checkbox"]), select, textarea');
    if (!control) return false;
    if (node.matches && node.matches("label")) return true;
    return !!node.querySelector("label");
  }

  function looksLikeActionControl(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches && node.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')) return true;
    var t = textOf(node).trim();
    return /^(add|add another|add more|add new|edit|delete|remove|save|cancel|close|next|previous|continue|submit)$/i.test(t);
  }

  function stripActionText(node) {
    if (!node || !node.cloneNode) return "";
    var clone = node.cloneNode(true);
    clone.querySelectorAll('button, a, [role="button"], input, select, textarea, [contenteditable="true"], [contenteditable=""]').forEach(function (n) { n.remove(); });
    return textOf(clone).replace(/\b(add|add another|add more|add new|edit|delete|remove|save|cancel|close|next|previous|continue|submit)\b/ig, " ").replace(/\s+/g, " ").trim();
  }

  function nearestPrecedingText(el) {
    var node = el;
    var hops = 0;
    while (node && hops < 6) {
      // A question is often split across more than one preceding block —
      // a lead-in sentence, the actual question, a "please note" caveat.
      // Walking backward, collect every qualifying block until hitting
      // the previous question's own answer options (that's the real
      // boundary), not just the single nearest block, or a closer but
      // less relevant caveat can bury the actual question.
      var collected = [];
      var total = 0;
      var sib = node.previousElementSibling;
      while (sib) {
        if (looksLikeAnswerOption(sib)) break;
        if (looksLikeActionControl(sib)) { sib = sib.previousElementSibling; continue; }
        if (!looksLikeOrdinaryFieldLabel(sib)) {
          var t = textOf(sib);
          if (t && t.length > 3 && t.length < 500 && total < 600) {
            collected.unshift(t);
            total += t.length;
          }
        }
        sib = sib.previousElementSibling;
      }
      if (collected.length) return collected.join(" ");
      node = node.parentElement;
      hops++;
    }
    return "";
  }

  function looseLabel(el) {
    // Last resort when a field has no explicit label. Strip interactive
    // controls before reading parent text: SuccessFactors frequently puts
    // an "Add" button in the same container as the newly-created row,
    // and treating that button text as the field label can teach/fill the
    // literal word "Add" into the first input.
    var p = el.parentElement, hops = 0;
    while (p && hops < 4 && p.tagName !== "BODY" && p.tagName !== "HTML") {
      var t = stripActionText(p);
      if (t && t.length < 300) return t;
      p = p.parentElement; hops++;
    }
    return "";
  }

  function describe(el) {
    var lab = ownLabel(el);
    var own = lab.all;
    var prose = lab.prose;
    var ctx = contextLabel(el);
    // The check here needs to be "is there any real, human-readable
    // label text" — not "is own completely empty", which it almost
    // never is, since own already carries the element's id/name/
    // placeholder. A field with an unhelpful auto-generated id but no
    // real label ("desc1", no wrapping <label>) would otherwise never
    // reach this fallback at all, even though walking up to the nearest
    // parent text (which is exactly what looseLabel does) would have
    // found the real label sitting right there.
    if (!prose) {
      var loose = looseLabel(el);
      if (loose) { own = (own + " " + loose).trim(); prose = loose; }
    }

    // A contenteditable rich-text editor fills the same role as a
    // <textarea> for every purpose downstream — matching, the long-answer
    // detection, everything — it just isn't literally that tag.
    var isEditable = el.isContentEditable ||
      el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "";
    var isPill = el.tagName === "BUTTON" && el.hasAttribute("aria-pressed");

    return {
      el: el,
      type: isEditable ? "textarea" : (isPill ? "pill" : (el.type || el.tagName).toLowerCase()),
      tag: isEditable ? "textarea" : el.tagName.toLowerCase(),
      contentEditable: isEditable,
      label: (prose || ctx || "(unlabelled field)").slice(0, 160),
      question: (prose || ctx || "").slice(0, 300),
      own: own.toLowerCase(),
      context: ctx.toLowerCase(),
      contextRaw: ctx,
      haystack: (own + " " + ctx).toLowerCase(),
      required: el.required || el.getAttribute("aria-required") === "true",
      maxlength: parseInt(el.getAttribute("maxlength") || "0", 10)
    };
  }

  /* ---------- filling ---------- */

  function setNative(el, value) {
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") {
      if (el.textContent === value) return;
      el.focus();
      el.textContent = value;
      // A framework-driven rich-text editor (Draft.js, Slate, ProseMirror
      // and similar) listens for real input events to notice a change —
      // setting textContent alone doesn't fire one on its own.
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return;
    }
    if (el.value === value) return;
    try { el.focus(); } catch (e) {}
    var proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    // Framework date/picklist controls often validate or commit only on a
    // genuine focus transition. Dispatching a synthetic blur event alone
    // does not change document.activeElement, so call blur() as well.
    try { el.blur(); } catch (e) { el.dispatchEvent(new Event("blur", { bubbles: true })); }
  }

  function setDateNative(el, value) {
    if (!el) return;
    try { el.focus(); } catch (e) {}
    try {
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, "");
      try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null })); } catch (e) { el.dispatchEvent(new Event("input", { bubbles: true })); }
      setter.call(el, String(value));
      try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) })); } catch (e) { el.dispatchEvent(new Event("input", { bubbles: true })); }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      fireKey(el, "Enter", "Enter");
      fireKey(el, "Tab", "Tab");
      try { el.blur(); } catch (e) {}
    } catch (e) {
      setNative(el, value);
    }
  }

  function normalise(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function initials(text) {
    var words = String(text).trim().split(/\s+/);
    if (words.length < 2) return "";
    return words.map(function (w) { return w[0]; }).join("").toLowerCase();
  }

  function candidates(value) {
    var out = [String(value)];
    var syn = GF.SYNONYMS[normalise(value)];
    if (syn) out = out.concat(syn);

    // A GPA/WAM-style figure often needs to match a coarser dropdown —
    // whole numbers, half-point steps, or a rounded band — rather than
    // the exact saved decimal. Offering several reasonable roundings and
    // letting normal scoring pick whichever real option fits best beats
    // guessing at one specific bucket format.
    var n = parseFloat(value);
    if (!isNaN(n) && /^\d+(\.\d+)?$/.test(String(value).trim())) {
      out.push(String(Math.round(n)));
      out.push(String(Math.round(n * 2) / 2));
      out.push(String(Math.floor(n)));
      out.push(String(Math.ceil(n)));
      // Australian university forms often turn a WAM into a named grade
      // band. Offer the corresponding band as an alternate candidate so a
      // dropdown can select Credit/Distinction/etc. while the raw 73.89 is
      // still used when the field is free text.
      if (n >= 0 && n <= 100) {
        if (n >= 85) out.push("High Distinction");
        else if (n >= 75) out.push("Distinction");
        else if (n >= 65) out.push("Credit");
        else if (n >= 50) out.push("Pass");
        else out.push("Fail");
      }
    }
    return out;
  }

  /* Score one option against one candidate value.
     4 exact, 3 initials or synonym-exact, 2 substring. */
  function scoreOption(optText, optValue, want) {
    var t = normalise(optText), v = normalise(optValue), w = normalise(want);
    if (!w) return 0;
    if (t === w || v === w) return 4;
    if (initials(optText) === w) return 3;
    if (t && (t.indexOf(w) > -1 || w.indexOf(t) > -1)) return 2;
    if (v && v.indexOf(w) > -1) return 2;
    return 0;
  }

  // "None" is a real answer on a clearance dropdown, not a placeholder.
  var PLACEHOLDER = /^(selectone|select|pleaseselect|selectoption|selectanoption|choose|chooseone|)$/;

  // State/country lists on many forms load in after the page renders
  // (an API-backed picker, or state options waiting on a country choice).
  // A select with nothing but a placeholder in it isn't "no match" —
  // it just hasn't populated yet, and is worth one retry.
  function optionsAreEmpty(el) {
    if (el.options.length === 0) return true;
    if (el.options.length === 1 && PLACEHOLDER.test(normalise(el.options[0].textContent))) return true;
    return false;
  }

  function bestOption(options, value, alternates) {
    var values = [String(value == null ? "" : value)].concat((alternates || []).filter(Boolean).map(String));
    var best = null, bestScore = 0, bestValue = "", usedAlternate = false;
    values.forEach(function (wanted, valueIndex) {
      var cands = candidates(wanted);
      options.forEach(function (o) {
        var t = o.text, v = o.value;
        if (PLACEHOLDER.test(normalise(t))) return;
        cands.forEach(function (c, i) {
          var sc = scoreOption(t, v, c);
          // A synonym or alternate is useful, but it should never outrank a
          // direct match to the user's saved value. Exact alternates top out
          // at review-level confidence (3).
          if ((i > 0 || valueIndex > 0) && sc === 4) sc = 3;
          if (valueIndex > 0 && sc > 3) sc = 3;
          if (sc > bestScore) {
            bestScore = sc; best = o; bestValue = wanted; usedAlternate = valueIndex > 0;
          }
        });
      });
    });
    return { option: best, score: bestScore, matchedValue: bestValue, usedAlternate: usedAlternate };
  }

  function fillSelect(el, value, alternates) {
    var opts = Array.prototype.map.call(el.options, function (o) {
      return { text: o.textContent, value: o.value, el: o };
    });
    var hit = bestOption(opts, value, alternates);
    if (!hit.option) return hit;
    if (el.value !== hit.option.value) {
      var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(el, hit.option.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return hit;
  }

  function fillRadio(group, value) {
    var opts = group.map(function (el) {
      // A radio input's option text normally lives in its wrapping/
      // associated <label> (caught by ownLabel). An aria-pressed toggle
      // button IS its own label — there's no separate element to
      // associate — so its own visible text is the option text, not the
      // button's (usually empty) value attribute.
      return { text: ownLabel(el).prose || textOf(el) || el.value, value: el.value, el: el };
    });
    var hit = bestOption(opts, value);
    if (!hit.option) return false;
    // A native radio input's click is a safe no-op when it's already the
    // checked one. An aria-pressed toggle button has no such native
    // guarantee — re-clicking one that's already pressed can deselect it
    // instead, so that case is skipped explicitly rather than relying on
    // the browser to no-op it.
    if (hit.option.el.getAttribute("aria-pressed") !== "true") hit.option.el.click();
    return hit.score >= 3;
  }

  /* ---------- "select all that apply" checkbox groups ----------
     Prefers your explicit choices from Setup — Background (matched
     directly, no guessing) over inferring anything from free text. Falls
     back to a conservative job-title match only when nothing's been set
     for that category yet, so this still does something useful before
     you've visited Setup, without ever guessing at loose descriptions,
     STAR examples, or industry/leadership categories, where a wrong tick
     on a real application would misrepresent someone. */

  var TAG_GROUP_RE = {
    programs: /\bprograms?\b/,
    leadership: /\bleadership\b/,
    extracurricular: /\bextracurricular\b/,
    industries: /\bindustr(y|ies)\b/
  };

  function stemMatch(phrase, corpus) {
    var p = String(phrase).toLowerCase().replace(/[^a-z]/g, "");
    if (p.length < 4) return false;
    var root = p.replace(/(ship|ing|ed|es|s)$/, "");
    if (root.length < 4) root = p;
    return corpus.indexOf(root) > -1;
  }

  function detectTagCategory(questionText) {
    var t = (questionText || "").toLowerCase();
    for (var k in TAG_GROUP_RE) {
      if (TAG_GROUP_RE[k].test(t)) return k;
    }
    return null;
  }

  // The structural fallback for grouping checkboxes that don't share a
  // name attribute: the nearest ancestor that actually contains more
  // than one checkbox belonging to this scan (walking too far up risks
  // accidentally spanning into an unrelated section).
  function checkboxContainer(el, nodes) {
    var node = el.parentElement;
    var hops = 0;
    while (node && hops < 6) {
      var boxes = Array.prototype.filter.call(
        node.querySelectorAll('input[type="checkbox"]'),
        function (n) { return nodes.indexOf(n) > -1; }
      );
      if (boxes.length > 1) return node;
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  // Same structural-grouping idea as checkboxContainer, for aria-pressed
  // button groups: they never share a name attribute the way radios do,
  // so the nearest ancestor holding more than one of this scan's pill
  // buttons is the only way to find the rest of the row.
  function pillContainer(el, nodes) {
    var node = el.parentElement;
    var hops = 0;
    while (node && hops < 6) {
      var btns = Array.prototype.filter.call(
        node.querySelectorAll('button[aria-pressed]'),
        function (n) { return nodes.indexOf(n) > -1; }
      );
      if (btns.length > 1) return node;
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  function optionPhrases(raw) {
    return raw.replace(/\([^)]*\)/g, "")
      .split(/\s+or\s+|\//i)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  // Splitting an option like "Sporting Coach or Captain" into fragments
  // and stem-matching each one independently is too loose — a bare
  // "Captain" fragment will match ANY saved tag containing that word,
  // including an unrelated one like "School Captain". Whole-phrase
  // comparison requires every significant word of the saved tag to
  // actually appear in the option, so a shared generic word alone can't
  // cause a false match.
  function wordStem(w) { return w.replace(/(ing|ed|es|s)$/, ""); }
  function significantWords(s) {
    return String(s).toLowerCase().replace(/\([^)]*\)/g, "")
      .split(/[^a-z]+/).filter(function (w) { return w.length > 2; }).map(wordStem);
  }
  function tagMatchesOption(tag, optionRaw) {
    var tagWords = significantWords(tag);
    if (!tagWords.length) return false;
    var optWords = significantWords(optionRaw);
    return tagWords.every(function (tw) {
      return optWords.some(function (ow) { return ow === tw; });
    });
  }

  function fillCheckboxGroupFromMemory(group, memoryValue) {
    var wanted = String(memoryValue || "").split(",").map(function (x) { return memoryNorm(x); }).filter(Boolean), ticked = [];
    if (!wanted.length) return ticked;
    group.forEach(function (el) {
      var raw = (ownLabel(el).prose || textOf(el) || el.value || "").trim(), nr = memoryNorm(raw);
      var matched = wanted.some(function (w) { return w === nr || (w.length > 3 && nr.length > 3 && (w.indexOf(nr) > -1 || nr.indexOf(w) > -1)); });
      if (matched) { if (!el.checked) el.click(); ticked.push(raw); }
    });
    return ticked;
  }

  function fillCheckboxGroup(group, profile, questionText) {
    var ticked = [];
    var isNoneOption = function (raw) { return /\bhave not\b|\bnone of\b|\bnot applicable\b/i.test(raw); };

    var category = detectTagCategory(questionText);
    var saved = category && profile.tags && profile.tags[category];

    if (saved && (saved.none || saved.items.length || (saved.other || []).length)) {
      // Explicit answer from Setup — matched directly, no inference.
      if (saved.none) {
        group.forEach(function (el) {
          var raw = (ownLabel(el).prose || textOf(el) || "").trim();
          if (raw && isNoneOption(raw) && !el.checked) { el.click(); ticked.push(raw); }
        });
        return ticked;
      }
      var savedTags = saved.items.concat(saved.other || []);
      group.forEach(function (el) {
        var raw = (ownLabel(el).prose || textOf(el) || "").trim();
        if (!raw || isNoneOption(raw)) return;
        var matched = savedTags.some(function (tag) { return tagMatchesOption(tag, raw); });
        if (matched) {
          if (!el.checked) el.click();
          ticked.push(raw);
        }
      });
      return ticked;
    }

    // Nothing explicit saved for this category yet — fall back to a
    // conservative match against saved job titles only.
    var corpus = (profile.experience || [])
      .map(function (e) { return (e.title || "").toLowerCase(); })
      .join(" | ")
      .replace(/[^a-z|]/g, "");
    if (!corpus.replace(/\|/g, "").trim()) return ticked;

    group.forEach(function (el) {
      var raw = (ownLabel(el).prose || textOf(el) || "").trim();
      if (!raw || isNoneOption(raw)) return;
      var matched = optionPhrases(raw).some(function (ph) { return stemMatch(ph, corpus); });
      if (matched) {
        if (!el.checked) el.click();
        ticked.push(raw);
      }
    });
    return ticked;
  }

  /* ---------- Angular Material mat-select ----------
     A widely-used, well-documented component, not bespoke site code.
     Clicking the host opens a panel Angular renders elsewhere in the
     document; options are real <mat-option> elements, and clicking one
     is genuine user-equivalent interaction — Angular handles updating
     its own state, no value-faking needed. If nothing matches
     confidently, the panel is closed again rather than left open or
     guessed at. */

  var PENDING_MAT_SELECTS = [];
  var PENDING_ACCESSIBLE_COMBOS = [];
  var PENDING_DATE_FIELDS = [];

  function isMatSelect(el) {
    return el.tagName === "MAT-SELECT" || (el.classList && el.classList.contains("mat-mdc-select"));
  }

  function matSelectCurrentText(el) {
    var valueEl = el.querySelector(".mat-mdc-select-value-text, .mat-mdc-select-min-line:not(.mat-mdc-select-placeholder)");
    return valueEl ? textOf(valueEl) : "";
  }

  function fillMatSelect(el, value, alternates, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      function done(result) { if (!settled) { settled = true; resolve(result); } }
      var deadline = Date.now() + (timeoutMs || 1500);

      try { el.click(); } catch (e) { return done(false); }

      (function poll() {
        if (Date.now() > deadline) return done(false);
        var options = Array.prototype.slice.call(
          document.querySelectorAll('mat-option, [role="option"]')
        ).filter(function (o) {
          var r = o.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!options.length) { setTimeout(poll, 50); return; }

        var opts = options.map(function (o) { return { text: textOf(o), value: textOf(o), el: o }; });
        var hit = bestOption(opts, value, alternates);

        if (!hit.option || hit.score < 3) {
          try { el.click(); } catch (e) {}   // close the panel again
          return done(false);
        }
        try { hit.option.el.click(); } catch (e) { return done(false); }
        return done({ ok: true, usedAlternate: hit.usedAlternate, selectedText: hit.option.text, matchedValue: hit.matchedValue });
      })();
    });
  }

  async function resolvePendingMatSelects(report) {
    for (var i = 0; i < PENDING_MAT_SELECTS.length; i++) {
      var item = PENDING_MAT_SELECTS[i];
      var result = null;
      try { result = await fillMatSelect(item.el, item.value, item.alternates || [], 1500); } catch (e) { result = null; }
      if (result && result.ok) {
        var matStatus = (item.flag || result.usedAlternate) ? "check" : "ok";
        mark(item.el, matStatus);
        report.push({ id: item.id, label: item.label, status: matStatus, value: result.selectedText || item.value,
          note: result.usedAlternate ? ("Selected “" + (result.selectedText || result.matchedValue) + "” as the closest available option to “" + item.value + "”.") : (item.flag || "") });
      } else {
        // Genuinely nothing was selected -- a yellow "check" here would
        // claim GradFill picked something when the widget is still blank.
        // "prompt" (red/blank) is the honest tier for a real attempt that
        // did not commit, same standard as the accessible-combo failure
        // path below.
        mark(item.el, "prompt");
        report.push({ id: item.id, label: item.label, status: "prompt", kind: "field",
          note: "Blank \u2014 GradFill tried to select \u201c" + item.value + "\u201d in this dropdown but couldn\u2019t confirm it committed. Choose it yourself." });
      }
    }
  }


  /* ---------- accessible/custom comboboxes ----------
     SuccessFactors and several other ATS products render picklists as an
     input or button with role=combobox and a floating role=option list.
     For these, click the widget, wait briefly for its real options, and
     only click an option when GradFill can match it confidently. */

  function visibleAccessibleOptions(root) {
    var seen = new Set(), out = [];
    // Include open shadow roots as well as the document. SAP SuccessFactors,
    // Workday and other enterprise controls often render their floating
    // option panel in a portal/root that is not a child of the combobox.
    var selector = '[role="option"], li.ui-menu-item, .ui-menu-item, .select2-results__option, .dropdown-menu li, [data-value][role="option"], [role="listbox"] li, [aria-selected]';
    var all = deepQueryAll(selector);
    if (root && root.querySelectorAll) {
      try { all = all.concat(Array.prototype.slice.call(root.querySelectorAll(selector))); } catch (e) {}
    }
    all.forEach(function (o) {
      if (!o || seen.has(o)) return;
      var box = o.getBoundingClientRect();
      var txt = textOf(o);
      if (!txt || (box.width === 0 && box.height === 0)) return;
      seen.add(o); out.push(o);
    });
    return out;
  }

  function fireKey(el, key, code) {
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: key, code: code || key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: key, code: code || key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: key, code: code || key, bubbles: true, cancelable: true }));
    } catch (e) {}
  }

  function activateAccessibleOption(optionEl, comboEl) {
    if (!optionEl) return false;
    try {
      optionEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      // Some SuccessFactors picklists only commit on the pointer/mouse-down
      // sequence, not on HTMLElement.click() alone.
      try { optionEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" })); } catch (e) {}
      optionEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      try { optionEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" })); } catch (e) {}
      optionEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      optionEl.click();
      // Typeahead picklists frequently highlight the clicked row but wait for
      // Enter before they actually store it. Sending Enter after the click is
      // harmless on a committed picker and fixes the "Australia highlighted
      // but not selected" failure mode.
      if (comboEl) {
        try { comboEl.focus(); } catch (e) {}
        fireKey(comboEl, "Enter", "Enter");
      }
      return true;
    } catch (e) {
      try { optionEl.click(); if (comboEl) fireKey(comboEl, "Enter", "Enter"); return true; } catch (e2) { return false; }
    }
  }

  function comboCurrentText(el) {
    if (!el) return "";
    var bits = [];
    if (typeof el.value === "string") bits.push(el.value);
    bits.push(textOf(el));
    // Some enterprise pickers render the committed value into a sibling
    // span while the clickable wrapper itself keeps generic text.
    if (el.parentElement) bits.push(textOf(el.parentElement));
    if (el.getAttribute) {
      bits.push(el.getAttribute("aria-valuetext") || "");
      bits.push(el.getAttribute("data-value") || "");
      var active = el.getAttribute("aria-activedescendant");
      if (active) {
        try { var a = document.getElementById(active); if (a) bits.push(textOf(a)); } catch (e) {}
      }
    }
    return bits.filter(Boolean).join(" ");
  }

  function comboLooksCommitted(el, wanted, alternates) {
    var current = comboCurrentText(el);
    if (!current) return false;
    var cands = candidates(wanted);
    (alternates || []).forEach(function (a) { cands = cands.concat(candidates(a)); });
    for (var i = 0; i < cands.length; i++) {
      if (scoreOption(current, current, cands[i]) >= 3) return true;
    }
    return false;
  }

  function fillAccessibleCombo(el, value, alternates, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false, deadline = Date.now() + (timeoutMs || 2400);
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      try {
        el.focus();
        fireClick(el);
        if (/^(INPUT|TEXTAREA)$/i.test(el.tagName)) {
          // Keep focus inside the open typeahead while filtering. The normal
          // setNative() deliberately blurs to commit ordinary text/date
          // fields; doing that here closes SAP's picklist before Enter can
          // confirm Australia/Urdu/etc.
          var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, String(value));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          fireKey(el, "ArrowDown", "ArrowDown");
        }
      } catch (e) { return done(false); }
      (function poll() {
        if (comboLooksCommitted(el, value, alternates)) return done({ ok: true, usedAlternate: false, selectedText: comboCurrentText(el) });
        if (Date.now() > deadline) {
          // Last resort for a typeahead that has already highlighted the
          // wanted result: Enter is the actual commit action.
          try { el.focus(); fireKey(el, "Enter", "Enter"); } catch (e) {}
          return setTimeout(function () { done({ ok: comboLooksCommitted(el, value, alternates), usedAlternate: false, selectedText: comboCurrentText(el) }); }, 120);
        }
        var root = (el.getRootNode && el.getRootNode()) || document;
        var opts = visibleAccessibleOptions(root).map(function (o) {
          return { text: textOf(o), value: o.getAttribute("data-value") || o.getAttribute("value") || textOf(o), el: o };
        });
        if (!opts.length) { setTimeout(poll, 70); return; }
        var hit = bestOption(opts, value, alternates);
        if (!hit.option || hit.score < 3) { setTimeout(poll, 70); return; }
        if (!activateAccessibleOption(hit.option.el, el)) return done(false);
        setTimeout(function () {
          if (comboLooksCommitted(el, value, alternates)) return done({ ok: true, usedAlternate: hit.usedAlternate, selectedText: hit.option.text, matchedValue: hit.matchedValue });
          // SuccessFactors typeahead can leave the exact row highlighted
          // after the synthetic click. Confirm it explicitly with Enter.
          try { el.focus(); fireKey(el, "Enter", "Enter"); fireKey(el, "Tab", "Tab"); } catch (e) {}
          setTimeout(function () { done({ ok: comboLooksCommitted(el, value, alternates), usedAlternate: hit.usedAlternate, selectedText: hit.option.text, matchedValue: hit.matchedValue }); }, 120);
        }, 140);
      })();
    });
  }

  async function resolvePendingAccessibleCombos() {
    for (var i = 0; i < PENDING_ACCESSIBLE_COMBOS.length; i++) {
      var item = PENDING_ACCESSIBLE_COMBOS[i], result = null;
      try { result = await fillAccessibleCombo(item.el, item.value, item.alternates || [], 2800); } catch (e) { result = null; }
      if (result && result.ok) {
        var comboStatus = (item.flag || result.usedAlternate) ? "check" : "ok";
        mark(item.el, comboStatus);
        if (item.reportItem) {
          item.reportItem.status = comboStatus;
          item.reportItem.value = result.selectedText || item.value;
          item.reportItem.note = result.usedAlternate
            ? ("Selected “" + (result.selectedText || result.matchedValue) + "” as the closest available option to “" + item.value + "”.")
            : (item.flag || "");
        }
      } else {
        // Confirmed live on CSIRO's real SuccessFactors Candidate Profile:
        // fillAccessibleCombo() can time out on a real role="combobox"
        // picker without ever finding its rendered option list, leaving
        // the underlying field genuinely blank. Before this fix, the
        // optimistic "check" entry pushed synchronously in scan() (before
        // this attempt even ran) was simply left in place on failure --
        // reporting yellow "typed into a dropdown, confirm it stayed
        // selected" for a field that in fact never received any value at
        // all. That's not "uncertain", it's wrong, so this must actively
        // downgrade the report entry rather than leave it untouched.
        mark(item.el, "prompt");
        if (item.reportItem) {
          item.reportItem.status = "prompt";
          item.reportItem.kind = "field";
          item.reportItem.value = "";
          item.reportItem.note = "Blank — GradFill tried to select “" + item.value + "” in this dropdown but couldn’t confirm it committed. Choose it yourself.";
        }
      }
    }
  }

  function dateValueEquivalent(a, b) {
    var A = String(a || "").replace(/[^0-9]/g, "");
    var B = String(b || "").replace(/[^0-9]/g, "");
    return !!A && A === B;
  }

  async function resolvePendingDateFields() {
    if (!PENDING_DATE_FIELDS.length) return;
    await new Promise(function (r) { setTimeout(r, 120); });
    for (var i = 0; i < PENDING_DATE_FIELDS.length; i++) {
      var item = PENDING_DATE_FIELDS[i], current = item.el && item.el.value;
      if (!dateValueEquivalent(current, item.value)) {
        try {
          setDateNative(item.el, item.value);
        } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 100); });
        current = item.el && item.el.value;
      }
      if (!dateValueEquivalent(current, item.value) && item.reportItem) {
        item.reportItem.status = "check";
        item.reportItem.note = (item.reportItem.note ? item.reportItem.note + " " : "") +
          "The site did not visibly retain the date after GradFill set it — confirm this field.";
        mark(item.el, "check");
      }
    }
  }


  function mark(el, status) {
    el.classList.remove("gf-ok", "gf-check", "gf-prompt");
    el.classList.add("gf-" + status);
  }

  function clearMarks() {
    document.querySelectorAll(".gf-ok, .gf-check, .gf-prompt").forEach(function (el) {
      el.classList.remove("gf-ok", "gf-check", "gf-prompt");
    });
  }


  /* ---------- reading the job ad ----------
     Most job boards emit schema.org JobPosting as JSON-LD. Where they
     don't, fall back to Open Graph tags, then the page's own headings.
     Anything not found becomes a question for you rather than a guess. */

  var ROLE = null;

  function stripHtml(html) {
    if (!html) return "";
    var tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    return (tmp.textContent || "").replace(/\s+/g, " ").trim();
  }

  function metaContent(sel) {
    var el = document.querySelector(sel);
    return el ? (el.getAttribute("content") || "").trim() : "";
  }

  function findJobPosting() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      var data;
      try { data = JSON.parse(nodes[i].textContent); } catch (e) { continue; }
      var queue = Array.isArray(data) ? data.slice() : [data];
      while (queue.length) {
        var node = queue.shift();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node["@graph"])) queue = queue.concat(node["@graph"]);
        var t = node["@type"];
        var types = Array.isArray(t) ? t : [t];
        if (types.indexOf("JobPosting") > -1) return node;
      }
    }
    return null;
  }

  function humanType(t) {
    if (!t) return "";
    var list = Array.isArray(t) ? t : [t];
    return list.map(function (x) {
      return String(x).toLowerCase().replace(/_/g, " ")
        .replace(/^./, function (c) { return c.toUpperCase(); });
    }).join(", ");
  }

  function addressOf(loc) {
    if (!loc) return "";
    var l = Array.isArray(loc) ? loc[0] : loc;
    var a = (l && l.address) || l;
    if (!a) return "";
    if (typeof a === "string") return a;
    return [a.addressLocality, a.addressRegion, a.addressCountry]
      .filter(function (x) { return x && typeof x === "string"; }).join(", ");
  }

  function titleFromDocument() {
    var t = document.title || "";
    // "Cyber Analyst | Agency Name" or "Cyber Analyst - Agency Name"
    var parts = t.split(/\s+[|\u2013\u2014\u00b7]\s+|\s+-\s+/);
    return { title: (parts[0] || "").trim(), org: (parts[1] || "").trim() };
  }

  // "How did you hear about us?" is near-universal on grad applications,
  // and the browser already knows the answer more often than not — the
  // page you arrived FROM. Never trusted blindly (a referrer can be
  // stale, stripped by privacy settings, or just an intermediate page
  // rather than the real source), always flagged for a quick confirm.
  // Deliberately a lookup, not a fixed default — wherever someone
  // actually came from wins, not one hardcoded assumption.
  function detectReferrerSource() {
    var ref = document.referrer || "";
    if (!ref) return null;
    var host;
    try { host = new URL(ref).hostname.toLowerCase(); } catch (e) { return null; }
    if (host === location.hostname) return null; // internal navigation, not a real external source

    var known = [
      [/linkedin\./, "LinkedIn"],
      [/seek\.com/, "Seek"],
      [/indeed\./, "Indeed"],
      [/glassdoor\./, "Glassdoor"],
      [/gradconnection\./, "GradConnection"],
      [/prosple\./, "Prosple"],
      [/gradaustralia\./, "GradAustralia"],
      [/facebook\./, "Facebook"],
      [/instagram\./, "Instagram"],
      [/(twitter\.|x\.com)/, "X (Twitter)"],
      [/google\./, "Google Search"],
      [/bing\./, "Bing Search"]
    ];
    for (var i = 0; i < known.length; i++) {
      if (known[i][0].test(host)) return known[i][1];
    }
    // An unrecognised external referrer is most often the organisation's
    // own site (a careers page or job board it links out from).
    return "Company website";
  }

  function detectRole() {
    var jp = findJobPosting();
    var og = { title: metaContent('meta[property="og:title"]'),
               site: metaContent('meta[property="og:site_name"]'),
               desc: metaContent('meta[name="description"]') };
    var docT = titleFromDocument();
    var h1 = textOf(document.querySelector("h1"));

    var company = (jp && jp.hiringOrganization &&
                   (jp.hiringOrganization.name || jp.hiringOrganization)) || "";
    if (typeof company !== "string") company = "";
    company = company || og.site || docT.org || "";

    var title = (jp && jp.title) || h1 || og.title || docT.title || "";

    var desc = stripHtml((jp && jp.description) || "") || og.desc || "";
    if (desc.length > 2000) desc = desc.slice(0, 2000) + " [...]";

    return {
      company: String(company).trim(),
      title: String(title).trim(),
      location: addressOf(jp && jp.jobLocation),
      employmentType: humanType(jp && jp.employmentType),
      closes: (jp && jp.validThrough) || "",
      description: desc,
      referrerSource: detectReferrerSource() || "",
      source: jp ? "job posting data on the page" :
              (og.title || og.site) ? "page metadata" : "page title and heading"
    };
  }

  /* ---------- prompt building ---------- */

  function roleNote() {
    var r = ROLE || {};
    var found = [];
    if (r.company) found.push(r.company);
    if (r.title) found.push(r.title);
    return found.length
      ? "Prompt ready, with " + found.join(" \u2014 ") + " picked up from the page. Fill the TODO lines before sending."
      : "Prompt ready. Nothing about the role was readable from this page, so fill the TODO lines in before sending.";
  }

  function line(label, value, hint) {
    return "- " + label + ": " + (value ? value : "TODO \u2014 " + hint);
  }


  function buildPromptWithValues(question, values, profile, roleDescription) {
    var r = ROLE || detectRole();
    if (roleDescription) r = Object.assign({}, r, { description: roleDescription });
    var e = GF.primaryEducation(profile) || {};
    var L = [];

    var missing = [];
    function roleLine(label, val, hint) {
      if (val) { L.push(label + ": " + val); }
      else { L.push(label + ": MISSING"); missing.push(hint); }
    }

    L.push("I'm applying for a graduate role and need help writing my answer to one question on the application form.");
    L.push("");
    L.push("=== THE QUESTION ===");
    L.push(question);
    L.push("");

    L.push("=== THE ROLE ===");
    roleLine("Organisation", values.org, "the organisation's name");
    roleLine("Role", values.title, "the role's title");
    roleLine("Based in", values.location, "where the role is based");
    roleLine("Employment type", values.empType, "the employment type (graduate program, full time, contract, etc)");
    if (values.does) { L.push(""); L.push("What they do: " + values.does); }
    else if (r.description) { L.push(""); L.push("What they do: " + r.description); }
    else { L.push(""); L.push("What they do: MISSING"); missing.push("what the organisation does"); }
    if (values.requirements) { L.push(""); L.push("Key requirements:"); L.push(values.requirements); }
    else { L.push(""); L.push("Key requirements: MISSING"); missing.push("the key requirements or selection criteria for this role"); }
    if (values.closes) L.push("Applications close: " + values.closes);
    L.push("");

    L.push("=== BEFORE YOU WRITE ANYTHING ===");
    if (missing.length) {
      L.push("Some fields above are marked MISSING: " + missing.join(", ") + ".");
      L.push("For those: first try to find them yourself \u2014 search the web for the organisation's careers page or this specific role, since these are public facts you can look up. If you still can't find something after searching (including if the organisation's name itself is missing), ask me directly and wait for my answer before writing anything.");
    } else {
      L.push("Everything needed about the role is filled in above \u2014 no need to ask or search for role details.");
    }
    if (values.appeal) {
      L.push("Why this role appeals to me: " + values.appeal);
    } else {
      L.push("One thing you can't look up: why this role genuinely appeals to me. That's personal \u2014 always ask me for it directly, never guess or invent a reason on my behalf.");
    }
    L.push("");

    L.push("=== ABOUT ME ===");
    L.push("Name: " + [profile.personal.firstName, profile.personal.lastName].filter(Boolean).join(" "));
    if (e.degree) {
      L.push("Study: " + GF.mergedDegree(profile) + " at " + (e.institution || "") +
             ", in progress, expected " + (e.expectedGraduation || "TBC"));
    }
    if (e.wam) L.push("WAM: " + e.wam + (e.gpa ? " (GPA " + e.gpa + ")" : ""));
    if (profile.preferences && profile.preferences.availability) {
      L.push("Available: " + profile.preferences.availability);
    }
    (profile.languages || []).forEach(function (l) {
      L.push("Language: " + l.language + " — spoken " + (l.spoken || "n/a") +
             ", written " + (l.written || "n/a"));
    });
    (profile.experience || []).forEach(function (x) {
      L.push("Role: " + x.title + " at " + x.employer + " (" + (x.startDate || "") + "–" +
             (x.current ? "present" : (x.endDate || "")) + ")");
      if (x.description) L.push("  " + x.description);
    });
    if (profile.skills && profile.skills.length) {
      L.push("Skills: " + profile.skills.join(", "));
    }
    L.push("");

    var stars = (profile.starBank || []).filter(function (s) {
      return s.action || s.result;
    });
    if (stars.length) {
      L.push("=== MY EXAMPLES ===");
      stars.forEach(function (s, i) {
        L.push((i+1) + ". " + (s.tag || "example"));
        if (s.situation) L.push("   Situation: " + s.situation);
        if (s.task) L.push("   Task: " + s.task);
        if (s.action) L.push("   Action: " + s.action);
        if (s.result) L.push("   Result: " + s.result);
      });
      L.push("");
    }

    // Anything sourced from the page itself, rather than from what I've
    // told you directly, goes last — furthest from the instructions,
    // clearly separated as background rather than something to lead with.
    if (r.description && !values.does) {
      L.push("=== JOB DESCRIPTION FOUND ON THE PAGE ===");
      L.push(r.description);
      L.push("");
    }

    L.push("=== HOW TO WRITE IT ===");
    L.push("Once you have everything you need (found it, or I've answered your questions): first person, specific, not buzzwords, tied to a real example from my background above where possible.");
    L.push("Respect the word limit (max 250 words unless stated). Give me plain text I can paste straight in.");

    return L.join("\n");
  }

  function buildPrompt(question, profile) {
    var r = ROLE || (ROLE = detectRole());
    var e = GF.primaryEducation(profile) || {};
    var L = [];

    L.push("I'm applying for a graduate role and need help writing my answer to one question on the application form.");
    L.push("");
    L.push("=== BEFORE YOU ANSWER ===");
    L.push("Some lines below may say TODO. If any of them matter for this question and are still TODO, ask me for them first and wait \u2014 do not guess, and do not invent facts about the organisation.");
    L.push("");

    L.push("=== THE QUESTION ===");
    L.push(question);
    L.push("");

    L.push("=== THE ROLE I'M APPLYING FOR ===");
    L.push("(I've filled in what the page told me. Anything marked TODO is for me to complete before sending.)");
    L.push(line("Organisation", r.company, "what is the organisation called?"));
    L.push(line("Role title", r.title, "what is the role called?"));
    L.push(line("Based in", r.location, "where is it based?"));
    L.push(line("Employment type", r.employmentType, "graduate program, full time, contract?"));
    L.push(line("Applications close", r.closes, "when do applications close?"));
    L.push("- What the organisation does, in my words: TODO \u2014 one or two sentences.");
    L.push("- Key requirements from the ad: TODO \u2014 paste the selection criteria or key requirements.");
    L.push("- Why this one genuinely appeals to me: TODO \u2014 a real reason, even a rough one. This is the part only I can supply.");
    L.push("");

    if (r.description) {
      L.push("=== JOB DESCRIPTION FROM THE PAGE ===");
      L.push(r.description);
      L.push("");
    }

    L.push("=== ABOUT ME ===");
    L.push("- Name: " + [profile.personal.firstName, profile.personal.lastName].filter(Boolean).join(" "));
    if (e.degree) {
      L.push("- Study: " + GF.mergedDegree(profile) + " at " + (e.institution || "") +
             ", in progress, expected completion " + (e.expectedGraduation || "TBC"));
    }
    if (e.wam) L.push("- WAM: " + e.wam + (e.gpa ? " (GPA " + e.gpa + ")" : ""));
    if (profile.preferences && profile.preferences.availability) {
      L.push("- Available from: " + profile.preferences.availability);
    }
    (profile.languages || []).forEach(function (l) {
      L.push("- Language: " + l.language + " \u2014 spoken " + (l.spoken || "n/a") +
             ", written " + (l.written || "n/a"));
    });
    (profile.experience || []).forEach(function (x) {
      L.push("- Experience: " + x.title + " at " + x.employer +
             " (" + (x.startDate || "") + "\u2013" + (x.current ? "present" : (x.endDate || "")) + ")" +
             (x.description ? " \u2014 " + x.description : ""));
    });
    if (profile.skills && profile.skills.length) {
      L.push("- Skills: " + profile.skills.join(", "));
    }
    L.push("");

    var stars = (profile.starBank || []).filter(function (s) {
      return s.situation || s.action || s.result;
    });
    if (stars.length) {
      L.push("=== MY EXAMPLES (draw the answer from these, not from invented ones) ===");
      stars.forEach(function (s, i) {
        L.push((i + 1) + ". [" + (s.tag || "example") + "]");
        if (s.situation) L.push("   Situation: " + s.situation);
        if (s.task) L.push("   Task: " + s.task);
        if (s.action) L.push("   Action: " + s.action);
        if (s.result) L.push("   Result: " + s.result);
      });
      L.push("");
    }

    L.push("=== HOW TO WRITE IT ===");
    L.push("- First person, my voice: plain and specific, no buzzwords, no \"passionate about\".");
    L.push("- Use only the facts above. If something is missing, ask me \u2014 never invent an achievement, a metric, or a detail about the organisation.");
    L.push("- Tie the answer to a real example from my background wherever the question allows.");
    L.push("- Mirror the language of the requirements above where it's honest to do so.");
    L.push("- Respect any word or character limit stated in the question. If none is stated, aim for 200\u2013250 words.");
    L.push("- Give me the answer as plain text I can paste straight into the form.");

    return L.join("\n");
  }


  function memoryNorm(s) {
    return String(s || "").toLowerCase().replace(/\b(required|optional|please|enter|select|choose|provide|your|the|a|an)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function memoryTokens(s) { return memoryNorm(s).split(" ").filter(function (x) { return x.length > 1; }); }
  function memoryScore(a, b) {
    var A = memoryTokens(a), B = memoryTokens(b); if (!A.length || !B.length) return 0;
    var setB = new Set(B), hit = A.filter(function (x) { return setB.has(x); }).length;
    return hit / Math.max(A.length, B.length);
  }
  function isActionValue(v) {
    return /^(add|add another|add more|add new|edit|delete|remove|save|cancel|close|next|previous|continue|submit)$/i.test(String(v || "").trim());
  }
  function dateLikeField(f) {
    if (!f) return false;
    if (f.type === "date" || f.type === "month") return true;
    var txt = [f.own, f.context, f.haystack, f.label].filter(Boolean).join(" ");
    return /\b(start date|end date|date started|date ended|from date|to date|startdate|enddate|graduation date|completion date)\b/.test(txt);
  }
  function dateLikeValue(v) {
    var t = String(v || "").trim();
    return /^\d{4}(-\d{2}){0,2}$/.test(t) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(t) || /^\d{1,2}[\/.-]\d{4}$/.test(t) || /^\d{4}$/.test(t);
  }
  function valueCompatibleWithField(v, f) {
    if (v == null || v === "" || isActionValue(v)) return false;
    if (dateLikeField(f)) {
      if (!dateLikeValue(v)) return false;
      var t = String(v).trim();
      var hint = (window.GF && GF.dateFormatHint) ? GF.dateFormatHint(f) : "";
      var needsFull = /dd\s*[\/.-]\s*mm\s*[\/.-]\s*yyyy|mm\s*[\/.-]\s*dd\s*[\/.-]\s*yyyy|yyyy\s*[\/.-]\s*mm\s*[\/.-]\s*dd/.test(hint);
      try {
        var host = String(location.hostname || "").toLowerCase();
        if (/successfactors\.(eu|com)$|\.sapsf\.com$/.test(host) && f.type !== "month") needsFull = true;
      } catch (e) {}
      // Reject stale learned MM/YYYY values when the live field explicitly
      // requires a complete date. This prevents old correction memory from
      // overriding the newer 02/01/2023-style formatting rule.
      if (needsFull && /^\d{1,2}[\/.-]\d{4}$/.test(t)) return false;
    }
    if (f && f.type === "number" && !/^[-+]?\d+(?:\.\d+)?$/.test(String(v).trim())) return false;
    return true;
  }

  function findFieldMemory(haystack, profile, field) {
    var list = (profile && profile.fieldMemory) || [], n = memoryNorm(haystack), best = null, bestScore = 0;
    for (var i = 0; i < list.length; i++) {
      var item = list[i]; if (!item || !item.value || !item.matchText) continue;
      if (!valueCompatibleWithField(item.value, field)) continue;
      var mn = memoryNorm(item.matchText); if (!mn) continue;
      if (mn === n || (n.length > 10 && (n.indexOf(mn) > -1 || mn.indexOf(n) > -1))) return { item: item, exact: true, score: 1 };
      var sc = memoryScore(n, mn); if (sc > bestScore) { bestScore = sc; best = item; }
    }
    return best && bestScore >= 0.82 ? { item: best, exact: false, score: bestScore } : null;
  }
  function findSavedAnswer(profile, question) {
    var q = memoryNorm(question); if (!q) return null;
    var list = (profile && profile.answerLibrary) || [];
    for (var i = 0; i < list.length; i++) if (list[i].answer && memoryNorm(list[i].question) === q) return list[i];
    return null;
  }
  function memoryTextFor(f, fallback) {
    return [f && f.own, f && f.context, f && f.question, fallback].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 700);
  }

  /* ---------- matching ----------
     Own label first. Only widen to the surrounding context if the field's
     own label tells us nothing. */

  function matchOn(haystack, profile, field) {
    for (var i = 0; i < (profile.custom || []).length; i++) {
      var c = profile.custom[i];
      if (c.match && haystack.indexOf(c.match.toLowerCase()) > -1 && valueCompatibleWithField(c.value, field)) {
        return { value: c.value, flag: "", key: "custom" };
      }
    }
    var learned = findFieldMemory(haystack, profile, field);
    if (learned) {
      learned.item.uses = (learned.item.uses || 0) + 1;
      return { value: String(learned.item.value), flag: learned.exact ? "" : "Learned from a similar field — confirm it is right.", key: "memory" };
    }
    for (var j = 0; j < GF.RULES.length; j++) {
      var r = GF.RULES[j];
      if (!r.re.test(haystack)) continue;
      var v;
      try { v = r.val(profile, field); } catch (e) { v = null; }
      if (r.flag && !v) return { value: null, flag: typeof r.flag === "function" ? r.flag(null, profile, field) : r.flag, key: r.key };
      if (!v || !valueCompatibleWithField(v, field)) continue;
      return { value: String(v), flag: typeof r.flag === "function" ? (r.flag(null, profile, field) || "") : (r.flag || ""), key: r.key };
    }
    return null;
  }

  function match(f, profile) {
    // Inside a repeating block, that block's record is the only source.
    if (f.block) {
      var b = resolveInBlock(f, profile);
      if (b) return b;
    }
    return matchOn(f.own, profile, f) ||
           (f.context ? matchOn(f.own + " " + f.context, profile, f) : null);
  }


  /* ---------- repeating blocks ----------
     Fields are grouped by the heading above them, so every field in
     "Work Experience 2" draws from the same record. */

  var BLOCK_COUNTS = {};
  var BLOCK_FIELD_COUNTS = {};

  function collectMarkers() {
    var out = [];
    deepQueryAll(
      'h1,h2,h3,h4,h5,h6,legend,strong,b,[role="heading"],caption'
    ).forEach(function (el) {
      var t = textOf(el);
      if (!t || t.length > 60) return;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      var m = GF.BLOCK_RE.exec(t);
      out.push({
        el: el,
        text: t,
        type: m ? GF.blockType(m[1]) : null,
        index: m && m[2] ? parseInt(m[2], 10) : null
      });
    });

    // SuccessFactors often renders background-section titles as ordinary
    // div/span/p nodes rather than semantic headings. Only exact known
    // titles become markers here.
    deepQueryAll("div,span,p").forEach(function (el) {
      var t = textOf(el);
      if (!t || t.length > 60) return;
      var m = GF.BLOCK_RE.exec(t);
      if (!m) return;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (out.some(function (x) { return x.el === el; })) return;
      out.push({ el: el, text: t, type: GF.blockType(m[1]), index: m[2] ? parseInt(m[2], 10) : null });
    });
    return out;
  }

  function platformBlockHint(f) {
    if (!f || !f.el) return null;
    var el = f.el;
    var rawParts = [el.name, el.id, el.getAttribute("data-automation-id"), el.getAttribute("data-field-id"),
      el.getAttribute("field-id"), el.getAttribute("data-field"), el.getAttribute("data-field-name"),
      el.getAttribute("data-testid"), el.getAttribute("data-test-id"), el.getAttribute("data-qa"),
      el.getAttribute("data-key"), el.getAttribute("data-name")].filter(Boolean);
    // SuccessFactors background rows often put the useful section ID on a
    // parent container while the field itself is just named startDate or
    // endDate. Pull a few ancestor identifiers in so dates cannot fall
    // out of Work Experience and be mistaken for unrelated address fields.
    var anc = el.parentElement, hops = 0;
    while (anc && hops < 6 && anc.tagName !== "BODY") {
      [anc.id, anc.className, anc.getAttribute && anc.getAttribute("data-field-id"),
       anc.getAttribute && anc.getAttribute("data-field"), anc.getAttribute && anc.getAttribute("data-name"),
       anc.getAttribute && anc.getAttribute("aria-label")].forEach(function (v) { if (typeof v === "string" && v.length < 250) rawParts.push(v); });
      anc = anc.parentElement; hops++;
    }
    var raw = rawParts.join(" ");
    var readable = splitIdentifier(raw);
    var ats = GF.resolveATS ? GF.resolveATS() : { key: "generic" };
    var type = null;

    if (/outside\s*work\s*experience|previous\s*employment|employment\s*(details|record|history)|work\s*experience|\b(starttitle|employer)\b/i.test(readable)) type = "experience";
    else if (/formal\s*education|academic\s*qualifications?|education\s*history|(?:^|\W)education(?:\W|$)|(?:^|\W)qualification(?:s)?(?:\W|$)|\b(schoolname|school name|degree type|field of study)\b/i.test(readable)) type = "education";
    else if (/language\s*skills|language\s*proficiency|(?:^|\W)languages?(?:\W|$)|\b(speakingprof|writingprof|readingprof)\b/i.test(readable)) type = "languages";
    if (!type) return null;

    // Extract a row number only when it is attached to a known repeating
    // section token. This avoids treating unrelated generated numeric IDs
    // as record numbers. Covers SAP background elements, Workday repeating
    // experience/education components, and PageUp ASP.NET-style row IDs.
    var token = null, m, patterns;
    if (type === "experience") patterns = [
      /outsideWorkExperience(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /workExperience(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /employment(?:History|Details|Record)?(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /experience(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i
    ];
    else if (type === "education") patterns = [
      /formalEducation(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /education(?:History)?(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /qualification(?:s)?(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i
    ];
    else patterns = [
      /languageSkills?(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /languageProficiency(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i,
      /languages?(?:\W|_)*(?:row(?:\W|_)*)?(\d+)/i
    ];
    for (var i = 0; i < patterns.length && !m; i++) m = patterns[i].exec(raw);
    if (m) token = m[1];

    // Without a record token this hint is safe for SAP's stable background
    // element IDs, but on Workday/PageUp a broad generated ID can refer to
    // the whole section and would collapse multiple rows into record 1. Let
    // visible headings/inline markers handle those cases instead.
    if (token == null && ats.key !== "successfactors") return null;

    return {
      type: type, token: token,
      text: type === "experience" ? "Work Experience" : type === "education" ? "Education" : "Languages",
      platform: ats.key
    };
  }

  function assignBlocks(fields) {
    var markers = collectMarkers();
    BLOCK_COUNTS = {};
    BLOCK_FIELD_COUNTS = {};

    // SAP SuccessFactors exposes stable background-element identifiers even
    // when the visible section heading is not a simple semantic heading.
    // Turn those identifiers into block markers so employer/title/date,
    // formal education and language rows use the matching saved record.
    var platformRanks = {};
    fields.forEach(function (f) {
      var hint = platformBlockHint(f);
      if (!hint) return;
      platformRanks[hint.type] = platformRanks[hint.type] || [];
      var key = hint.token == null ? "__single__" : String(hint.token);
      if (platformRanks[hint.type].indexOf(key) < 0) platformRanks[hint.type].push(key);
      var idx = platformRanks[hint.type].indexOf(key) + 1;
      markers.push({ el: f.el, text: hint.text + " " + idx, type: hint.type, index: idx, platform: true });
    });

    // Some forms bake the block number straight into the first field's
    // own label ("Employment #1 Organisation Name:") instead of using a
    // separate heading — and every other field in that same block (job
    // title, dates, responsibilities) carries no number at all. Treat
    // that first field's own position as a marker too, so everything
    // positioned after it still resolves to the right block even though
    // it's the only one that names it.
    var inlineRe = /\b(outside work experience|previous employment|employment details|employment record|work experience|employment history|employment|experience|position|role|job|formal education|academic qualifications?|education history|education|qualifications?|study|degree|school|language skills|language proficiency|languages?|referee|reference)s?\s*(?:#|no\.?|number)?\s*(\d+)\b/i;
    fields.forEach(function (f) {
      var m = inlineRe.exec(f.label || f.own || "");
      if (!m) return;
      markers.push({ el: f.el, text: m[0], type: GF.blockType(m[1]), index: parseInt(m[2], 10) });
    });

    if (!markers.length) return markers;

    // collectMarkers() concatenates two separate querySelectorAll passes
    // (semantic heading tags first, then plain div/span/p text matching
    // GF.BLOCK_RE second) with no positional relationship between them,
    // and the platform-hint/inline markers just pushed above are appended
    // in field-iteration order, not document order either. Every piece of
    // logic below -- both the "count unnumbered headings in order of
    // appearance" pass and the "closest preceding marker wins" pass in the
    // fields.forEach further down -- silently assumes markers are already
    // in real document order. Confirmed live on CSIRO's SuccessFactors
    // Candidate Profile: "Education"/"Previous Employment" are plain
    // <div>s (caught only by the second collectMarkers() pass, landing at
    // the END of the array) while every later section ("Relocation",
    // "Declaration", etc.) is a <b> tag (caught by the first pass, earlier
    // in the array) -- so without sorting, a field many sections after
    // Education could still resolve to the Education marker, because
    // "last array entry that precedes this field" silently substituted
    // for "closest element that precedes this field" once the array
    // itself stopped being ordered by position.
    markers.sort(function (a, b) {
      var pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // Where a type has numbered headings ("Education 1", "Education 2"), a
    // bare "Education" is the section title, not a third block. Demote it to
    // a boundary so it doesn't inflate the count.
    var numbered = {};
    markers.forEach(function (mk) {
      if (mk.type && mk.index != null) numbered[mk.type] = true;
    });
    markers.forEach(function (mk) {
      if (mk.type && mk.index == null && numbered[mk.type]) mk.type = null;
    });

    // Unnumbered headings that remain are counted in order of appearance.
    var seen = {};
    markers.forEach(function (mk) {
      if (!mk.type) return;
      if (mk.index == null) { seen[mk.type] = (seen[mk.type] || 0) + 1; mk.index = seen[mk.type]; }
      else { seen[mk.type] = Math.max(seen[mk.type] || 0, mk.index); }
      BLOCK_COUNTS[mk.type] = Math.max(BLOCK_COUNTS[mk.type] || 0, mk.index);
    });

    fields.forEach(function (f) {
      var best = null;
      for (var i = 0; i < markers.length; i++) {
        if (markers[i].el === f.el) { best = markers[i]; continue; }
        var pos = markers[i].el.compareDocumentPosition(f.el);
        // The marker sits before this field in the document.
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = markers[i];
      }
      // An untyped heading (e.g. "Personal Details") closes the previous block.
      f.block = best && best.type ? best : null;
      if (f.block) BLOCK_FIELD_COUNTS[f.block.type] = Math.max(BLOCK_FIELD_COUNTS[f.block.type] || 0, f.block.index || 1);
    });

    return markers;
  }

  function resolveInBlock(f, profile) {
    var type = f.block.type;

    // Referees and certifications are never auto-filled.
    if (!GF.BLOCK_COLLECTIONS[type]) {
      return { value: null, flag: type === "referees"
        ? "Referee detail \u2014 fill this in yourself."
        : "Fill this section in yourself." };
    }

    var records = GF.recordsFor(type, profile);
    var rec = records[f.block.index - 1];
    if (!rec) {
      return { value: null, flag: "Nothing saved for " + f.block.text + " \u2014 leave it or remove the block." };
    }

    // One education block on the page, two degrees saved: merge them.
    f.mergeDegrees = (type === "education" && (BLOCK_COUNTS.education || 0) === 1 && records.length > 1);

    var rules = GF.BLOCK_RULES[type] || [];
    for (var i = 0; i < rules.length; i++) {
      if (!rules[i].re.test(f.own)) continue;
      var v;
      try { v = rules[i].val(rec, profile, f); } catch (e) { v = null; }
      if (v == null || v === "" || !valueCompatibleWithField(v, f)) return null;
      var ruleFlag = typeof rules[i].flag === "function" ? (rules[i].flag(rec, profile, f) || "") : (rules[i].flag || "");
      var alternates = [];
      try {
        alternates = typeof rules[i].alts === "function" ? (rules[i].alts(rec, profile, f) || []) : (rules[i].alts || []);
      } catch (e) { alternates = []; }
      return { value: String(v), alternates: alternates.filter(Boolean).map(String), flag: ruleFlag, key: rules[i].key };
    }
    return null;
  }

  /* ---------- expanding a form ----------
     Clicks Add / Add Another only, only as many times as there are
     records left to place, and never anything that submits or deletes. */

  function typeFromTextOrAttrs(text) {
    var t = splitIdentifier(String(text || "")).toLowerCase();
    if (/outside work experience|previous employment|employment history|work experience|employment details/.test(t)) return "experience";
    if (/formal education|academic qualification|education history|education|qualification/.test(t)) return "education";
    if (/language skills|language proficiency|languages?/.test(t)) return "languages";
    return null;
  }

  function addButtonType(el, markers) {
    var parts = [textOf(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.id, el.className,
      el.getAttribute("data-field-id"), el.getAttribute("data-field"), el.getAttribute("data-name")].filter(Boolean);
    var p = el.parentElement, hops = 0;
    while (p && hops < 7 && p.tagName !== "BODY") {
      [p.id, p.className, p.getAttribute && p.getAttribute("data-field-id"), p.getAttribute && p.getAttribute("data-field"),
       p.getAttribute && p.getAttribute("data-name"), p.getAttribute && p.getAttribute("aria-label")].forEach(function (v) { if (typeof v === "string" && v.length < 250) parts.push(v); });
      var h = p.querySelector && p.querySelector('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
      if (h) parts.push(textOf(h));
      var direct = typeFromTextOrAttrs(parts.join(" "));
      if (direct) return direct;
      p = p.parentElement; hops++;
    }
    // Fall back to the closest preceding known section marker.
    var owner = null;
    for (var i = 0; i < markers.length; i++) {
      var pos = markers[i].el.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) owner = markers[i];
    }
    if (owner && owner.type) return owner.type;

    // Zero-row SuccessFactors sections have no fields/markers yet. Classify
    // Add from the nearest preceding background-section header instead.
    var er = el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0 };
    var nearest = null, nearestTop = -Infinity;
    ["experience", "education", "languages"].forEach(function (candidate) {
      var h = bestSectionLabel(candidate);
      if (!h || !visibleElement(h)) return;
      var hr = h.getBoundingClientRect();
      if (hr.top <= er.top + 2 && hr.top > nearestTop) { nearest = candidate; nearestTop = hr.top; }
    });
    return nearest;
  }

  function findAddButtons(markers) {
    var els = deepQueryAll(
      'button, a, [role="button"], input[type="button"], input[type="submit"], [aria-label*="Add" i], [title*="Add" i]'
    );
    var out = [];
    Array.prototype.forEach.call(els, function (el) {
      var t = (textOf(el) || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      if (!GF.ADD_BUTTON_RE.test(t)) return;
      if (GF.NEVER_CLICK_RE.test(t)) return;
      if (el.disabled) return;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;

      var type = addButtonType(el, markers);
      if (type) out.push({ el: el, type: type });
    });
    return out;
  }

  function visibleElement(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var st;
    try { st = getComputedStyle(el); } catch (e) { st = null; }
    return !st || (st.display !== "none" && st.visibility !== "hidden");
  }

  function sectionTypeForToggle(el) {
    if (!el) return null;
    var parts = [textOf(el), el.getAttribute && el.getAttribute("aria-label"), el.getAttribute && el.getAttribute("title"),
      el.id, el.className, el.getAttribute && el.getAttribute("data-field-id"), el.getAttribute && el.getAttribute("data-name")].filter(Boolean);
    var p = el.parentElement, hops = 0;
    while (p && hops < 5 && p.tagName !== "BODY") {
      var h = p.querySelector && p.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],legend');
      if (h) parts.push(textOf(h));
      if (p.getAttribute) {
        [p.getAttribute("aria-label"), p.getAttribute("data-field-id"), p.getAttribute("data-name")].forEach(function (v) { if (v) parts.push(v); });
      }
      p = p.parentElement; hops++;
    }
    return typeFromTextOrAttrs(parts.join(" "));
  }

  function sectionClickTarget(el) {
    if (!el) return null;
    var n = el, hops = 0, fallback = el;
    var baseText = (textOf(el) || "").trim();
    while (n && hops < 6 && n.tagName !== "BODY") {
      if (/^(BUTTON|A|SUMMARY)$/.test(n.tagName) || n.getAttribute("role") === "button" ||
          n.hasAttribute("aria-expanded") || n.hasAttribute("tabindex") || typeof n.onclick === "function") return n;
      // SuccessFactors can attach its accordion handler to an otherwise
      // plain div. If a direct parent contains exactly the same short title
      // as the label we found, it is a better click target than some broad
      // section wrapper several levels up.
      if (hops === 1) {
        var nt = (textOf(n) || "").trim();
        if (baseText && nt === baseText && nt.length < 80) fallback = n;
      }
      n = n.parentElement; hops++;
    }
    return fallback;
  }

  function sectionOpenState(labelEl, type) {
    var target = sectionClickTarget(labelEl);
    if (target && target.hasAttribute && target.hasAttribute("aria-expanded")) {
      return target.getAttribute("aria-expanded") === "true";
    }
    var n = labelEl, hops = 0;
    while (n && hops < 6 && n.tagName !== "BODY") {
      if (n.hasAttribute && n.hasAttribute("aria-expanded")) return n.getAttribute("aria-expanded") === "true";
      n = n.parentElement; hops++;
    }

    // Geometry fallback for SuccessFactors accordions whose arrow/header is
    // a plain clickable div with no aria-expanded state. Anything visible
    // between this section title and the next background-section title means
    // the section is already open; otherwise it is safe to click the header.
    var r = labelEl.getBoundingClientRect();
    var nextTop = Infinity;
    deepQueryAll('h1,h2,h3,h4,h5,h6,[role="heading"],legend,div,span,p').forEach(function (x) {
      if (x === labelEl || !visibleElement(x)) return;
      var tx = (textOf(x) || "").trim();
      if (!tx || tx.length > 60 || !GF.BLOCK_RE.test(tx)) return;
      var xr = x.getBoundingClientRect();
      if (xr.top > r.top + 4 && xr.top < nextTop) nextTop = xr.top;
    });
    var controls = deepQueryAll('input,select,textarea,[role="combobox"],button,a,[role="button"]');
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i]; if (!visibleElement(c)) continue;
      var cr = c.getBoundingClientRect();
      if (cr.top <= r.bottom + 2 || cr.top >= nextTop) continue;
      var ct = (textOf(c) || c.value || c.getAttribute && c.getAttribute("aria-label") || "").trim();
      if (/^(add|add another|add more|add new|\+\s*add)$/i.test(ct) || /^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName) || c.getAttribute("role") === "combobox") return true;
    }
    return false;
  }

  function fireClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  }

  // Background accordions and Add buttons should not drag the applicant up
  // and down the page while GradFill works. Programmatic click() does not
  // require an element to be scrolled into view, so preserve the viewport
  // around these orchestration clicks.
  function fireStableClick(el) {
    if (!el) return false;
    var x = window.scrollX || 0, y = window.scrollY || 0;
    var ok = false;
    var preventNav = function (ev) { ev.preventDefault(); };
    var form = el.form || (el.closest && el.closest("form"));
    var preventSubmit = function (ev) { ev.preventDefault(); };
    try {
      // Accordion/Add controls on several ATSs are anchors or submit-like
      // buttons even though JavaScript handles the real UI action. Prevent
      // the browser's default navigation/submission while still allowing the
      // site's click handler to run; this avoids "Leave site" prompts.
      if (el.tagName === "A" || (el.getAttribute && el.getAttribute("href"))) el.addEventListener("click", preventNav, { capture: true, once: true });
      if (form && /^(BUTTON|INPUT)$/.test(el.tagName) && String(el.type || "").toLowerCase() === "submit") form.addEventListener("submit", preventSubmit, { capture: true, once: true });
      el.click(); ok = true;
    } catch (e) { try { el.click(); ok = true; } catch (e2) {} }
    try { window.scrollTo(x, y); } catch (e) {}
    setTimeout(function () { try { window.scrollTo(x, y); } catch (e) {} }, 40);
    return ok;
  }

  function bestSectionLabel(type) {
    var wanted = {
      experience: /^(outside work experience|work experience|previous employment|employment history|employment details)$/i,
      education: /^(formal education|education|academic qualifications?|education history|qualifications?)$/i,
      languages: /^(language skills|language proficiency|languages?)$/i
    }[type];
    var pool = deepQueryAll('[aria-expanded],button,a,[role="button"],summary,[tabindex],h1,h2,h3,h4,h5,h6,[role="heading"],legend,div,span,p');
    var hits = [];
    pool.forEach(function (el) {
      if (!visibleElement(el)) return;
      var raw = (textOf(el) || (el.getAttribute && el.getAttribute("aria-label")) || "").trim().replace(/\s+/g, " ");
      if (!raw || raw.length > 80 || !wanted.test(raw)) return;
      var semantic = /^(BUTTON|A|SUMMARY|H1|H2|H3|H4|H5|H6|LEGEND)$/.test(el.tagName) || el.getAttribute("role") === "button" || el.hasAttribute("aria-expanded");
      hits.push({ el: el, score: (semantic ? 20 : 0) + (80 - raw.length) });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    if (hits.length) return hits[0].el;
    // Fallback for branded variants such as "My Work Experience" where the
    // clean ATS type is still obvious but the visible title is not exact.
    pool.forEach(function (el) {
      if (!visibleElement(el)) return;
      var raw = (textOf(el) || (el.getAttribute && el.getAttribute("aria-label")) || "").trim().replace(/\s+/g, " ");
      if (!raw || raw.length > 100 || typeFromTextOrAttrs(raw) !== type) return;
      var semantic = /^(BUTTON|A|SUMMARY|H1|H2|H3|H4|H5|H6|LEGEND)$/.test(el.tagName) || el.getAttribute("role") === "button" || el.hasAttribute("aria-expanded");
      hits.push({ el: el, score: (semantic ? 10 : 0) + (100 - raw.length) });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits.length ? hits[0].el : null;
  }

  /* Open collapsed Work Experience / Education / Language sections before
     looking for their Add buttons. SuccessFactors often makes the whole blue
     header clickable without giving the arrow/button an aria-expanded
     attribute, so we recognise exact section labels as well as semantic
     buttons and climb to the nearest clickable header container. */
  function openCollapsedSections(profile) {
    return new Promise(function (resolve) {
      var types = ["experience", "education", "languages"].filter(function (type) {
        return GF.recordsFor(type, profile).length > 0;
      });
      var clicked = 0, i = 0;

      function openOne() {
        if (i >= types.length) return resolve(clicked);
        var type = types[i++], label = bestSectionLabel(type);
        if (!label || sectionOpenState(label, type)) return setTimeout(openOne, 40);

        // First click the exact visible title. Events bubble to the real SAP
        // accordion header on SuccessFactors. If that is not enough, try the
        // nearest likely interactive ancestors one at a time.
        var tries = [label], preferred = sectionClickTarget(label), n = label.parentElement, hops = 0;
        if (preferred && tries.indexOf(preferred) < 0) tries.push(preferred);
        var titleText = (textOf(label) || "").trim().replace(/\s+/g, " ");
        while (n && hops < 6 && n.tagName !== "BODY") {
          var nt = (textOf(n) || "").trim().replace(/\s+/g, " ");
          var st = null; try { st = getComputedStyle(n); } catch (e) {}
          var looksClickable = n.hasAttribute("aria-expanded") || n.getAttribute("role") === "button" || /^(BUTTON|A|SUMMARY)$/.test(n.tagName) || typeof n.onclick === "function" || (st && st.cursor === "pointer");
          var sameHeader = titleText && nt === titleText && nt.length < 90;
          if ((looksClickable || sameHeader) && tries.indexOf(n) < 0) tries.push(n);
          n = n.parentElement; hops++;
        }
        var ti = 0;
        function attempt() {
          if (sectionOpenState(label, type) || ti >= tries.length) return setTimeout(openOne, 120);
          if (fireStableClick(tries[ti++])) clicked++;
          setTimeout(attempt, 260);
        }
        attempt();
      }
      openOne();
    });
  }

  function prepareApplicationSections(profile) {
    var total = 0, cycles = 0;
    function cycle() {
      cycles++;
      return openCollapsedSections(profile).then(function (opened) {
        total += opened;
        return new Promise(function (r) { setTimeout(r, opened ? 650 : 0); });
      }).then(function () {
        return expand(profile);
      }).then(function (added) {
        total += added;
        // SuccessFactors renders each new background row asynchronously.
        // Re-run the open/add pass after the row has mounted so a single
        // Fill click can create Work Experience, Education and Language rows
        // (and more than one saved row when necessary) instead of requiring
        // the user to click Fill repeatedly.
        if (cycles < 8 && added > 0) {
          return new Promise(function (r) { setTimeout(r, 900); }).then(cycle);
        }
        return total;
      });
    }
    return cycle();
  }

  function countVisibleRowsForType(type) {
    var fromBlocks = BLOCK_FIELD_COUNTS[type] || 0;
    if (fromBlocks) return fromBlocks;
    var label = bestSectionLabel(type);
    if (!label) return 0;
    var lr = label.getBoundingClientRect();
    var nextTop = Infinity;
    ["experience", "education", "languages"].forEach(function (other) {
      if (other === type) return;
      var h = bestSectionLabel(other);
      if (!h || !visibleElement(h)) return;
      var hr = h.getBoundingClientRect();
      if (hr.top > lr.top + 3 && hr.top < nextTop) nextTop = hr.top;
    });
    var removes = deepQueryAll('button,a,[role="button"],[aria-label*="Remove" i],[title*="Remove" i]').filter(function (el) {
      if (!visibleElement(el)) return false;
      var r = el.getBoundingClientRect();
      if (r.top <= lr.bottom || r.top >= nextTop) return false;
      var t = (textOf(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      return /^(remove|delete)$/i.test(t);
    });
    if (removes.length) return removes.length;
    var controls = deepQueryAll('input,select,textarea,[role="combobox"]').filter(function (el) {
      if (!visibleElement(el)) return false;
      var r = el.getBoundingClientRect();
      return r.top > lr.bottom && r.top < nextTop;
    });
    return controls.length ? 1 : 0;
  }

  function expand(profile) {
    return new Promise(function (resolve) {
      var fields = collect().map(describe);
      var markers = assignBlocks(fields);

      var buttons = findAddButtons(markers);
      if (!buttons.length) return resolve(0);

      var queue = [];
      Object.keys(GF.BLOCK_COLLECTIONS).forEach(function (type) {
        // Process only one Add action per orchestration cycle. Enterprise ATS
        // pages often animate or re-render after Add; opening three editors at
        // once causes the visible jumping/buffering users reported.
        if (queue.length) return;
        // A section title is not a record. SuccessFactors can show a
        // background section and Add button before any row exists.
        var shown = countVisibleRowsForType(type);
        var sectionPresent = !!bestSectionLabel(type) || buttons.some(function (b) { return b.type === type; });
        if (!sectionPresent) return;              // section isn't on this page
        var have = GF.recordsFor(type, profile).length;
        var need = have - shown;
        if (need <= 0) return;
        var btn = null;
        buttons.forEach(function (b) { if (b.type === type && !btn) btn = b; });
        if (!btn) return;
        // SuccessFactors opens an editor/modal from Add. Clicking the same
        // Add button several times before that editor has mounted causes
        // collisions and can leave the wrong section open. Open one missing
        // row per orchestration cycle; prepareApplicationSections loops again
        // after the row renders, so one Fill click can create every saved record.
        queue.push(btn.el);
      });

      if (!queue.length) return resolve(0);

      var i = 0;
      (function next() {
        if (i >= queue.length) return setTimeout(function () { resolve(queue.length); }, 500);
        try { fireStableClick(queue[i]); } catch (e) {}
        i++;
        setTimeout(next, 400);
      })();
    });
  }

  /* ---------- main scan ---------- */

  /* ---------- shadow DOM ----------
     Enterprise platforms built on web components (Workday and Salesforce-
     based tools among the most common in recruiting) frequently render
     real interactive controls inside an open shadow root for style/script
     isolation. A plain document.querySelectorAll cannot see across that
     boundary at all — not a bug to patch around, a hard limit of the
     query itself — so anything gathering candidate elements needs to
     walk into every open shadow root it finds, not just query the light
     DOM. (A *closed* shadow root is genuinely inaccessible to any script,
     including this one — no workaround exists for that on the web
     platform, by design.) */
  function deepQueryAll(selector, root) {
    root = root || document;
    var out = Array.prototype.slice.call(root.querySelectorAll(selector));
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) out = out.concat(deepQueryAll(selector, all[i].shadowRoot));
    }
    return out;
  }

  function collect() {
    var standard = deepQueryAll("input, select, textarea").filter(function (el) {
      if (el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "reset") return false;
      if (el.disabled || el.readOnly) return false;
      // A real, otherwise-normal-looking form control deliberately marked
      // aria-hidden="true" is a bot-trap convention (confirmed live on
      // Oracle Fusion Cloud Recruiting's own apply form -- a field
      // literally named/labelled "honeypot", sized and positioned like
      // any other input, hidden only from assistive tech and keyboard
      // navigation, not from a naive width/height-based scrape). Filling
      // it would flag the whole application as bot-submitted.
      if (el.getAttribute("aria-hidden") === "true") return false;
      var r = el.getBoundingClientRect();
      // Confirmed live on a real Workday apply form (Telstra): a honeypot
      // input named "website", labelled in plain text "This input is for
      // robots only, do not enter if you're human" -- sized 1px by
      // ~0.01px, not exactly 0x0. An exact-zero check alone missed it
      // (and its label text happened to match the portfolio/website
      // rule, so it would have been filled with a real answer). A tiny
      // nonzero area is exactly as invisible to a human as 0x0 is.
      if (r.width * r.height < 4) return false;
      return true;
    });

    // Long-text fields ("role description", "responsibilities") are
    // frequently a rich-text editor — a contenteditable div, not a real
    // <textarea> — on modern ATS platforms. That's structurally invisible
    // to the query above; nothing about matching or labels is at fault,
    // the element simply isn't one of the tags being asked for. Every
    // other field in the same block can work perfectly while this one
    // silently doesn't, which looks exactly like "everything except the
    // description field" — because it's not the same kind of element at
    // all. Picking up the outermost contenteditable root only (not any
    // nested editor-internal wrapper) avoids collecting the same field
    // several times over.
    var editable = deepQueryAll('[contenteditable="true"], [contenteditable=""]').filter(function (el) {
      if (el.closest('[contenteditable="true"], [contenteditable=""]') !== el) return false;
      var r = el.getBoundingClientRect();
      if (r.width * r.height < 4) return false;
      return true;
    });

    // Some platforms (confirmed live on Oracle Fusion Cloud Recruiting's
    // own apply form — Title, Yes/No declarations, and every language
    // proficiency control) render a single-select choice as a row of real
    // <button> elements carrying aria-pressed rather than as radio inputs
    // or a <select>. aria-pressed is the standard ARIA "toggle button"
    // marker, not an Oracle-specific hook, so this also covers any other
    // platform using the same accessible pattern. Without this, those
    // controls are structurally invisible to collect() the same way a
    // contenteditable description field was before the block above —
    // every ordinary field in the section fills correctly while these
    // silently don't.
    var pills = deepQueryAll('button[aria-pressed]').filter(function (el) {
      if (el.disabled) return false;
      var r = el.getBoundingClientRect();
      if (r.width * r.height < 4) return false;
      return true;
    });

    return standard.concat(editable).concat(pills);
  }

  // Some platforms render a file upload as a custom "Opens a dialogue"
  // control rather than a real <input type="file"> at all -- confirmed
  // live on CSIRO's real SuccessFactors Candidate Profile, whose "Upload
  // a CV" and "Attach a Cover Letter" controls are plain
  // <div role="button">, with no <input type="file"> anywhere in the DOM
  // for collect()'s file-type branch to ever find (the real file input is
  // presumably created on demand, inside whatever dialogue the click
  // opens). Without this, two REQUIRED fields get zero acknowledgement
  // anywhere in the report -- not even the "attach this yourself" note a
  // real <input type="file"> already gets -- which reads as GradFill
  // having nothing to say about them, rather than correctly flagging that
  // they still need the user's own action.
  function attachmentButtonKind(el) {
    var t = [textOf(el), el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ").toLowerCase();
    if (!/\b(upload|attach)\b/.test(t)) return null;
    if (/\b(cv|resume|curriculum vitae)\b/.test(t)) return "resume";
    if (/\b(cover letter)\b/.test(t)) return "coverletter";
    if (/\b(transcript|academic record|statement of results|academic history)\b/.test(t)) return "transcript";
    if (/\b(document|file)\b/.test(t)) return "other";
    return null;
  }

  function collectAttachmentButtons() {
    return deepQueryAll('[role="button"], button, a').filter(function (el) {
      if (!attachmentButtonKind(el)) return false;
      var r = el.getBoundingClientRect();
      if (r.width * r.height < 4) return false;
      return true;
    });
  }

  function trim(s) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > 90 ? s.slice(0, 90) + "\u2026" : s;
  }

  function mergeRoleContext(saved, fresh) {
    saved = saved || {}; fresh = fresh || {};
    var out = {}, keys = ["company", "title", "location", "employmentType", "closes", "requirements", "personalAppeal", "referrerSource"];
    keys.forEach(function (k) { out[k] = fresh[k] || saved[k] || ""; });
    var sd = String(saved.description || ""), fd = String(fresh.description || "");
    out.description = fd.length >= sd.length ? fd : sd;
    return out;
  }

  function scan(profile, roleContext) {
    clearMarks();
    ROLE = mergeRoleContext(roleContext, detectRole());
    UID = 0;
    revealed = false;
    pendingSelects = false;
    NEEDS_RELOCATE_PREF = false;
    var report = [];
    PENDING_MAT_SELECTS = [];
    PENDING_ACCESSIBLE_COMBOS = [];
    PENDING_DATE_FIELDS = [];
    var seenGroups = new Set();
    var nodes = collect();
    var widgetNodes = deepQueryAll(
      '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]'
    ).filter(function (el) {
      if (/^(input|select|textarea)$/i.test(el.tagName)) return false;
      if (el.querySelector("input, select, textarea")) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
    var described = nodes.map(describe);
    var describedWidgets = widgetNodes.map(describe);
    assignBlocks(described.concat(describedWidgets));
    var targetCompany = ROLE && ROLE.company;
    var referrerSource = detectReferrerSource();
    described.forEach(function (d) { d.targetCompany = targetCompany; d.referrerSource = referrerSource; });
    describedWidgets.forEach(function (d) { d.targetCompany = targetCompany; d.referrerSource = referrerSource; });
    var byEl = new Map();
    described.forEach(function (d) { byEl.set(d.el, d); });
    describedWidgets.forEach(function (d) { byEl.set(d.el, d); });

    nodes.forEach(function (el) {
      var f = byEl.get(el) || describe(el);
      var id = "gf" + (++UID);
      el.setAttribute("data-gf-id", id);

      if (GF.NEVER_FILL_RE.test(f.haystack)) {
        mark(el, "check");
        report.push({ id: id, label: trim(f.label), status: "check",
          note: "Sensitive field \u2014 type this in yourself." });
        return;
      }

      if (f.type === "file") {
        mark(el, "check");
        var isTranscript = /\b(academic (record|transcript)|transcript|statement of results|academic history)\b/i.test(f.haystack);
        var isResume = !isTranscript && /\b(resume|cv|curriculum vitae)\b/i.test(f.haystack);
        var note = isTranscript
          ? "This wants your academic record/transcript \u2014 use \u201cSave academic record\u201d in the popup, then attach it here."
          : isResume
            ? "Attach your resume \u2014 use \u201cSave resume\u201d in the popup, then attach it here."
            : "Attach your file here manually \u2014 browsers block scripts from doing it.";
        report.push({ id: id, label: trim(f.label), status: "check", note: note });
        return;
      }

      if (f.type === "pill") {
        var pillGroupEl = pillContainer(el, nodes);
        var pillGroup = pillGroupEl
          ? Array.prototype.filter.call(pillGroupEl.querySelectorAll('button[aria-pressed]'), function (n) { return nodes.indexOf(n) > -1; })
          : [el];
        var pillDedupeKey = pillGroupEl || el;
        if (seenGroups.has(pillDedupeKey)) return;
        seenGroups.add(pillDedupeKey);

        var pq = f.context || f.label;
        var pgm = f.block ? resolveInBlock(f, profile) : null;
        if (!pgm) {
          var pillHaystack = pillGroup.length > 1 ? (f.context || f.own) : (f.own + " " + f.context);
          pgm = matchOn(pillHaystack.trim(), profile, f);
        }
        if (pgm && pgm.value) {
          var pillExact = fillRadio(pillGroup, pgm.value);
          pillGroup.forEach(function (n) { mark(n, pillExact && !pgm.flag ? "ok" : "check"); });
          report.push({ id: id, label: trim(pq), status: pillExact && !pgm.flag ? "ok" : "check",
            value: pgm.value,
            note: pgm.flag || (pillExact ? "" : "Picked the closest option — confirm it's right.") });
        } else {
          pillGroup.forEach(function (n) { mark(n, "prompt"); });
          report.push({ id: id, label: trim(pq), status: "prompt", kind: "field", memoryText: memoryTextFor(f, pq),
            note: (pgm && pgm.flag) || "Blank — no saved answer. Choose it, then run Review scan + learn." });
        }
        return;
      }

      if (f.type === "radio" || f.type === "checkbox") {
        var group, dedupeKey;

        var namedGroup = el.name
          ? nodes.filter(function (n) { return n.name === el.name && n.type === f.type; })
          : null;

        if (f.type === "checkbox" && (!namedGroup || namedGroup.length === 1)) {
          // A name that isn't actually shared (or no name at all) — many
          // "select all that apply" checkbox sets don't share a name
          // attribute, each input often has its own unique one. Fall
          // back to structural grouping: the nearest ancestor that
          // actually contains more than one checkbox.
          var container = checkboxContainer(el, nodes);
          if (container) {
            group = Array.prototype.filter.call(
              container.querySelectorAll('input[type="checkbox"]'),
              function (n) { return nodes.indexOf(n) > -1; }
            );
            dedupeKey = container;
          } else {
            group = namedGroup || [el];
            dedupeKey = el.name ? (el.name + "|checkbox") : el;
          }
        } else {
          group = namedGroup || [el];
          dedupeKey = el.name ? (el.name + "|" + f.type) : el;
        }

        if (seenGroups.has(dedupeKey)) return;
        seenGroups.add(dedupeKey);

        // A lone checkbox is a yes/no toggle, not a pick-one group.
        if (f.type === "checkbox" && group.length === 1) {
          if (GF.NEVER_TICK_RE.test(f.haystack)) {
            mark(el, "check");
            report.push({ id: id, label: trim(f.label), status: "check",
              note: "A declaration \u2014 read it and tick it yourself." });
            return;
          }
          var cm = match(f, profile);
          if (cm && cm.value) {
            if (!el.checked) { el.click(); revealed = true; }
            mark(el, cm.flag ? "check" : "ok");
            report.push({ id: id, label: trim(f.label), status: cm.flag ? "check" : "ok",
              value: "ticked \u2014 " + cm.value, note: cm.flag || "" });
          } else if (f.required) {
            mark(el, "prompt");
            report.push({ id: id, label: trim(f.label), status: "prompt", kind: "field", memoryText: memoryTextFor(f, f.label),
              note: "Blank \u2014 GradFill does not know this answer yet. Fill it, then run Review scan + learn." });
          }
          return;
        }

        // A checkbox group with more than one option is "select all that
        // apply" — a completely different shape from a radio group,
        // which only ever picks one. Handled separately rather than
        // routed through fillRadio, which would only ever tick one box.
        if (f.type === "checkbox" && group.length > 1) {
          var groupQ = f.context || f.label;
          var usedCategory = detectTagCategory(groupQ);
          var hadExplicit = usedCategory && profile.tags && profile.tags[usedCategory] &&
            (profile.tags[usedCategory].none || profile.tags[usedCategory].items.length ||
             (profile.tags[usedCategory].other || []).length);
          var learnedGroup = findFieldMemory(groupQ, profile, f);
          var tickedLabels = learnedGroup ? fillCheckboxGroupFromMemory(group, learnedGroup.item.value) : fillCheckboxGroup(group, profile, groupQ);
          var groupStatus = tickedLabels.length ? (learnedGroup && learnedGroup.exact ? "ok" : "check") : "prompt";
          group.forEach(function (n) { mark(n, groupStatus); });
          report.push({ id: id, label: trim(groupQ), status: groupStatus, kind: tickedLabels.length ? (groupStatus === "ok" ? "learned" : "review") : "field", memoryText: memoryTextFor(f, groupQ),
            value: tickedLabels.length ? "ticked: " + tickedLabels.join(", ") : "",
            note: tickedLabels.length
              ? (learnedGroup
                  ? (learnedGroup.exact ? "Filled from GradFill memory." : "Filled from a similar learned field \u2014 confirm it is right.")
                  : (hadExplicit
                      ? "Ticked from your saved Background answers \u2014 confirm it's right."
                      : "Ticked what matched your saved job titles \u2014 the rest is worth a look yourself. Fill in Setup \u2014 08 Background for this to be exact next time."))
              : "Blank \u2014 no confident match. Select what applies, then run Review scan + learn." });
          return;
        }

        var q = f.context || f.label;
        var gm = f.block ? resolveInBlock(f, profile) : null;
        if (!gm) {
          // For a genuine multi-option group, an individual option's own
          // label ("LinkedIn", "Yes") is really just one of the answer
          // values, not part of the question — folding it into the
          // matching haystack risks it coincidentally colliding with an
          // unrelated rule (an option literally labelled "LinkedIn" would
          // otherwise trigger the saved LinkedIn *profile URL* rule and
          // hijack the whole question). The shared question text alone is
          // the reliable signal once there's more than one option.
          var haystack = group.length > 1 ? (f.context || f.own) : (f.own + " " + f.context);
          gm = matchOn(haystack.trim(), profile, f);
        }
        if (gm && gm.value) {
          var exact = fillRadio(group, gm.value);
          group.forEach(function (n) { mark(n, exact && !gm.flag ? "ok" : "check"); });
          report.push({ id: id, label: trim(q), status: exact && !gm.flag ? "ok" : "check",
            value: gm.value,
            note: gm.flag || (exact ? "" : "Picked the closest option \u2014 confirm it's right.") });
        } else {
          if (gm && gm.key === "relocate") NEEDS_RELOCATE_PREF = true;
          group.forEach(function (n) { mark(n, "prompt"); });
          report.push({ id: id, label: trim(q), status: "prompt", kind: "field", memoryText: memoryTextFor(f, q),
            note: (gm && gm.flag) || "Blank \u2014 no saved answer. Choose it, then run Review scan + learn." });
        }
        return;
      }

      var looksOpen = (f.tag === "textarea") || f.maxlength > 250;
      var savedWritten = looksOpen ? findSavedAnswer(profile, f.question || f.label) : null;
      if (savedWritten && savedWritten.answer) {
        setNative(el, savedWritten.answer);
        mark(el, "check");
        report.push({ id: id, label: trim(f.label), status: "check", value: savedWritten.answer,
          question: f.question || f.label, kind: "openEnded", note: "Filled from your saved answer library — review it for this role." });
        return;
      }
      if (looksOpen && GF.OPEN_ENDED_RE.test(f.haystack)) {
        mark(el, "prompt");
        report.push({ id: id, label: trim(f.label), status: "prompt", kind: "openEnded", memoryText: memoryTextFor(f, f.question || f.label),
          question: f.question || f.label,
          note: "Blank written answer — draft or write it, then Review scan + learn can save your approved version." });
        return;
      }

      var m = match(f, profile);

      if (!m || !m.value) {
        if (looksOpen) {
          mark(el, "prompt");
          report.push({ id: id, label: trim(f.label), status: "prompt", kind: "openEnded", memoryText: memoryTextFor(f, f.question || f.label),
            question: f.question || f.label,
            note: "Blank written answer — complete it, then Review scan + learn can remember the approved answer." });
        } else if (f.required || (m && m.flag)) {
          if (m && m.key === "relocate") NEEDS_RELOCATE_PREF = true;
          mark(el, "prompt");
          report.push({ id: id, label: trim(f.label), status: "prompt", kind: "field", memoryText: memoryTextFor(f, f.label),
            note: (m && m.flag) || "Blank — GradFill has no saved match yet. Fill it, then run Review scan + learn." });
        }
        return;
      }

      var confident = true, selectHit = null, selectedAlternate = false, selectedDisplay = "";
      if (f.tag === "select") {
        if (optionsAreEmpty(el)) pendingSelects = true;
        selectHit = fillSelect(el, m.value, m.alternates || []);
        confident = !!(selectHit && selectHit.option && selectHit.score >= 3);
        selectedAlternate = !!(selectHit && selectHit.usedAlternate);
        selectedDisplay = selectHit && selectHit.option ? (selectHit.option.text || selectHit.option.value) : "";
        if (!confident) {
          var picked = el.value && el.value !== "";
          var selectStatus = picked ? "check" : "prompt";
          mark(el, selectStatus);
          report.push({ id: id, label: trim(f.label), status: selectStatus, kind: picked ? "review" : "field", memoryText: memoryTextFor(f, f.label),
            value: picked ? el.value : "",
            note: picked
              ? "Picked the closest match — confirm it's right."
              : "Blank — no option confidently matched “" + m.value + "”. Pick one, then Review scan + learn." });
          return;
        }
      } else {
        if (dateLikeField(f)) setDateNative(el, m.value); else setNative(el, m.value);
      }

      var isCombo = el.getAttribute("role") === "combobox" ||
                    el.getAttribute("aria-haspopup") === "listbox" ||
                    el.hasAttribute("aria-controls") && el.hasAttribute("aria-expanded");
      var status = (m.flag || selectedAlternate || (isCombo && f.tag !== "select")) ? "check" : "ok";
      mark(el, status);
      var reportItem = { id: id, label: trim(f.label), status: status, value: selectedDisplay || m.value,
        note: selectedAlternate
          ? ("Selected “" + selectedDisplay + "” as the closest available option to “" + m.value + "”.")
          : (m.flag || (isCombo && f.tag !== "select"
            ? "Typed into a dropdown — GradFill will try to commit the matching option; confirm it stayed selected."
            : "")) };
      report.push(reportItem);
      if (dateLikeField(f) && f.tag !== "select") {
        PENDING_DATE_FIELDS.push({ el: el, id: id, label: trim(f.label), value: m.value, reportItem: reportItem });
      }
      if (isCombo && f.tag !== "select") {
        PENDING_ACCESSIBLE_COMBOS.push({ el: el, id: id, label: trim(f.label), value: m.value, alternates: m.alternates || [], flag: m.flag || "", reportItem: reportItem });
      }
    });

    // Dropdowns built from divs/buttons rather than <select>.
    var widgets = widgetNodes;

    widgets.forEach(function (el) {
      var id = "gf" + (++UID);
      el.setAttribute("data-gf-id", id);
      var lab = ownLabel(el).prose || contextLabel(el) || textOf(el) || "(dropdown)";
      var label = trim(lab);

      if (isMatSelect(el)) {
        var already = matSelectCurrentText(el);
        if (already) {
          mark(el, "ok");
          report.push({ id: id, label: label, status: "ok", value: already, note: "" });
          return;
        }
        var f = byEl.get(el) || describe(el);
        var m = match(f, profile);
        if (m && m.value) {
          PENDING_MAT_SELECTS.push({ el: el, id: id, label: label, value: m.value, alternates: m.alternates || [], flag: m.flag || "" });
          return;   // resolved asynchronously after the rest of the scan
        }
      }

      var wf = byEl.get(el) || describe(el), wm = match(wf, profile);
      if (wm && wm.value) {
        mark(el, "check");
        var widgetReport = { id: id, label: label, status: "check", kind: "review", value: wm.value, memoryText: memoryTextFor(wf, label),
          note: "GradFill found the answer and will try to select the matching dropdown option. Confirm it stayed selected." };
        report.push(widgetReport);
        PENDING_ACCESSIBLE_COMBOS.push({ el: el, id: id, label: label, value: wm.value, alternates: wm.alternates || [], flag: wm.flag || "", reportItem: widgetReport });
      } else {
        mark(el, "prompt");
        report.push({ id: id, label: label, status: "prompt", kind: "field", memoryText: memoryTextFor(wf, label),
          note: "Blank custom dropdown \u2014 choose the option, then run Review scan + learn." });
      }
    });

    var attachmentLabels = { resume: "Resume/CV", coverletter: "Cover letter", transcript: "Academic record/transcript", other: "Attachment" };
    collectAttachmentButtons().forEach(function (el) {
      var id = "gf" + (++UID);
      el.setAttribute("data-gf-id", id);
      mark(el, "check");
      var kind = attachmentButtonKind(el);
      var note = kind === "transcript"
        ? "This wants your academic record/transcript — use “Save academic record” in the popup, then attach it here."
        : kind === "resume"
          ? "Attach your resume — use “Save resume” in the popup, then attach it here."
          : kind === "coverletter"
            ? "Attach your cover letter here manually — GradFill can draft one in Resume Studio, but browsers block scripts from attaching files."
            : "Attach your file here manually — browsers block scripts from doing it.";
      report.push({ id: id, label: trim(textOf(el) || attachmentLabels[kind] || "Attachment"), status: "check", note: note });
    });

    LAST_REPORT = report;
    return report;
  }


  /* ---------- Quick Copy side panel ----------
     A manual fallback for stubborn application fields. It lives in a Shadow
     DOM so the host page cannot restyle it, and every visible value is a
     button: click once to copy, then paste into the form yourself. */

  var QUICK_COPY_HOST_ID = "gradfill-quick-copy-host";

  function quickCopyText(value, done) {
    var text = String(value == null ? "" : value);
    if (!text) { done(false); return; }

    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      ta.remove();
      done(ok);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(fallback);
    } else {
      fallback();
    }
  }

  function quickCopyArray(v) {
    if (Array.isArray(v)) return v.filter(Boolean).join(", ");
    return String(v || "");
  }

  function quickCopyRows(profile) {
    profile = profile || {};
    var p = profile.personal || {};
    var e = profile.eligibility || {};
    var pref = profile.preferences || {};
    var groups = [];

    function addGroup(title, rows) {
      var usable = rows.filter(function (r) { return String(r.value || "").trim(); });
      if (usable.length) groups.push({ title: title, rows: usable });
    }

    var fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ");
    var streetAddress = (window.GF && GF.streetAddress) ? GF.streetAddress(p) : p.addressLine1;
    var fullAddress = [streetAddress, p.suburb, p.state, p.postcode, p.country].filter(Boolean).join(", ");
    addGroup("Personal", [
      { label: "Full name", value: fullName },
      { label: "Title", value: p.salutation },
      { label: "First name", value: p.firstName },
      { label: "Middle name", value: p.middleName },
      { label: "Last name", value: p.lastName },
      { label: "Preferred name", value: p.preferredName },
      { label: "Date of birth", value: p.dob },
      { label: "Email", value: p.email },
      { label: "Phone", value: p.phone },
      { label: "Phone type", value: p.phoneType },
      { label: "House number", value: p.houseNumber },
      { label: "Street name", value: p.streetName },
      { label: "Street address", value: streetAddress },
      { label: "Suburb / city", value: p.suburb },
      { label: "State", value: p.state },
      { label: "Postcode", value: p.postcode },
      { label: "Country", value: p.country },
      { label: "Full address", value: fullAddress },
      { label: "LinkedIn", value: p.linkedin },
      { label: "GitHub", value: p.github },
      { label: "Portfolio", value: p.portfolio }
    ]);

    addGroup("Eligibility", [
      { label: "Citizenship", value: e.citizenship },
      { label: "Work rights", value: e.workRights },
      { label: "Security clearance", value: e.securityClearance },
      { label: "Driver's licence", value: e.driversLicence }
    ]);

    (profile.education || []).forEach(function (ed, i) {
      ed = ed || {};
      addGroup("Education " + (i + 1), [
        { label: "Institution", value: ed.institution },
        { label: "Degree", value: ed.degree },
        { label: "Major / field", value: ed.major },
        { label: "Level", value: ed.levelLabel },
        { label: "Type of education", value: ed.educationType },
        { label: "Type of institution", value: ed.institutionType },
        { label: "Institution location", value: ed.location },
        { label: "Institution country", value: ed.country },
        { label: "WAM", value: ed.wam },
        { label: "GPA", value: ed.gpa },
        { label: "Started", value: ed.startDate },
        { label: "Finishing", value: ed.expectedGraduation },
        { label: "Completed", value: ed.completed ? "Yes" : "No" }
      ]);
    });

    (profile.experience || []).forEach(function (job, i) {
      job = job || {};
      addGroup("Experience " + (i + 1), [
        { label: "Employer", value: job.employer },
        { label: "Role title", value: job.title },
        { label: "Type of business", value: job.businessType },
        { label: "Location", value: job.location },
        { label: "Country", value: job.country || (GF.inferCountryFromLocation && GF.inferCountryFromLocation(job.location)) },
        { label: "Started", value: job.startDate },
        { label: "Ended", value: job.current ? "Current" : job.endDate },
        { label: "Description", value: job.description }
      ]);
    });

    addGroup("Skills & preferences", [
      { label: "Skills", value: quickCopyArray(profile.skills) },
      { label: "Availability", value: pref.availability },
      { label: "Salary expectation", value: pref.salaryExpectation },
      { label: "Notice period", value: pref.noticePeriod },
      { label: "Willing to relocate", value: pref.relocate },
      { label: "Preferred team / stream", value: pref.teamStream }
    ]);

    (profile.languages || []).forEach(function (lang, i) {
      lang = lang || {};
      addGroup("Language " + (i + 1), [
        { label: "Language", value: lang.language },
        { label: "Spoken", value: lang.spoken },
        { label: "Written", value: lang.written },
        { label: "Reading", value: lang.reading || lang.written }
      ]);
    });

    (profile.referees || []).forEach(function (ref, i) {
      ref = ref || {};
      addGroup("Referee " + (i + 1), [
        { label: "Name", value: ref.name },
        { label: "Job title", value: ref.title },
        { label: "Organisation", value: ref.org },
        { label: "Relationship", value: ref.relationship },
        { label: "Email", value: ref.email },
        { label: "Phone", value: ref.phone }
      ]);
    });

    return groups;
  }

  function closeQuickCopyPanel() {
    var old = document.getElementById(QUICK_COPY_HOST_ID);
    if (old) old.remove();
  }

  function openQuickCopyPanel(profile) {
    closeQuickCopyPanel();

    var host = document.createElement("div");
    host.id = QUICK_COPY_HOST_ID;
    host.style.setProperty("all", "initial", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "16px", "important");
    host.style.setProperty("right", "16px", "important");
    host.style.setProperty("bottom", "16px", "important");
    host.style.setProperty("width", "min(420px, calc(100vw - 32px))", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("pointer-events", "auto", "important");

    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = `
      :host{all:initial}
      *{box-sizing:border-box}
      .panel{height:100%;display:flex;flex-direction:column;background:#fcfcfa;color:#14202a;border:1px solid #cfd6d2;border-radius:14px;box-shadow:0 18px 60px rgba(20,32,42,.28);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;font-size:13px;line-height:1.4}
      .head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 16px 12px;background:#fcfcfa;border-bottom:1px solid #dde1de}
      .eyebrow{margin:0 0 3px;font:600 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#1f6f5c}
      h2{margin:0;font-size:19px;line-height:1.2;font-weight:650;color:#14202a}
      .sub{margin:6px 0 0;color:#6b7671;font-size:12px;max-width:300px}
      .close{flex:0 0 auto;border:1px solid #dde1de;background:#fff;color:#14202a;width:32px;height:32px;border-radius:8px;font-size:20px;line-height:28px;cursor:pointer}
      .close:hover{border-color:#14202a}
      .scroll{overflow:auto;padding:12px 12px 18px}
      .section{margin:0 0 14px}
      .section-title{margin:0 4px 7px;font:650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#6b7671}
      .row{appearance:none;-webkit-appearance:none;width:100%;display:grid;grid-template-columns:minmax(88px,118px) 1fr auto;align-items:center;gap:10px;text-align:left;padding:10px 10px;margin:0 0 6px;border:1px solid #dde1de;border-radius:9px;background:#fff;color:#14202a;cursor:pointer}
      .row:hover{border-color:#1f6f5c;background:#f4faf7}
      .row:focus-visible{outline:2px solid #4c4f9b;outline-offset:2px}
      .label{font-size:10px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:#6b7671;overflow-wrap:anywhere}
      .value{font-size:13px;font-weight:520;color:#14202a;white-space:pre-wrap;overflow-wrap:anywhere;max-height:82px;overflow:hidden}
      .copy{font:650 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#1f6f5c;border:1px solid rgba(31,111,92,.25);border-radius:999px;padding:5px 7px;background:#f4faf7}
      .empty{padding:24px 16px;color:#6b7671;text-align:center}
      .foot{padding:10px 14px;border-top:1px solid #dde1de;background:#fcfcfa;color:#6b7671;font-size:10px;text-align:center}
      .toast{position:absolute;top:78px;left:50%;transform:translateX(-50%);z-index:5;background:#14202a;color:#fff;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:600;box-shadow:0 6px 20px rgba(20,32,42,.25);opacity:0;pointer-events:none;transition:opacity .14s ease}
      .toast.on{opacity:1}
      @media(max-width:540px){.row{grid-template-columns:92px 1fr}.copy{display:none}.panel{border-radius:10px}.head{padding:14px}.scroll{padding:10px}}
    `;
    shadow.appendChild(style);

    var panel = document.createElement("div");
    panel.className = "panel";
    var head = document.createElement("div");
    head.className = "head";
    var titleWrap = document.createElement("div");
    var eye = document.createElement("p");
    eye.className = "eyebrow";
    eye.textContent = "GradFill";
    var title = document.createElement("h2");
    title.textContent = "Quick Copy";
    var sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = "Click any saved field to copy it, then paste it into the application manually.";
    titleWrap.appendChild(eye); titleWrap.appendChild(title); titleWrap.appendChild(sub);
    var close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.setAttribute("aria-label", "Close Quick Copy");
    close.textContent = "×";
    close.addEventListener("click", closeQuickCopyPanel);
    head.appendChild(titleWrap); head.appendChild(close);

    var scroll = document.createElement("div");
    scroll.className = "scroll";
    var groups = quickCopyRows(profile);
    var toast = document.createElement("div");
    toast.className = "toast";
    var toastTimer = null;
    function showToast(text) {
      toast.textContent = text;
      toast.classList.add("on");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.classList.remove("on"); }, 1100);
    }

    if (!groups.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No saved profile details found yet.";
      scroll.appendChild(empty);
    }

    groups.forEach(function (group) {
      var section = document.createElement("section");
      section.className = "section";
      var h = document.createElement("p");
      h.className = "section-title";
      h.textContent = group.title;
      section.appendChild(h);
      group.rows.forEach(function (item) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "row";
        row.title = "Copy " + item.label;
        var lab = document.createElement("span");
        lab.className = "label";
        lab.textContent = item.label;
        var value = document.createElement("span");
        value.className = "value";
        value.textContent = String(item.value);
        var copy = document.createElement("span");
        copy.className = "copy";
        copy.textContent = "Copy";
        row.appendChild(lab); row.appendChild(value); row.appendChild(copy);
        row.addEventListener("click", function () {
          quickCopyText(item.value, function (ok) {
            showToast(ok ? item.label + " copied" : "Couldn't copy — select the value manually");
          });
        });
        section.appendChild(row);
      });
      scroll.appendChild(section);
    });

    var foot = document.createElement("div");
    foot.className = "foot";
    foot.textContent = "Your saved details stay in GradFill. Nothing is submitted from this panel.";
    panel.appendChild(head); panel.appendChild(toast); panel.appendChild(scroll); panel.appendChild(foot);
    shadow.appendChild(panel);
    (document.documentElement || document.body).appendChild(host);
    return host;
  }


  function currentValueForLearning(el) {
    if (!el) return "";
    if (el.type === "file") return "";
    if (el.type === "radio") {
      var group = el.name ? deepQueryAll('input[type="radio"][name="' + CSS.escape(el.name) + '"]') : [el];
      var checked = group.find(function (n) { return n.checked; });
      return checked ? (ownLabel(checked).prose || checked.value || "Yes") : "";
    }
    if (el.type === "checkbox") {
      var boxes = el.name ? deepQueryAll('input[type="checkbox"][name="' + CSS.escape(el.name) + '"]') : null;
      if (!boxes || boxes.length < 2) {
        var parent = checkboxContainer(el, collect());
        boxes = parent ? Array.prototype.slice.call(parent.querySelectorAll('input[type="checkbox"]')) : [el];
      }
      var vals = boxes.filter(function (n) { return n.checked; }).map(function (n) { return ownLabel(n).prose || n.value || "Yes"; });
      return vals.join(", ");
    }
    if (el.tagName === "SELECT") {
      var o = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return o ? (o.textContent || o.value || "").trim() : (el.value || "");
    }
    if (el.isContentEditable) return textOf(el);
    if (!/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName) && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox")) return textOf(el);
    return String(el.value || "").trim();
  }
  function displayValueNorm(v) {
    return memoryNorm(String(v || "").replace(/^ticked\s*[—-]\s*/i, "").replace(/^ticked:\s*/i, ""));
  }

  function correctionReportFor(el) {
    if (!el) return null;
    var id = el.getAttribute && el.getAttribute("data-gf-id");
    var direct = id && LAST_REPORT.find(function (r) { return r.id === id && (r.status === "prompt" || r.status === "check"); });
    if (direct) return direct;
    var d;
    try { d = describe(el); } catch (e) { return null; }
    var candidateText = memoryTextFor(d, d.label || d.question || "");
    var best = null, bestScore = 0;
    LAST_REPORT.forEach(function (r) {
      if (r.status !== "prompt" && r.status !== "check") return;
      var sc = memoryScore(candidateText, r.memoryText || r.question || r.label || "");
      if (sc > bestScore) { bestScore = sc; best = r; }
    });
    return bestScore >= 0.72 ? best : null;
  }

  function queueCorrectionCandidate(el) {
    var r = correctionReportFor(el); if (!r) return;
    var described;
    try { described = describe(el); } catch (e) { return; }
    if (described.type === "file" || GF.NEVER_FILL_RE.test(described.haystack) || GF.NEVER_TICK_RE.test(described.haystack)) return;
    var val = currentValueForLearning(el); if (!val || isActionValue(val)) return;
    if (r.status === "check" && r.value && displayValueNorm(val) === displayValueNorm(r.value)) return;
    var sig = memoryNorm(r.memoryText || r.question || r.label || "") + "|" + displayValueNorm(val);
    if (el.__gfCorrectionSig === sig) return;
    el.__gfCorrectionSig = sig;
    var item = {
      id: "corr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      label: r.label || described.label || "Field",
      question: r.question || described.question || r.label || "",
      matchText: r.memoryText || memoryTextFor(described, r.label),
      value: val,
      kind: r.kind === "openEnded" ? "openEnded" : "field",
      previousStatus: r.status,
      previousValue: r.value || "",
      pageUrl: location.href,
      pageTitle: document.title,
      createdAt: new Date().toISOString()
    };
    try { chrome.runtime.sendMessage({ type: "GF_CORRECTION_CANDIDATE", candidate: item }); } catch (e) {}
  }

  function installCorrectionWatcher() {
    if (CORRECTION_WATCH_INSTALLED) return;
    CORRECTION_WATCH_INSTALLED = true;
    document.addEventListener("change", function (e) { queueCorrectionCandidate(e.target); }, true);
    document.addEventListener("blur", function (e) { queueCorrectionCandidate(e.target); }, true);
    document.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || (!(t.tagName === "TEXTAREA" || t.isContentEditable) && !(t.tagName === "INPUT" && /^(text|email|tel|url|number|date|month|search)?$/i.test(t.type || "text")))) return;
      clearTimeout(CORRECTION_DEBOUNCE);
      CORRECTION_DEBOUNCE = setTimeout(function () { queueCorrectionCandidate(t); }, 1200);
    }, true);
  }

  function armCorrectionLearning(report) {
    (report || []).forEach(function (r) {
      var el = deepQueryAll('[data-gf-id="' + r.id + '"]')[0] || null;
      if (el) el.setAttribute("data-gf-confidence", r.status || "");
    });
    installCorrectionWatcher();
  }

  function reviewAndLearn() {
    var fields = [], answers = [];
    LAST_REPORT.filter(function (r) { return r.status === "prompt" || r.status === "check"; }).forEach(function (r) {
      var el = deepQueryAll('[data-gf-id="' + r.id + '"]')[0] || null; if (!el) return;
      var val = currentValueForLearning(el); if (!val || isActionValue(val)) return;
      var described = describe(el); if (GF.NEVER_FILL_RE.test(described.haystack) || GF.NEVER_TICK_RE.test(described.haystack) || described.type === "file") return;
      var item = { label: r.label || described.label || "", question: r.question || described.question || r.label || "", matchText: r.memoryText || memoryTextFor(described, r.label), value: val, kind: r.kind || "field", previousStatus: r.status };
      if (r.kind === "openEnded") answers.push(item); else fields.push(item);
    });
    return { fields: fields, answers: answers };
  }

  /* ---------- messaging ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {

    if (msg.type === "GF_BUILD_PROMPT") {
      var prompt = buildPromptWithValues(msg.question, msg.values, msg.profile || {}, msg.roleDescription);
      respond({ prompt: prompt });
      return true;
    }
    if (msg.type === "GF_DETECT_ROLE") {
      respond({ role: detectRole() });
      return true;
    }

    if (msg.type === "GF_FILL") {
      var expander = msg.expand === false ? Promise.resolve(0) : prepareApplicationSections(msg.profile);

      expander.then(function (added) {
        var report;
        try { report = scan(msg.profile, msg.roleContext); }
        catch (e) { respond({ error: e.message }); return; }

        // Ticking a box like "I have a preferred name" reveals new fields.
        // A dropdown may not have its options loaded yet, or may depend on
        // another field (state options often wait on a country choice).
        // A near-empty first scan is its own signal worth retrying for:
        // plenty of real application pages (a WordPress careers page
        // embedding Greenhouse's job board, for instance) load the actual
        // form entirely via a JavaScript widget that's still fetching and
        // rendering at the moment the page "looks" loaded — the form
        // genuinely isn't in the DOM yet when a fast click lands.
        var attemptsLeft = 2;
        var emptyAttemptsLeft = report.length < 2 ? 3 : 0;
        function finish() {
          resolvePendingMatSelects(report).then(function () {
            return resolvePendingAccessibleCombos();
          }).then(function () {
            return resolvePendingDateFields();
          }).then(function () {
            LAST_REPORT = report;
            armCorrectionLearning(report);
            respond({ report: report, added: added, title: document.title, url: location.href,
              needsRelocatePref: NEEDS_RELOCATE_PREF });
          }).catch(function () {
            respond({ report: report, added: added, title: document.title, url: location.href,
              needsRelocatePref: NEEDS_RELOCATE_PREF });
          });
        }
        function maybeRetry() {
          if (emptyAttemptsLeft > 0 && report.length < 2) {
            emptyAttemptsLeft--;
            setTimeout(function () {
              try { report = scan(msg.profile, msg.roleContext); } catch (e) {}
              maybeRetry();
            }, 1200);
            return;
          }
          if (!(revealed || pendingSelects) || attemptsLeft <= 0) {
            finish();
            return;
          }
          attemptsLeft--;
          setTimeout(function () {
            try { report = scan(msg.profile, msg.roleContext); } catch (e) {}
            maybeRetry();
          }, 600);
        }
        maybeRetry();
      }).catch(function (e) {
        respond({ error: e.message });
      });

      return true;
    }
    if (msg.type === "GF_JUMP") {
      var el = deepQueryAll('[data-gf-id="' + msg.id + '"]')[0] || null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
        el.classList.add("gf-pulse");
        setTimeout(function () { el.classList.remove("gf-pulse"); }, 1600);
      }
      respond({ ok: !!el });
      return true;
    }
    if (msg.type === "GF_SET_FIELD") {
      var target = deepQueryAll('[data-gf-id="' + msg.id + '"]')[0] || null;
      if (!target) { respond({ ok: false }); return true; }
      try {
        setNative(target, String(msg.value || ""));
        mark(target, "check");
        respond({ ok: true });
      } catch (e) { respond({ ok: false, error: e.message }); }
      return true;
    }
    if (msg.type === "GF_TOGGLE_QUICK_COPY") {
      var existing = document.getElementById(QUICK_COPY_HOST_ID);
      if (existing) {
        closeQuickCopyPanel();
        respond({ ok: true, open: false });
      } else {
        openQuickCopyPanel(msg.profile || {});
        respond({ ok: true, open: true });
      }
      return true;
    }
    if (msg.type === "GF_REVIEW_LEARN") {
      var learned = reviewAndLearn();
      respond({ ok: true, fields: learned.fields, answers: learned.answers });
      return true;
    }
    if (msg.type === "GF_CLEAR") {
      clearMarks();
      respond({ ok: true });
      return true;
    }
    if (msg.type === "GF_LAST") {
      respond({ report: LAST_REPORT });
      return true;
    }
  });
})();
