/* GradFill — profile shape and field-matching rules.
   Loaded before content.js. Everything hangs off window.GF. */

window.GF = window.GF || {};

GF.EMPTY_PROFILE = {
  personal: {
    salutation: "", firstName: "", middleName: "", lastName: "", preferredName: "",
    dob: "", email: "", phone: "", phoneType: "Mobile",
    houseNumber: "", streetName: "", addressLine1: "", suburb: "", state: "", postcode: "", country: "Australia",
    linkedin: "", github: "", portfolio: ""
  },
  eligibility: {
    citizenship: "", workRights: "", securityClearance: "",
    driversLicence: "", indigenousStatus: "", gender: "", disability: ""
  },
  education: [],   // { institution, degree, major, levelLabel, educationType, institutionType, location, country, startDate, expectedGraduation, completed, wam, gpa, honours }
  experience: [],  // { employer, title, businessType, businessDescription, startDate, endDate, current, location, country, description }
  skills: [],
  languages: [],   // { language, spoken, written, reading }
  referees: [],    // { name, title, org, email, phone, relationship }
  starBank: [],    // { tag, situation, task, action, result }
  preferences: { availability: "", salaryExpectation: "", noticePeriod: "", relocate: "", teamStream: "" },
  applications: [],  // { company, role, status, date, dateSaved, dateApplied, link, location, employmentType, closes, source, keySkills, jobDescription, resumeUsed, notes }
  tags: {
    // Explicit self-declared categories for "select all that apply"
    // checkbox groups — matched directly against your own choices, never
    // inferred from loose text. Each is an array of the standard option
    // strings you've ticked in Setup; a "none" flag distinguishes
    // "I have none of these" from "haven't filled this in yet".
    programs: { items: [], other: [], none: false },
    leadership: { items: [], other: [], none: false },
    extracurricular: { items: [], other: [], none: false },
    industries: { items: [], other: [], none: false }
  },
  custom: [],      // { match: "keyword", value: "answer" }  — checked first
  resumeVersions: [], // { id, name, company, role, createdAt, content, jobId } — reviewed tailored resume drafts
  answerLibrary: [],  // { question, answer, company, role, updatedAt } — user-approved reusable answers
  fieldMemory: [],    // { matchText, label, value, kind, confirmations, uses, updatedAt } — user-approved learned factual fields
  gapDashboard: [],   // { id, matchText, label, kind, encounters, resolved, lastSeenAt } — recurring unknown fields
  resume: null,    // { name, type, data (base64) }
  academicRecord: null  // { name, type, data (base64) } — transcript / academic record
};

/* ---------- value getters ----------
   Each rule resolves to a string, or null if the profile has nothing for it. */

GF.get = function (p, path) {
  return path.split(".").reduce(function (o, k) {
    return o == null ? null : o[k];
  }, p);
};

GF.sameOrg = function (a, b) {
  function norm(s) {
    return String(s || "").toLowerCase()
      .replace(/\b(pty|ltd|limited|inc|incorporated|corp|corporation|group|co)\b\.?/g, "")
      .replace(/[^a-z0-9]/g, "")
      .trim();
  }
  var na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) > -1 || nb.indexOf(na) > -1;
};

/* A question like "Are you a current or previous employee of Bega?" names
   the company right in its own text — a more reliable signal than page-
   level job-ad detection, which often only exists on a job's original
   landing page and not on later steps of a multi-page application. Only
   attempted when the sentence contains a genuine signal word, and pulled
   from the ORIGINAL-case text (haystacks used for rule matching are
   lowercased, which would destroy the very capitalisation this relies on). */
GF.extractCompanyFromText = function (text) {
  if (!text) return null;
  if (!/\b(employee|employed|worked|applied)\b/i.test(text)) return null;
  var clean = text.trim().replace(/[\s*:]+$/, "");
  var m = /\b([A-Z][a-zA-Z&.\u2019'-]*(?:\s+(?:&|and)?\s*[A-Z][a-zA-Z&.\u2019'-]*){0,3})\s*\??\s*$/.exec(clean);
  return m ? m[1].trim() : null;
};

/* Standard option sets for "select all that apply" checkbox groups —
   shared between Setup (the checklist UI) and content.js (matching).
   These are common across many Australian grad-program applications,
   not specific to any one form; unmatched real-world wording still
   falls back to fuzzy matching against whatever you've picked. */
GF.TAG_OPTIONS = {
  programs: [
    "Cooperative (IBL)", "Internship", "Vacation Work",
    "Work Integrated Learning (WIL)", "Clerkship", "Cadetship"
  ],
  leadership: [
    "School Captain", "School Prefect or Leader", "Work Team Leader or Supervisor",
    "Sporting Coach or Captain", "Community/Volunteer Leader",
    "Student Society Leader", "Tutor", "Committee Member"
  ],
  extracurricular: [
    "Music/Theatre/Dance", "Sport", "Community Service/Volunteer",
    "Overseas Travel/Exchange", "Fundraising", "Student Societies", "Debating/Public Speaking"
  ],
  industries: [
    "Agriculture, Forestry & Fishing", "Mining", "Manufacturing",
    "Electricity, Gas, Water, Waste Services", "Construction", "Wholesale Trade",
    "Retail Trade", "Accommodation & Food Services", "Transport, Postal & Warehousing",
    "Information, Media & Telecommunications", "Financial & Insurance Services",
    "Rental, Hiring & Real Estate Services", "Professional, Scientific & Technical Services",
    "Administrative & Support Services", "Public Administration & Safety",
    "Education & Training", "Health Care & Social Assistance", "Arts & Recreation Services"
  ]
};

GF.tertiary = function (p) {
  return (p.education || []).filter(function (e) { return e.level !== "school"; });
};

GF.primaryEducation = function (p) {
  var t = GF.tertiary(p);
  if (!t.length) return (p.education || [])[0] || null;
  var inProgress = t.find(function (e) { return !e.completed; });
  return inProgress || t[0];
};

/* Derived education category for ATS fields that ask for a broad type rather
   than the qualification itself. This is intentionally deterministic so it
   works in Offline Demo too. The value is always flagged for review because
   it is inferred rather than explicitly saved by the user. */
GF.deriveEducationCategory = function (r) {
  r = r || {};
  if (r.educationType) return r.educationType;
  var text = [r.levelLabel, r.degree, r.institution, r.major].filter(Boolean).join(" ").toLowerCase();
  if (/\b(university|bachelor|master|doctor|phd|honou?r|graduate|postgraduate|undergraduate|degree)\b/.test(text)) return "Academic";
  if (/\b(tafe|vet|vocational|trade|apprentice|certificate|diploma)\b/.test(text)) return "Vocational";
  if (/\b(high school|secondary school|hsc|year 12|school certificate)\b/.test(text)) return "School";
  return null;
};

GF.deriveInstitutionCategory = function (r) {
  r = r || {};
  if (r.institutionType) return r.institutionType;
  var text = [r.levelLabel, r.degree, r.institution, r.major].filter(Boolean).join(" ").toLowerCase();
  if (/\b(university|bachelor|master|doctor|phd|honou?r|graduate|postgraduate|undergraduate|degree)\b/.test(text)) return "University";
  if (/\b(tafe|vet|vocational|trade|apprentice)\b/.test(text)) return "TAFE / Vocational";
  if (/\b(high school|secondary school|hsc|year 12|school certificate)\b/.test(text)) return "Secondary School";
  return null;
};



GF.streetAddress = function (personal) {
  personal = personal || {};
  var split = [personal.houseNumber, personal.streetName].filter(function (x) { return x && String(x).trim(); }).join(" ").trim();
  return split || String(personal.addressLine1 || "").trim();
};

GF.canonicalBusinessType = function (r) {
  r = r || {};
  var saved = String(r.businessType || "").trim();
  var corpus = [r.businessType, r.businessDescription, r.title, r.employer, r.description].filter(Boolean).join(" ").toLowerCase();
  // Broad ATS grids usually classify cyber/IT consulting under Information
  // Technology when Consulting is not available as its own category.
  if (/\b(cyber|cybersecurity|information technology|software|network security|cloud|digital security|it consulting|technology consulting)\b/.test(corpus)) {
    if (!saved || /consult|media|telecom|professional services/i.test(saved)) return "Information Technology";
  }
  return saved || null;
};

GF.inferCountryFromLocation = function (locationText, explicitCountry) {
  if (explicitCountry && String(explicitCountry).trim()) return String(explicitCountry).trim();
  var t = String(locationText || "").toLowerCase();
  if (!t) return null;
  if (/\b(australia|nsw|new south wales|vic|victoria|qld|queensland|wa|western australia|sa|south australia|tas|tasmania|act|australian capital territory|nt|northern territory|sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin)\b/.test(t)) return "Australia";
  if (/\b(united arab emirates|u\.?a\.?e\.?|dubai|abu dhabi|sharjah|ajman|ras al khaimah|fujairah)\b/.test(t)) return "United Arab Emirates";
  if (/\b(united kingdom|u\.?k\.?|england|scotland|wales|northern ireland|london|manchester|birmingham|edinburgh|glasgow)\b/.test(t)) return "United Kingdom";
  if (/\b(new zealand|auckland|wellington|christchurch)\b/.test(t)) return "New Zealand";
  if (/\b(singapore)\b/.test(t)) return "Singapore";
  if (/\b(hong kong)\b/.test(t)) return "Hong Kong";
  return null;
};

GF.businessTypeAlternates = function (r) {
  r = r || {};
  var primary = String(GF.canonicalBusinessType(r) || r.businessType || "").toLowerCase();
  var corpus = [r.businessType, r.businessDescription, r.title, r.employer, r.description].filter(Boolean).join(" ").toLowerCase();
  var out = [];
  function add(v) { if (v && out.indexOf(v) < 0 && String(v).toLowerCase() !== primary) out.push(v); }
  // If the saved business description is "Consulting" but the role itself is
  // clearly technical/cyber, broad ATS grids commonly classify it under IT.
  if (/consult/.test(primary) && /\b(cyber|security|software|technology|technical|digital|network|cloud|data|developer|engineer|it)\b/.test(corpus)) {
    add("Information Technology");
    add("Information, Media & Telecommunications");
    add("Professional, Scientific & Technical Services");
  }
  if (/\b(cyber|software|information technology|technology|network|cloud|data|developer|engineer|it security)\b/.test(corpus)) {
    add("Information Technology");
    add("Information, Media & Telecommunications");
    add("Professional, Scientific & Technical Services");
  }
  return out;
};

GF.educationGrade = function (r) {
  r = r || {};
  if (r.wam != null && String(r.wam).trim() !== "") return String(r.wam);
  if (r.gpa != null && String(r.gpa).trim() !== "") return String(r.gpa);
  if (r.honours) return String(r.honours);
  return null;
};

/* When a form has room for only one degree, the two UTS degrees merge. */
GF.mergedDegree = function (p) {
  var live = GF.tertiary(p).filter(function (e) { return !e.completed; });
  if (!live.length) { var e = GF.primaryEducation(p); return e && e.degree; }
  if (live.length === 1) return live[0].degree;
  var stems = live.map(function (e) {
    return String(e.degree).replace(/^bachelors?\s+of\s+/i, "").trim();
  });
  var prefix = /^(bachelors?\s+of\s+)/i.exec(live[0].degree);
  var lead = prefix ? prefix[1].replace(/bachelors\b/i, "Bachelor") : "";
  return lead + stems.slice(0, -1).join(", ") + " and " + stems[stems.length - 1];
};

GF.latestExperience = function (p) {
  if (!p.experience || !p.experience.length) return null;
  return p.experience.find(function (e) { return e.current; }) || p.experience[0];
};

/* ---------- date helpers ---------- */

GF.toISO = function (v) { return v || ""; };

GF.toAU = function (v) {
  if (!v) return "";
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return m[3] + "/" + m[2] + "/" + m[1];
  var ym = /^(\d{4})-(\d{2})$/.exec(v);
  if (ym) return ym[2] + "/" + ym[1];
  return v;
};

GF.year = function (v) {
  var m = /^(\d{4})/.exec(v || "");
  return m ? m[1] : "";
};


/* ---------- option synonyms ----------
   A saved value of "NSW" has to find an option labelled "New South Wales",
   and vice versa. Substring matching alone never gets there. */

GF.SYNONYM_PAIRS = [
  ["nsw", "new south wales"],
  ["vic", "victoria"],
  ["qld", "queensland"],
  ["wa", "western australia"],
  ["sa", "south australia"],
  ["tas", "tasmania"],
  ["act", "australian capital territory"],
  ["nt", "northern territory"],
  ["au", "australia"],
  ["aus", "australia"],
  ["mobile", "mobile phone"],
  ["mobile", "cell phone"],
  ["mobile", "cell"],
  ["home", "home phone"],
  ["home", "landline"],
  ["yes", "y"],
  ["no", "n"],
  ["male", "m"],
  ["female", "f"],
  ["mr", "mister"],
  ["bachelor", "bachelors"],
  ["australian citizen", "citizen of australia"],
  ["australian citizen", "australian citizenship"],
  ["none", "no adjustments required"],
  ["none", "no adjustments needed"],
  ["none", "no disability"],
  ["none", "n/a"],
  ["prefer not to say", "prefer not to answer"],
  ["no", "heterosexual"],
  ["no", "straight"],
  // A "discipline" dropdown often won't offer "Cybersecurity" as its own
  // option — fall back to whichever closely related field the form
  // actually lists, tried in rough order of closeness.
  ["cybersecurity", "information technology"],
  ["cybersecurity", "computer science"],
  ["cybersecurity", "information systems"],
  ["cybersecurity", "information technology and systems"],
  ["cybersecurity", "computing"],
  ["cybersecurity", "software security"],
  ["cybersecurity", "network security"],
  ["cybersecurity", "it security"],
  ["cybersecurity", "security studies"],
  ["bachelor degree", "bachelor's"],
  ["bachelor degree", "bachelors"],
  ["bachelor degree", "bachelor's degree"],
  ["bachelor degree", "undergraduate degree"],
  ["university", "academic institution"],
  ["university", "university / college"],
  ["university", "higher education institution"],
  ["tafe / vocational", "vocational institution"],
  ["secondary school", "school"],
  ["master degree", "master's"],
  ["master degree", "masters"],
  ["master degree", "master's degree"],
  ["native", "native speaker"],
  ["native", "mother tongue"],
  ["native", "native / bilingual"],
  ["native", "native or bilingual proficiency"],
  ["fluent", "full professional proficiency"],
  ["fluent", "professional proficiency"],
  ["conversational", "intermediate"],
  ["basic", "elementary"]
];

GF.SYNONYMS = (function () {
  var map = {};
  function key(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function add(a, b) { (map[key(a)] = map[key(a)] || []).push(b); }
  GF.SYNONYM_PAIRS.forEach(function (pair) {
    add(pair[0], pair[1]);
    add(pair[1], pair[0]);
  });
  return map;
})();

/* ---------- the rules ----------
   order matters: the first rule whose pattern hits wins, so specific
   phrases sit above the general ones. */

GF.RULES = [
  // --- referee fields must be tested BEFORE your own name/contact rules,
  //     or "Referee email" quietly gets your own address ---
  // Referees are never auto-filled. Always handed back to you.
  { key: "referee", re: /\b(referee|reference)\b(?!\s*(number|no\b))/,
    val: function () { return null; },
    flag: "Referee detail \u2014 fill this in yourself." },

  // --- names ---
  { key: "preferredName", re: /\b(preferred|known as|goes by|nickname)\b.*\bname\b|\bpreferred[_-]?name\b/,
    val: function (p) { return p.personal.preferredName; } },
  { key: "firstName", re: /\b(first|given|fore)[\s_-]*name\b|\bfname\b/,
    val: function (p) { return p.personal.firstName; } },
  { key: "middleName", re: /\bmiddle[\s_-]*name\b/,
    val: function (p) { return p.personal.middleName; } },
  { key: "lastName", re: /\b(last|family|sur)[\s_-]*name\b|\bsurname\b|\blname\b/,
    val: function (p) { return p.personal.lastName; } },

  { key: "fullName",
    re: /^(?!.*\b(given|first|fore|middle|family|last|sur|preferred|maiden)\b)(?=.*\b(full|legal|complete)[\s_-]*name\b|.*\byour name\b)/,
    val: function (p) { return [p.personal.firstName, p.personal.lastName].filter(Boolean).join(" "); } },

  // "Title" on its own is usually Mr/Ms, not a job. Never guess it.
  { key: "salutation", re: /^(?!.*\b(job|position|role|referee|award)\b)(?=.*\b(salutation|prefix|title)\b)/,
    val: function (p) { return p.personal.salutation; } },

  // --- contact ---
  { key: "email", re: /\be-?mail\b/, val: function (p) { return p.personal.email; } },
  { key: "phoneType", re: /\b(device|phone|contact|number) type\b|\btype of (phone|number|device|contact)\b/,
    val: function (p) { return p.personal.phoneType; } },
  // GradFill's profile only ever stores ONE phone number, tagged with a
  // single phoneType (Mobile/Home/Work). A form asking specifically for a
  // DIFFERENT type than what's saved is a guess, not a fact -- confirmed
  // live on CSIRO's real SuccessFactors Candidate Profile, whose "Phone
  // Number - Home" and "Phone Number - Work" fields both silently got the
  // saved Mobile number with zero warning before this fix. A field that
  // doesn't name a specific type at all ("Phone", "Contact number") still
  // stays green -- there's nothing to warn about when the form itself
  // hasn't asked for one type over another.
  { key: "phone", re: /\b(phone|mobile|contact number|telephone|cell)\b/,
    val: function (p) { return p.personal.phone; },
    flag: function (rec, p, f) {
      var savedType = String((p.personal && p.personal.phoneType) || "mobile").toLowerCase();
      // f.own only, not f.haystack (own+context) -- context can legitimately
      // pick up a NEIGHBOURING field's own label as prose (confirmed live:
      // CSIRO's Mobile/Home/Work phone labels are <label for="..."> siblings,
      // not labels wrapping their input, so looksLikeOrdinaryFieldLabel()
      // doesn't recognise them as a field label to skip -- nearestPrecedingText
      // picks up "Phone Number - Mobile" as context for the very next field,
      // "Phone Number - Home"). own is scoped to this field's own label
      // association only, so it doesn't have that contamination risk.
      var text = (f && f.own) || "";
      var askedTypes = [];
      if (/\bmobile\b|\bcell\b/.test(text)) askedTypes.push("mobile");
      if (/\bhome\b|\blandline\b/.test(text)) askedTypes.push("home");
      if (/\bwork\b|\bbusiness\b/.test(text)) askedTypes.push("work");
      if (!askedTypes.length || askedTypes.indexOf(savedType) > -1) return "";
      return "This is your saved " + (p.personal.phoneType || "phone") + " number — this field asks for a different phone type, so confirm it's right (or leave it blank if you don't have one).";
    } },
  { key: "linkedin", re: /\blinked-?in\b/, val: function (p) { return p.personal.linkedin; } },
  { key: "github", re: /\bgit-?hub\b/, val: function (p) { return p.personal.github; } },
  { key: "portfolio", re: /\b(portfolio|personal (web)?site|website|url)\b/,
    val: function (p) { return p.personal.portfolio; } },

  // --- date of birth (before the address block, so "birth" never reads as a place) ---
  { key: "dob", re: /\b(date of birth|birth ?date|d\.?o\.?b\.?|born)\b/,
    val: function (p, f) { return f.type === "date" ? GF.toISO(p.personal.dob) : GF.toAU(p.personal.dob); } },

  // --- eligibility (before "country", so "country of citizenship" resolves right) ---
  { key: "citizenship", re: /\b(citizen|citizenship|nationality)\b/,
    val: function (p) { return p.eligibility.citizenship; } },
  { key: "workRights", re: /\b(work rights|right to work|legally (entitled|authoris|author)|visa status|work authoris)/,
    val: function (p) { return p.eligibility.workRights; } },
  { key: "securityClearance", re: /\b(security clearance|clearance level|baseline|nv1|nv2)\b/,
    val: function (p) { return p.eligibility.securityClearance; },
    flag: "Clearance wording differs by agency — check this matches what they asked." },
  { key: "driversLicenceYN",
    re: /\bdo you (currently )?(hold|have)\b.*\bdriver'?s? licen[cs]e\b|\bdo you have a valid\b.*\blicen[cs]e\b/,
    val: function (p) { return p.eligibility.driversLicence ? "Yes" : "No"; } },
  { key: "driversLicence", re: /\b(driver'?s? licen[cs]e|drivers licen)/,
    val: function (p) { return p.eligibility.driversLicence; } },

  // --- previous employer / previous applicant ---
  // "Are you a current or previous employee of [Company]?" names the
  // company right in its own text — try pulling it directly from the
  // question first (works on any page of a multi-step application, since
  // it doesn't depend on job-ad metadata that often only exists on the
  // original landing page), falling back to page-level detection.
  { key: "previousEmployee",
    re: /\b(current(ly)? or previous(ly)?|previous(ly)?)\b.*\b(employ(ee|ed)|worker)\b|\bhave you (previously )?work(ed)?\b.*\b(for|at)\b.*\?/,
    val: function (p, f) {
      var company = (f && GF.extractCompanyFromText(f.contextRaw || f.label)) || (f && f.targetCompany);
      if (!company) return null;
      var worked = (p.experience || []).some(function (e) {
        return e.employer && GF.sameOrg(e.employer, company);
      });
      return worked ? "Yes" : "No";
    },
    flag: "Checked against your saved work history \u2014 confirm this is right." },

  // "Have you previously applied for a role with [Company]?" — checked
  // against your saved applications list (Setup \u2014 Applications).
  // Defaults to No when nothing's on record, since that's the safe
  // assumption for a role you've never logged as applied to.
  { key: "previouslyApplied",
    re: /\bhave you (previously |ever )?applied\b/,
    val: function (p, f) {
      var company = (f && GF.extractCompanyFromText(f.contextRaw || f.label)) || (f && f.targetCompany);
      if (!company) return "No";
      var applied = (p.applications || []).some(function (a) {
        // Legacy entries pre-date statuses and were only ever created
        // after submission, so keep treating those as applied. New
        // "Saved" bookmarks must not make this answer Yes.
        var status = String(a.status || "").toLowerCase();
        var countsAsApplied = !a.status ||
          ["applied", "assessment", "interview", "offer", "rejected", "withdrawn"].indexOf(status) > -1;
        return countsAsApplied && a.company && GF.sameOrg(a.company, company);
      });
      return applied ? "Yes" : "No";
    },
    flag: "Checked against your saved applications list \u2014 confirm this is right." },

  // --- procedural / compliance willingness ---
  // Near-universal gate questions on grad program applications. Always
  // flagged, since "willing" is a real personal decision, not a fact —
  // just usually the same answer for someone actually applying.
  { key: "willingChecks",
    re: /\bwilling\b.*\b(undergo|complete)\b.*\bcheck|\bconsent\b.*\b(background|police|reference)\s*check/,
    val: function () { return "Yes"; },
    flag: "Assumed you're willing \u2014 confirm before submitting." },
  { key: "availableSelectionStages",
    re: /\bavailable\b.*\b(attend|all selection stages|interview)|\bable to attend\b.*\b(interview|assessment|selection)/,
    val: function () { return "Yes"; },
    flag: "Assumed you're available \u2014 confirm before submitting." },
  { key: "freeToCommence",
    re: /\bfree to commence\b|\bcomplete\b.*\brequired date\b|\bcomplete the required qualification\b/,
    val: function () { return "Yes"; },
    flag: "Assumed based on your saved graduation date \u2014 confirm the timing works." },
  { key: "willingAssessment",
    re: /\bwilling\b.*\b(complete|undertake|undergo)\b.*\b(online )?(assessment|psychometric|cognitive|aptitude)\b|\bconsent\b.*\b(psychometric|online assessment)\b/,
    val: function () { return "Yes"; },
    flag: "Assumed you're willing \u2014 confirm before submitting." },
  { key: "officeAttendance",
    re: /\bable to work\b.*\b(office|on-?site|in-?person)\b|\bwilling\b.*\b(attend|work from|come into|be in)\b.*\boffice\b|\bhybrid\b.*\b(days?|times?)\b.*\boffice\b|\bable to (attend|be in|work from)\b.*\boffice\b/,
    val: function () { return "Yes"; },
    flag: "Assumed you're able to \u2014 confirm before submitting." },

  { key: "preferredTeamStream",
    re: /\b(team|stream|business area|division|specialisation|specialization)\b.*\bprefer|\bwhich (team|stream|area)\b.*\b(interest|prefer)/,
    val: function (p) { return p.preferences.teamStream; },
    flag: "This is your saved general preference \u2014 exact team names vary by employer, so check it matches what's actually on offer here." },

  { key: "indigenousStatus",
    re: /\b(aboriginal|torres strait|indigenous|first nations?|first peoples?)\b/,
    val: function (p) { return p.eligibility.indigenousStatus; },
    flag: "Identity question — confirm you're happy with this answer." },
  { key: "pronouns", re: /\bpronouns?\b/,
    val: function (p) { return p.eligibility.pronouns; },
    flag: "Identity question — confirm you're happy with this answer." },
  { key: "lgbtqia",
    re: /\blgbtqia?\+?\b|\blgbt\+?\b|\bqueer\b|\bsexual(ly)?(?:\s+and\/?or)?\s+gender diverse\b|\bsexual orientation\b|\bsexual identity\b|\bgay,?\s*lesbian\b/,
    val: function (p) { return p.eligibility.lgbtqia; },
    flag: "Identity question — confirm you're happy with this answer." },
  { key: "culturallyDiverse",
    re: /\b(culturally|linguistically)\b.*\bdivers|\bcald\b|\bnesb\b|\bethnic (minority|background)\b|\bnon-english speaking background\b/,
    val: function (p) { return p.eligibility.culturallyDiverse; },
    flag: "Identity question — confirm you're happy with this answer." },
  { key: "firstInFamily",
    re: /\bfirst\b.*\bfamily\b.*\b(graduat|university|higher education)\b|\bfirst[- ]generation\b.*\b(university|student|graduat|college)\b|\bfirst in (my |your |the )?family\b/,
    val: function (p) { return p.eligibility.firstInFamily; },
    flag: "Identity question — confirm you're happy with this answer." },
  { key: "minorityGroup",
    re: /\bminority group\b|\bunderrepresented group\b|\bmarginali[sz]ed group\b/,
    val: function (p) { return p.eligibility.minorityGroup; },
    flag: "Identity question — confirm you're happy with this answer." },
  // A question asking to enumerate languages ("please list...", "state
  // any languages...", "which languages do you speak") wants the actual
  // list, not a yes/no. This has to be checked before the plain yes/no
  // language rule below, since a lot of the same wording ("languages...
  // other than English") appears in both — "list" and similar cue words
  // are what tell them apart.
  { key: "listLanguages",
    re: /\b(list|state|specify|name)\b.*\blanguages?\b|\blanguages?\b.*\b(list|state|specify|name)\b|\bwhich languages?\b.*\bspeak\b/,
    val: function (p) {
      var others = (p.languages || []).filter(function (l) {
        return l.language && l.language.toLowerCase() !== "english" && (l.spoken || l.written);
      });
      if (!others.length) return "None";
      return others.map(function (l) {
        return l.language + " (" + (l.spoken || l.written) + ")";
      }).join(", ");
    } },
  { key: "languagesOtherThanEnglish", re: /\blanguages?\b.*\bother than english\b|\bproficient\b.*\blanguages?\b/,
    val: function (p) {
      var others = (p.languages || []).filter(function (l) {
        return l.language && l.language.toLowerCase() !== "english" && (l.spoken || l.written);
      });
      return others.length ? "Yes" : "No";
    } },
  { key: "gender", re: /\b(gender|sex)\b/, val: function (p) { return p.eligibility.gender; } },
  { key: "disability", re: /\b(disabilit|accessibility requirement|adjustment)/,
    val: function (p) { return p.eligibility.disability; },
    flag: "Personal question — confirm you're happy with this answer." },

  // --- address ---
  // "Home Address" and similarly general wordings are asking for the whole
  // thing written out, even on a form that also has separate suburb/state/
  // country boxes of its own — a specific "Street" or "Address Line 1"
  // field is the one that means just the street.
  { key: "fullAddress",
    re: /\b(home address|residential address|mailing address|current address)\b/,
    val: function (p) {
      var line2 = [p.personal.suburb, p.personal.state, p.personal.postcode].filter(Boolean).join(" ");
      return [GF.streetAddress(p.personal), line2, p.personal.country].filter(Boolean).join(", ");
    } },
  { key: "houseNumber",
    re: /\b(house|street|building|property)\s*(number|no\.?|#)\b|\bnumber of (house|street|building)\b/,
    val: function (p) { return p.personal.houseNumber; } },
  { key: "streetName",
    re: /\b(street name|road name|street \/ road|road \/ street)\b/,
    val: function (p) { return p.personal.streetName; } },
  // Bare "Street" (no "address"/"name" qualifier) added as a plain word
  // — the old whole-string anchor here was dead against f.own for the
  // same reason as the block-rule anchors this audit fixed elsewhere.
  { key: "addressLine1",
    re: /\b(street address|address ?line ?1|address1|address line|address|street)\b/,
    val: function (p) { return GF.streetAddress(p.personal); } },
  { key: "suburb", re: /\b(suburb|city|town|locality)\b/, val: function (p) { return p.personal.suburb; } },
  { key: "state", re: /\b(state|province|territory)\b/, val: function (p) { return p.personal.state; } },
  { key: "postcode", re: /\b(post-?code|zip|postal code)\b/, val: function (p) { return p.personal.postcode; } },
  { key: "country", re: /\bcountry\b/, val: function (p) { return p.personal.country; } },

  // --- education: the graduation guards sit above everything else ---

  // "Have you completed/are you completing any postgraduate study?" is a
  // yes/no about postgrad specifically — checked ahead of
  // completedQualification below, whose "have you completed" wording is
  // broad enough to otherwise claim this and answer with a qualification
  // name where a yes/no was wanted.
  { key: "postgradStudy",
    re: /\bpostgraduate study\b|\bpostgraduate (degree|qualification)\b.*\?|\bcompleting\b.*\bpostgraduate\b/,
    val: function (p) {
      var has = (p.education || []).some(function (e) {
        return /master|phd|doctorate|postgrad/i.test(e.degree || "");
      });
      return has ? "Yes" : "No";
    },
    flag: "Checked against your saved education \u2014 confirm this is right." },

  { key: "completedQualification",
    re: /\b(highest (level of )?(qualification|education)|have you (completed|graduated)|qualification completed|completed your (degree|study|studies)|completion status)\b/,
    val: function (p) {
      var school = (p.education || []).filter(function (e) { return e.completed; });
      return school.length ? school[school.length - 1].degree : null;
    },
    flag: "Your degree is still in progress \u2014 this answers with your last completed qualification. Check it fits the question." },

  // A "which year did/will you complete your degree" question wants a
  // year bucket, not a date or the degree's name. Checked ahead of every
  // other education rule here: several of them use broad "degree...X"
  // patterns that can span across an unrelated sentence in the same
  // paragraph (a lead-in about "the start date", a "please note" caveat)
  // and claim this question first.
  { key: "graduationYearBucket",
    re: /\bin which year\b.*\b(complete|graduat)/,
    val: function (p) {
      var e = GF.primaryEducation(p);
      if (!e || !e.expectedGraduation) return null;
      var m = /^(\d{4})-(\d{2})/.exec(e.expectedGraduation);
      if (!m) return null;
      var year = parseInt(m[1], 10), month = parseInt(m[2], 10);
      if (year < 2024) return "Prior to 2024";
      if (year === 2027 && month === 1) return "January 2027";
      if (year > 2027 || (year === 2027 && month > 1)) return "Post January 2027";
      return String(year);
    },
    flag: "Built from your saved graduation date \u2014 check it matches this form's buckets." },

  // A plain "which year did you commence / will you complete" question,
  // offered as a bare-year dropdown (2015, 2016 ... 2027) rather than a
  // full date field. Needs its own bare-year value to match cleanly —
  // feeding a full formatted date into a dropdown of single years won't
  // score a confident match. "Commenced" and "anticipate" aren't
  // recognised by the generic date rules below, so without this the
  // question falls through to "degree" and returns a degree name where a
  // year was wanted.
  { key: "startYearOnly", re: /\byear\b.*\bcommenc/,
    val: function (p) {
      var e = GF.primaryEducation(p);
      var m = e && e.startDate && /^(\d{4})/.exec(e.startDate);
      return m ? m[1] : null;
    } },
  { key: "completionYearOnly", re: /\byear\b.*\b(complet|anticipat|graduat|finish)/,
    val: function (p) {
      var e = GF.primaryEducation(p);
      var m = e && e.expectedGraduation && /^(\d{4})/.exec(e.expectedGraduation);
      return m ? m[1] : null;
    } },

  // "End date" and "start date" alone are ambiguous out of context — could
  // mean a job, could mean a degree — but within an education block
  // they're a safe, common shorthand for graduation and enrolment dates,
  // and this generic layer is only reached when block-matching hasn't
  // already claimed the field. Guarded against an obviously employment-
  // labelled field so a bare date near "position"/"job" isn't misread.
  { key: "expectedGraduation",
    re: /\b(expected|anticipated|anticipate|projected)\b.*\b(graduat|completion|complete|finish|end date)\b|\b(graduation|completion) (date|year)\b|\bwhen do you (expect to )?(graduate|finish)\b|\bend date\b|\bcompletion date\b|\bto date\b/,
    val: function (p, f) {
      if (f && /\bemploy\w*\b|\bjob\b|\bposition\b|\boccupation\b|\brole\b|\bwork experience\b/.test(f.haystack || "")) return null;
      var e = GF.primaryEducation(p); if (!e) return null;
      return GF.formatDate(e.expectedGraduation, f);
    },
    flag: "Filled with your expected date \u2014 the degree is still in progress." },
  { key: "studyStart",
    re: /\b(study|course|degree|education|enrol|commenc\w*)\b.*\bstart|\bstart date\b|\bfrom date\b/,
    val: function (p, f) {
      if (f && /\bemploy\w*\b|\bjob\b|\bposition\b|\boccupation\b|\brole\b|\bwork experience\b/.test(f.haystack || "")) return null;
      var e = GF.primaryEducation(p); if (!e) return null;
      return GF.formatDate(e.startDate, f);
    } },
  // "How many subjects have you failed?" contains "university subjects",
  // which would otherwise be caught by the "university" wording in the
  // institution rule below. Checked first, defaults to 0 (flagged, since
  // it's an assumption) — the common case for most applicants.
  { key: "subjectsFailed",
    re: /\bhow many\b.*\b(subjects?|units?|courses?)\b.*\bfail|\bfailed\b.*\b(subjects?|units?|courses?)\b/,
    val: function () { return "0"; },
    flag: "Assumed you haven't failed any subjects \u2014 confirm this is right." },

  // "Institute" and "Institution" are different words to a \b-anchored
  // regex (they only share a prefix), not synonyms it resolves for free —
  // confirmed live on CSIRO's real SuccessFactors Candidate Profile,
  // whose Education row is labelled "Educational Institute" (not
  // "Educational Institution", which is all the old regex recognised).
  // That's a different company's genuine field-naming choice, not a typo
  // to special-case; added as a real alternative below.
  { key: "institution", re: /\b(university|institution|institute|school name|college|educational institution|educational institute)\b/,
    val: function (p) { var e = GF.primaryEducation(p); return e && e.institution; } },

  // "Qualification type" wants the LEVEL (Bachelor Degree, Master's,
  // etc), not the specific degree's name — checked ahead of the generic
  // "degree" rule below, which returns the full title and would only
  // coincidentally score well against a level-type dropdown.
  { key: "qualificationType",
    re: /\bqualification type\b|\btype of (qualification|degree)\b|\b(degree|qualification|education) level\b|\blevel of (education|study)\b/,
    val: function (p) { var e = GF.primaryEducation(p); return e && e.levelLabel; } },

  { key: "degree", re: /\b(degree|qualification|course|award)\b/,
    val: function (p) { return GF.mergedDegree(p); } },

  // A double degree's second major/discipline needs its OWN field, not
  // whatever the first field also got — checked ahead of the generic
  // "major" rule, which would otherwise answer both fields identically
  // with just the primary major.
  { key: "secondMajor",
    re: /\b(second|additional|other)\b.*\b(major|discipline)\b|\bdouble degree\b.*\b(second|additional)\b/,
    val: function (p) {
      var live = GF.tertiary(p).filter(function (e) { return !e.completed; });
      return live[1] && live[1].major;
    },
    flag: "Second major from your double degree \u2014 confirm it's in the right field." },

  { key: "major", re: /\b(major|field of study|discipline|specialis\w*|specializ\w*)\b|\b(specialis|specializ)\w*/,
    val: function (p) { var e = GF.primaryEducation(p); return e && e.major; } },
  { key: "gpa", re: /\bgpa\b|\bgrade point\b/,
    val: function (p, f) {
      var e = GF.primaryEducation(p);
      if (!e) return null;
      var wamNum = e.wam && parseFloat(e.wam);
      var gpaNum = e.gpa && parseFloat(e.gpa);

      // Despite the label saying "GPA", plenty of Australian forms
      // actually want a grade band (Distinction, Credit...) or a raw
      // percentage/WAM figure — not a 1\u20137 GPA number at all. Rather than
      // assume, look at what the dropdown is actually offering and
      // answer in whatever scale it's using.
      if (f && f.el && f.tag === "select" && f.el.options && f.el.options.length > 1 && !isNaN(wamNum)) {
        var optText = Array.prototype.map.call(f.el.options, function (o) {
          return (o.textContent || "").toLowerCase();
        }).join(" | ");
        var looksLikeBands = /distinction|\bcredit\b|\bpass\b|\bfail\b|\bh1\b|\bh2\b|\bh3\b|\d{2}\s*-\s*\d{2}|below \d{2}|\d{2} or above/.test(optText);
        if (looksLikeBands) {
          if (wamNum >= 85) return "High Distinction";
          if (wamNum >= 75) return "Distinction";
          if (wamNum >= 65) return "Credit";
          if (wamNum >= 50) return "Pass";
          return "Fail";
        }
      }

      if (!isNaN(gpaNum)) return String(Math.round(gpaNum * 10) / 10);
      return e.gpa || null;
    },
    flag: "Matched to your saved WAM/GPA \u2014 double-check the band or figure is right." },
  { key: "wam", re: /\b(wam|weighted average|average mark|academic average)\b/,
    val: function (p) { var e = GF.primaryEducation(p); return e && e.wam; } },

  { key: "skills",
    re: /\bskills?\b/,
    val: function (p) {
      var s = (p.skills || []).filter(Boolean);
      return s.length ? s.join(", ") : null;
    },
    flag: "Filled from your saved skills list \u2014 trim it if this field wants only a few." },

  // --- experience ---
  { key: "employer", re: /\b(employer|current employer|current company)\b|\b(company|organisation|organization)\b.*\bname\b/,
    val: function (p) { var x = GF.latestExperience(p); return x && x.employer; },
    flag: "Most recent role used \u2014 check it's the one this section wants." },
  { key: "jobTitle", re: /\b(job|position|role)\b.*\btitle\b|\byour (current )?(position|role)\b|\bcurrent title\b|\bstart title\b/,
    val: function (p) { var x = GF.latestExperience(p); return x && x.title; },
    flag: "Most recent role used \u2014 check it's the one this section wants." },

  // --- preferences ---
  { key: "availability", re: /\bavailab\w*|\bdate of avail\w*|\bwhen can you (start|commence)\b|\bearliest start\b/,
    val: function (p) { return p.preferences.availability; } },

  { key: "salary", re: /\b(salary|remuneration|pay expectation)\b/,
    val: function () { return null; },
    flag: "Salary \u2014 left blank on purpose. Answer this one yourself." },
  { key: "noticePeriod", re: /\bnotice period\b/, val: function (p) { return p.preferences.noticePeriod; } },
  { key: "relocate", re: /\brelocat\w*|\bwilling to move\b/,
    val: function (p) { return p.preferences.relocate; },
    flag: "Set your relocation preference in Setup to auto-fill this every time." },

  { key: "howDidYouHear",
    re: /\bhow did you (hear|find out)\b.*\b(about )?(us|this role|this position|this job|the role)\b|\bwhere did you (hear|find)\b.*\b(about )?(this|us)\b|\bsource of (your )?application\b|\bhow did you find\b.*\bjob\b/,
    val: function (p, f) { return f && f.referrerSource; },
    flag: "Guessed from the page you arrived here from \u2014 confirm it's right, or pick the real source if this is off." },
];

/* Open-ended questions: never auto-answered, always turned into a prompt. */
GF.OPEN_ENDED_RE = /\b(why do you|why are you|tell us|describe a?|outline|explain|what (interests|attracts|motivat|appeals)|give an example|a time when|selection criteria|pitch|cover letter|in your own words|what makes you|how would you|what would you|your motivation|briefly (describe|outline|explain))\b/;

/* Lone checkboxes that must never be ticked for you, whatever else matches.
   Signing a declaration is yours alone. */
GF.NEVER_TICK_RE = /\b(agree|agreed|consent|declar|certify|acknowledg|terms|conditions|privacy policy|true and correct|to the best of my knowledge|authoris|authoriz|permission)\b/;

/* Fields we should never touch even if a rule matches. */
GF.NEVER_FILL_RE = /\b(password|passcode|pin|credit card|card number|cvv|tfn|tax file|bank|bsb|account number|passport number|licence number|medicare|signature)\b/;

/* ---------- supported hosted ATS platforms ----------
   These are candidate-facing SaaS application platforms, not employer-specific
   career websites. The metadata is also used by the side panel to identify
   the application system and by content.js for platform-specific hints. */

GF.ATS_PLATFORMS = [
  { key: "workday", name: "Workday", hosts: [/\.myworkdayjobs\.com$/i, /\.myworkdaysite\.com$/i, /\.workdayjobs\.com$/i] },
  { key: "pageup", name: "PageUp", hosts: [/\.pageuppeople\.com$/i] },
  { key: "successfactors", name: "SAP SuccessFactors", hosts: [/\.successfactors\.eu$/i, /\.successfactors\.com$/i, /\.sapsf\.com$/i] },
  // Raw (non-proxied) tenant hosts only, e.g. ebuu.fa.ap1.oraclecloud.com --
  // confirmed live (Westpac, South Lanarkshire Council). Most customers
  // instead reverse-proxy this behind their own domain (Oracle's own docs
  // describe this as the standard "Vanity URL" setup), which is exactly
  // why this alone isn't enough -- see resolveATS() below.
  { key: "oraclerecruiting", name: "Oracle Fusion Cloud Recruiting", hosts: [/\.oraclecloud\.com$/i] },
  // Raw avature.net tenant hosts. Every real customer confirmed this
  // session (Macquarie, Siemens) instead fronts their tenant with their
  // own domain (recruitment.macquarie.com, jobs.siemens.com) -- same
  // reason this alone isn't enough as the two platforms above.
  { key: "avature", name: "Avature", hosts: [/\.avature\.net$/i] }
];

GF.detectATS = function (hostname) {
  hostname = String(hostname || "").toLowerCase();
  for (var i = 0; i < GF.ATS_PLATFORMS.length; i++) {
    if (GF.ATS_PLATFORMS[i].hosts.some(function (re) { return re.test(hostname); })) return GF.ATS_PLATFORMS[i];
  }
  return { key: "generic", name: "Generic web form", hosts: [] };
};

/* Real customers on these platforms routinely front their actual tenant
   with their own vanity domain -- detectATS()'s host list only catches the
   minority still on a native successfactors.com/.eu, sapsf.com or
   oraclecloud.com host. There is no way to enumerate every such vanity
   domain in advance (Oracle's own docs describe this as a reverse proxy --
   the browser may never see any oraclecloud.com string at all), so this
   doesn't try to -- it fingerprints the page itself instead, and only runs
   when the fast hostname check above comes back empty. Each fingerprint
   below is a resource the platform's OWN infrastructure serves regardless
   of what domain the page itself sits on, confirmed against real, live
   career sites this session:
     - SAP SuccessFactors Career Site Builder: loads some asset
       (script/img/link) from a successfactors.com/sapsf.com host, and
       tags <body> with a "coreCSB" class. Confirmed on EY, ANZ, BHP, CSIRO.
     - Oracle Fusion Cloud Recruiting: loads its "oj-hcm-ce" bundle from
       static.oracle.com regardless of the page's own domain (a customer
       can proxy their own domain, but doesn't rehost Oracle's static JS),
       and tags <html> with "oj-"-prefixed classes. Confirmed on Westpac
       and South Lanarkshire Council (a non-vanity example, host still
       matched Oracle-owned oraclecloud.com either way).
     - Avature: loads its shared template CSS/JS bundle from
       templates-static-assets.avacdn.net regardless of the page's own
       domain. Confirmed live on both Macquarie (recruitment.macquarie.com)
       and Siemens (jobs.siemens.com) -- two unrelated customer domains
       serving the identical avacdn.net asset host, the same "shared CDN,
       different vanity front" shape as the two platforms above.
   Cached per page load: this walks the DOM, so it shouldn't run once per
   field. */
var _gfResolvedATS = null;
var GF_ATS_FINGERPRINTS = [
  {
    key: "successfactors", name: "SAP SuccessFactors",
    test: function () {
      var sfHostRe = /successfactors\.(com|eu)$|\.sapsf\.com$/i;
      var hasAsset = [].slice.call(document.querySelectorAll("script[src],img[src],link[href]")).some(function (el) {
        var url = el.src || el.href || "";
        try { return sfHostRe.test(new URL(url, location.href).hostname); } catch (e) { return false; }
      });
      var hasCSBMarker = document.body && /\bcoreCSB\b/.test(document.body.className || "");
      return hasAsset || hasCSBMarker;
    }
  },
  {
    key: "oraclerecruiting", name: "Oracle Fusion Cloud Recruiting",
    test: function () {
      var hasOJBundle = [].slice.call(document.scripts).some(function (s) {
        return /static\.oracle\.com\/.*oj-hcm-ce/i.test(s.src || "");
      });
      var hasOJClass = document.documentElement && /\boj-[a-z-]+\b/i.test(document.documentElement.className || "");
      return hasOJBundle || hasOJClass;
    }
  },
  {
    key: "avature", name: "Avature",
    test: function () {
      var avatureAssetRe = /(^|\.)avacdn\.net$/i;
      return [].slice.call(document.querySelectorAll("script[src],link[href],img[src]")).some(function (el) {
        var url = el.src || el.href || "";
        try { return avatureAssetRe.test(new URL(url, location.href).hostname); } catch (e) { return false; }
      });
    }
  }
];
GF.resolveATS = function () {
  if (_gfResolvedATS) return _gfResolvedATS;
  var byHost = GF.detectATS(typeof location !== "undefined" ? location.hostname : "");
  if (byHost.key !== "generic") return (_gfResolvedATS = byHost);

  try {
    for (var i = 0; i < GF_ATS_FINGERPRINTS.length; i++) {
      var fp = GF_ATS_FINGERPRINTS[i];
      if (fp.test()) return (_gfResolvedATS = { key: fp.key, name: fp.name, hosts: [] });
    }
  } catch (e) {}

  return (_gfResolvedATS = byHost);
};

/* ---------- repeating blocks ----------
   Forms repeat a group of fields per record: "Work Experience 1",
   "Work Experience 2", "Education 1". Every field inside one block must
   come from the SAME record, or Job Title reports one job and Company
   reports another. */

GF.BLOCK_RE = /^\s*(outside work experience|previous employment|employment details|employment record|employment history|work experience|employment|experience|position|role|job|formal education|academic qualifications?|education history|education|qualifications?|study|degree|school|language skills|language proficiency|languages?|referee|reference|certification|certificate)s?\s*(?:#|no\.?|number)?\s*(\d+)?\s*[:.]?\s*$/i;

GF.blockType = function (word) {
  var w = String(word).toLowerCase();
  if (/^(outside work experience|previous employment|employment details|employment record|work experience|employment history|employment|experience|position|role|job)/.test(w)) return "experience";
  if (/^(formal education|academic qualifications?|education history|education|qualifications?|study|degree|school)/.test(w)) return "education";
  if (/^(referee|reference)/.test(w)) return "referees";
  if (/^(language skills|language proficiency|languages?|language)/.test(w)) return "languages";
  if (/^certific/.test(w)) return "certifications";
  return null;
};

GF.BLOCK_COLLECTIONS = {
  experience: "experience",
  education: "education",
  languages: "languages"
  // referees and certifications are deliberately absent — never auto-filled.
};

/* Which records feed a block of each type. */
GF.recordsFor = function (type, p) {
  if (type === "experience") return p.experience || [];
  if (type === "education") return GF.tertiary(p);
  if (type === "languages") {
    // Candidate-facing language sections commonly mean additional language
    // skills. Put non-English languages first. On SuccessFactors, when at
    // least one non-English language is saved, use those additional languages
    // rather than creating an unnecessary English row as well.
    var langs = (p.languages || []).slice().sort(function (a, b) {
      var ae = /^english$/i.test(String(a && a.language || "").trim()) ? 1 : 0;
      var be = /^english$/i.test(String(b && b.language || "").trim()) ? 1 : 0;
      return ae - be;
    });
    try {
      var ats = GF.resolveATS();
      var nonEnglish = langs.filter(function (l) { return !/^english$/i.test(String(l && l.language || "").trim()); });
      if (ats.key === "successfactors" && nonEnglish.length) return nonEnglish;
    } catch (e) {}
    return langs;
  }
  return [];
};

/* ---------- date formatting ----------
   Read the format off the field rather than guessing. */

GF.dateFormatHint = function (f) {
  if (!f) return "";
  var el = f.el, bits = [];
  function add(v) { if (v) bits.push(String(v)); }
  if (el) {
    add(el.placeholder); add(el.getAttribute && el.getAttribute("aria-label"));
    add(el.getAttribute && el.getAttribute("title")); add(el.getAttribute && el.getAttribute("pattern"));
    add(el.getAttribute && el.getAttribute("data-date-format")); add(el.getAttribute && el.getAttribute("data-format"));
    var desc = el.getAttribute && el.getAttribute("aria-describedby");
    if (desc) desc.split(/\s+/).forEach(function (id) {
      try { var n = document.getElementById(id); if (n) add(n.textContent); } catch (e) {}
    });
    var p = el.parentElement, hops = 0;
    while (p && hops < 3) {
      var tx = String(p.innerText || p.textContent || "");
      if (/expected\s+(mm|dd|yyyy)|mm\s*[\/.-]\s*dd\s*[\/.-]\s*yyyy|dd\s*[\/.-]\s*mm\s*[\/.-]\s*yyyy/i.test(tx)) add(tx);
      p = p.parentElement; hops++;
    }
  }
  add(f.own); add(f.context);
  return bits.join(" ").toLowerCase();
};

GF.dateNeedsInferredDay = function (iso, f) {
  if (!/^\d{4}-\d{2}$/.test(String(iso || ""))) return false;
  var hint = GF.dateFormatHint(f);
  if (f && f.type === "date") return true;
  if (/dd\s*[\/.-]\s*mm\s*[\/.-]\s*yyyy|mm\s*[\/.-]\s*dd\s*[\/.-]\s*yyyy|yyyy\s*[\/.-]\s*mm\s*[\/.-]\s*dd/.test(hint)) return true;
  try {
    var sfText = f ? [f.own, f.context, f.haystack, f.label].filter(Boolean).join(" ") : "";
    if (GF.resolveATS().key === "successfactors" && f &&
        (/\b(start date|end date|date started|date ended|graduation date|completion date|from date|to date)\b/.test(sfText) || f.block)) return true;
  } catch (e) {}
  return false;
};

GF.formatDate = function (iso, f) {
  if (!iso) return "";
  var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(iso));
  if (!m) return String(iso);
  var y = m[1], mo = m[2], d = m[3] || "01";
  var hadDay = !!m[3];
  var t = f && f.type;

  if (t === "date") return y + "-" + mo + "-" + d;
  if (t === "month") return y + "-" + mo;
  if (t === "number") return y;

  var hint = GF.dateFormatHint(f);
  // Three-part formats first: "dd/mm/yyyy" contains "mm/yyyy".
  if (/dd\s*[\/.-]\s*mm\s*[\/.-]\s*yyyy/.test(hint)) return d + "/" + mo + "/" + y;
  if (/mm\s*[\/.-]\s*dd\s*[\/.-]\s*yyyy/.test(hint)) return mo + "/" + d + "/" + y;
  if (/yyyy\s*[\/.-]\s*mm\s*[\/.-]\s*dd/.test(hint)) return y + "-" + mo + "-" + d;
  if (/mm\s*[\/.-]\s*yyyy/.test(hint)) return mo + "/" + y;
  if (/yyyy\s*[\/.-]\s*mm/.test(hint)) return y + "-" + mo;
  // A field that's genuinely YEAR-ONLY (confirmed live on Workday's
  // education "To (Actual or Expected)" field -- a lone YYYY input, no
  // separate month component anywhere nearby) needs its own check against
  // just the placeholder, not the full hint blob above: that blob always
  // also carries the field's own label/context text (own/context are
  // appended unconditionally below), so an exact "^yyyy$" match against
  // the whole thing was actually unreachable in practice -- surrounding
  // label wording like "To (Actual or Expected)" already broke it.
  if (f && f.el && /^\s*yyyy\s*$/i.test(f.el.placeholder || "")) return y;

  // SAP SuccessFactors background-element date pickers commonly require a
  // complete MM/DD/YYYY value even when the user's stored record only has
  // month precision. If the page supplies no explicit hint, use that
  // platform convention and make the inferred day reviewable.
  try {
    var sfText = f ? [f.own, f.context, f.haystack, f.label].filter(Boolean).join(" ") : "";
    if (GF.resolveATS().key === "successfactors" && f &&
        (/\b(start date|end date|date started|date ended|graduation date|completion date|from date|to date)\b/.test(sfText) || f.block)) {
      return mo + "/" + d + "/" + y;
    }
  } catch (e) {}

  // No hint. Preserve month precision unless a real day was saved.
  return hadDay ? d + "/" + mo + "/" + y : mo + "/" + y;
};

// Some rules need to tell "this field's label is literally just the bare
// word X" apart from "X appears somewhere in a longer label" (e.g. a
// SuccessFactors "Degree" picker, which wants a qualification LEVEL,
// versus a "Degree Name" text field, which wants the actual award
// title). f.own is the wrong string to test that against: describe()
// always appends placeholder/title/autocomplete/id/name text after the
// label prose, and a wrapping <label> plus a duplicate aria-label (both
// contributing to prose) commonly repeats the same word twice -- an
// exact "^word$" anchor against f.own is effectively unreachable once
// any of that is present (confirmed live on EY's SuccessFactors Degree
// field: aria-label="Degree" duplicating a wrapping "* Degree" <label>,
// role="combobox", generated id "213:_input"). f.label is already the
// cleaner prose-only string describe() computes for exactly this
// purpose; this only needs to also collapse immediate word repeats and
// strip placeholder-ish filler before comparing.
GF.bareLabelIs = function (f, word) {
  var t = String((f && f.label) || "").toLowerCase()
    .replace(/no selection|select one|select|\(.*?\)/g, " ")
    .replace(/[^a-z]+/g, " ").trim();
  var w = String(word).toLowerCase();
  return t === w || t === (w + " " + w);
};

/* ---------- rules that run inside a block ----------
   `rec` is the single record this block belongs to. */

GF.BLOCK_RULES = {
  experience: [
    // SuccessFactors often exposes "Type of Business" beside Employer.
    // Keep it ahead of the employer rule so the word "business" can't
    // accidentally make the employer name land in the industry field.
    { key: "businessType",
      re: /\b(type of business|business type|industry|business sector|sector|organisation type|organization type)\b/,
      val: function (r, p) {
        var canonical = GF.canonicalBusinessType(r);
        if (canonical) return canonical;
        var inds = p && p.tags && p.tags.industries && p.tags.industries.items || [];
        return inds.length === 1 ? inds[0] : null;
      },
      alts: function (r) { return GF.businessTypeAlternates(r); },
      flag: function (r) { var c = GF.canonicalBusinessType(r); return (r.businessType && c === r.businessType) ? "" : (c ? "Mapped this technical/consulting role to the closest broad ATS industry category — confirm it is right." : "Filled from your single saved industry tag — confirm it matches this employer."); } },
    // A bare "Title" label (confirmed live on EY's SuccessFactors Work
    // experience section — no "job"/"position"/"role" qualifier at all,
    // and SF Career Site Builder's generated id/name carry no useful
    // words either: id="171:_txtFld", name="VFLD3") is unambiguous
    // inside this block specifically: there's no other kind of "title" a
    // work-experience record would ask for. A whole-string anchor
    // (`^title$`) looked right but never actually fires here — f.own
    // always has id/name/placeholder text appended after the label
    // prose (see describe()/ownLabel()), so an anchored end-of-string
    // match against that combined blob was silently dead on a field
    // with generated ids like this one. Matched as a bare word instead.
    { key: "title",
      re: /\b(job|position|role)\b.*\btitle\b|\b(job title|position title|role title|start title|title name|occupation|starttitle)\b|\btitle\b/,
      val: function (r) { return r.title; } },
    // Bare "Company" (no "name" suffix) is real too -- confirmed live on
    // Workday's own Work Experience panel (Telstra: label "Company*",
    // id="workExperience-6--companyName") and reproduced in
    // test-form.html's practice form. Not an anchor bug like the others
    // this audit found — just a missing plain word.
    { key: "employer",
      re: /\b(company name|employer|employer name|organisation|organization|organisation name|organization name|firm|employing organisation|employing organization|company)\b/,
      val: function (r) { return r.employer; } },
    { key: "location",
      re: /\b(work location|location|city|suburb|town|place of work|workplace)\b/,
      val: function (r) { return r.location || r.country; },
      alts: function (r) {
        var c = GF.inferCountryFromLocation(r.location, r.country);
        return c ? [c] : [];
      } },
    // A dedicated "Employer Country" field (confirmed live on Oracle
    // Fusion Cloud Recruiting, separate from Employer City) needs its own
    // rule — checked ahead of nothing, since "location" above has no
    // "country" wording to collide with.
    { key: "employerCountry",
      re: /\b(employer country|work country|country of employment|employing country)\b/,
      val: function (r) { return r.country || GF.inferCountryFromLocation(r.location); } },
    // "Current Job"/"Current Employer" — the actual wording used by
    // Oracle Fusion Cloud Recruiting's checkbox — wasn't covered by the
    // other current-role phrasings below.
    { key: "current", re: /\b(currently work|current(ly)? employed|still work|present|ongoing|current position|current role|current job|current employer)\b/,
      val: function (r) { return r.current ? "Yes" : null; } },
    // The trailing `^from$`/`^to$` whole-string anchors below were dead
    // code in practice: resolveInBlock always tests these against f.own,
    // which describe() always appends placeholder/title/id/name text to
    // after the label prose — so a genuinely bare "From"/"To" label (no
    // other own-text at all) could never actually match. Added as plain
    // words instead (audit prompted by the same bug confirmed live twice
    // this session, on Title/School/Degree — see GF.bareLabelIs above).
    { key: "from", re: /\b(start date|date started|employment start|from date|started|commenced|begin date|startdate|from)\b/,
      val: function (r, p, f) { return GF.formatDate(r.startDate, f); },
      flag: function (r, p, f) { return GF.dateNeedsInferredDay(r.startDate, f) ? "Only month/year was saved, so GradFill used the 1st of the month — confirm the date." : ""; } },
    { key: "to", re: /\b(end date|date ended|employment end|to date|ended|finished|until|through|enddate|to)\b/,
      val: function (r, p, f) { return r.current ? null : GF.formatDate(r.endDate, f); },
      flag: function (r, p, f) { return !r.current && GF.dateNeedsInferredDay(r.endDate, f) ? "Only month/year was saved, so GradFill used the 1st of the month — confirm the date." : ""; } },
    // "Achievements" deliberately isn't matched here. Some platforms only
    // have one free-text field for a role (this regex used to catch that
    // case too), but Oracle Fusion Cloud Recruiting has Responsibilities
    // AND Achievements as two separate fields backed by one saved
    // description — matching both would silently duplicate the same text
    // into a field asking for something different. Leaving Achievements
    // unmatched means it prompts for a real answer instead.
    { key: "description", re: /\b(descri|dut(y|ies)|responsibilit|what you did|summary|detail|task)\w*/,
      val: function (r) { return r.description; } }
  ],

  education: [
    { key: "schoolType",
      re: /\b(school type|institution type|type of education|education type|category of education|education category|study type)\b/,
      val: function (r) { return r.educationType || GF.deriveEducationCategory(r) || r.levelLabel; },
      flag: function (r) {
        return r.educationType ? "" : (GF.deriveEducationCategory(r)
          ? "Derived from your saved qualification — confirm this broad education category is right."
          : "Filled from your saved qualification level — confirm it matches this platform's category.");
      } },
    { key: "institutionCategory",
      re: /\b(type of school|school type|type of (academic )?institution|academic institution type|institution category|school \/ academic institution)\b/,
      val: function (r) { return r.institutionType || GF.deriveInstitutionCategory(r); },
      flag: "Derived from your saved institution and qualification — confirm the broad institution type is right." },
    // Bare "School" (confirmed live on EY's SuccessFactors Education
    // section — id="208:_txtFld", name="VFLD1", no semantic id fallback
    // either) and bare "Institution" both added as plain words — the
    // trailing whole-string anchor this replaced was dead against f.own
    // for the same reason "Title" was.
    // "institute" added alongside "institution" — confirmed live on CSIRO
    // (a different company from EY, whose Education row this pass was
    // re-verified against): its real field is labelled "Educational
    // Institute", which the old regex's bare "institution" never matched
    // (different words, not a typo of each other) and would have left
    // this field permanently blank on a live application.
    { key: "institution",
      re: /\b(school name|university name|institution name|institute name|college name|education provider|university|college|provider|campus name|school|institution|institute)\b/,
      val: function (r) { return r.institution; } },
    { key: "mainArea",
      re: /\b(main area of education|main area of study|area of education|education area|academic area|study area|broad field of study)\b/,
      val: function (r) { return r.major; },
      flag: "Matched your saved major to a broader study-area list — confirm the category is right." },
    // Oracle Fusion Cloud Recruiting labels this single field "University
    // GPA/WAM" — the "gpa" wording matches first, so without a fallback a
    // candidate who only saved a WAM (no separate GPA figure) would leave
    // this blank even though the field explicitly also accepts WAM.
    { key: "gpa", re: /\bgpa\b|\bgrade point\b/,
      val: function (r) { return r.gpa || r.wam; },
      flag: function (r) { return (!r.gpa && r.wam) ? "This field also accepts WAM — filled with your saved WAM since no GPA was saved." : ""; } },
    { key: "wam", re: /\b(wam|weighted average|average mark|academic average|result)\b/,
      val: function (r) { return r.wam; } },
    { key: "grade", re: /\b(grade achieved|overall grade|final grade|academic grade|overall result|final result)\b|(?:^|\b)(grade|mark|score)(?:\b|$)/,
      val: function (r) { return GF.educationGrade(r); },
      flag: function (r) {
        if (r.wam != null && String(r.wam).trim() !== "") return "Using your saved WAM for this generic grade field — confirm the form expects WAM.";
        if (r.gpa != null && String(r.gpa).trim() !== "") return "Using your saved GPA for this generic grade field — confirm the form expects GPA.";
        return "";
      } },
    { key: "major", re: /\b(major|field of study|discipline|specialis|specializ|stream|subject)\w*/,
      val: function (r) { return r.major; } },
    { key: "level",
      re: /\b(degree type|qualification type|degree measure type|level of education|level of study|education level|qualification level|degree level)\b|\b(level|type)\b.*\b(education|qualification|study|degree)\b/,
      val: function (r) { return r.levelLabel; } },
    // Confirmed live on EY's SuccessFactors Education section: a bare
    // "Degree" field, implemented as a role="combobox" custom picker
    // (id="213:_input", aria-label="Degree" duplicating a wrapping
    // "* Degree" <label>). Bare "degree"/"qualification"/etc. added as
    // plain words so the outer match actually reaches this rule at all —
    // see GF.bareLabelIs above for why the previous whole-string anchor
    // (`^degree$` against f.own) was unreachable here.
    { key: "degree", re: /\b(degree name|qualification name|award name|course name|program(me)? name)\b|\b(degree|qualification|award|course|program(me)?)\b/,
      val: function (r, p, f) {
        // A bare Degree dropdown on SuccessFactors generally asks for the
        // qualification level (Bachelor, Master, etc.), while a text field
        // labelled Degree Name wants the actual award title.
        var isPicker = f && (f.tag === "select" || (f.el && (f.el.getAttribute("role") === "combobox" || f.el.getAttribute("aria-haspopup") === "listbox")));
        if (isPicker && GF.bareLabelIs(f, "degree")) return r.levelLabel || r.degree;
        return (f && f.mergeDegrees) ? GF.mergedDegree(p) : r.degree;
      },
      flag: function (r, p, f) {
        var isPicker = f && (f.tag === "select" || (f.el && (f.el.getAttribute("role") === "combobox" || f.el.getAttribute("aria-haspopup") === "listbox")));
        return isPicker && GF.bareLabelIs(f, "degree")
          ? "Interpreted this Degree dropdown as qualification level — confirm the selected level is right." : "";
      } },
    { key: "eduLocation", re: /\b(school location|institution location|campus location|school city|institution city|city of school|location of (the )?(school|institution))\b/,
      val: function (r) { return r.location || r.country; },
      alts: function (r) { var c = GF.inferCountryFromLocation(r.location, r.country); return c ? [c] : []; } },
    { key: "eduCountry", re: /\b(school country|institution country|country of (the )?(school|institution)|country code)\b/,
      val: function (r) { return r.country || GF.inferCountryFromLocation(r.location); } },
    { key: "current", re: /\b(currently (stud|enrol)|still (stud|enrol)|in progress|ongoing)\w*/,
      val: function (r) { return r.completed ? null : "Yes"; } },
    // Bare from/to added as plain words for the same reason as the
    // experience block above — the whole-string anchors were dead code
    // against the always-polluted f.own.
    { key: "from", re: /\b(start date|education start|study start|from date|started|commenced|begin date|startdate|from)\b/,
      val: function (r, p, f) { return GF.formatDate(r.startDate, f); },
      flag: function (r, p, f) { return GF.dateNeedsInferredDay(r.startDate, f) ? "Only month/year was saved, so GradFill used the 1st of the month — confirm the date." : ""; } },
    // "last year attended" and "actual or expected" are Workday's own
    // wording (confirmed live on Telstra's real Education panel: a bare
    // YYYY field labelled "To (Actual or Expected)", backed by an input
    // id containing "lastYearAttended").
    { key: "to", re: /\b(end date|education end|graduation date|completion date|expected completion|expected graduation|finish date|enddate|last year attended|actual or expected|to)\b/,
      val: function (r, p, f) { return GF.formatDate(r.expectedGraduation, f); },
      flag: function (r, p, f) { return GF.dateNeedsInferredDay(r.expectedGraduation, f) ? "Only month/year was saved, so GradFill used the 1st of the month — confirm the date." : ""; } }
  ],

  languages: [
    // Proficiency identifiers usually contain the section prefix
    // "languageSkills", so match the specific proficiency kind before
    // the generic Language field or every dropdown would receive the
    // language name itself.
    { key: "spoken", re: /\b(speak|spoken|speaking prof|speaking proficiency|speakingprof|oral|verbal|conversation)\w*/,
      val: function (r) { return r.spoken; } },
    { key: "written", re: /\b(writ|writing prof|writing proficiency|writingprof)\w*/,
      val: function (r) { return r.written; } },
    { key: "reading", re: /\b(read|reading prof|reading proficiency|readingprof)\w*/,
      val: function (r) { return r.reading || r.written; },
      flag: function (r) { return r.reading ? "" : "Reading proficiency reused your saved Written level — confirm it is the same."; } },
    // Was a whole-string anchor against f.own — dead in practice for the
    // same reason as the other rules this audit fixed. Unanchored words
    // instead; still checked last, after the more specific spoken/
    // written/reading rules above, so it only catches a genuinely
    // unqualified proficiency field.
    { key: "proficiency", re: /\b(proficiency|level|fluency|ability)\b/,
      val: function (r) { return r.spoken; } },
    { key: "language", re: /\blanguage\b/,
      val: function (r) { return r.language; } }
  ]
};

/* ---------- add-row buttons ----------
   Strictly matched. Anything that could submit, save or delete is excluded. */

GF.ADD_BUTTON_RE = /^\s*[+＋]?\s*add(?:\s+(?:another|more|new))?(?:\s+(?:row|entry|item|record|work experience|employment|previous employment|education|formal education|qualification|language|language skills))?\s*[+＋]?\s*$/i;

GF.NEVER_CLICK_RE = /\b(submit|save|continue|next|finish|apply|send|delete|remove|clear|cancel|withdraw|sign|confirm|pay)\b/i;
