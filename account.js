/* GradFill AI — account / plan controls on Setup. */
(function () {
  "use strict";
  function $(id) { return document.getElementById(id); }
  function msg(t, bad) { var e=$("gfAccountMsg"); if(!e)return; e.textContent=t||""; e.style.color=bad?"#9b2c2c":""; }

  async function render() {
    var s = await GFCloud.getSettings();
    $("gfMode").value = s.mode;
    $("gfDemoPlan").value = s.demoPlan || "free";
    $("gfCloudSync").checked = !!s.cloudSync;
    $("demoPlanWrap").hidden = s.mode !== "demo";

    var a = await GFCloud.getAccount();
    if (s.mode !== "demo" && a && a.token) {
      try { a = await GFCloud.refreshAccount(); } catch (e) {}
    }
    var p = await GFCloud.plan();
    $("gfPlanName").textContent = p.name || p.id || "Free";
    $("gfPlanPrice").textContent = p.price || (p.id === "pro" ? "A$20/month" : p.id === "season" ? "A$45 / 90 days" : "A$0");
    var u = await GFCloud.usage();
    if (u && p.aiEnabled) {
      function fmt(x) { return x ? x.used + " / " + (x.limit >= 9999 ? "∞" : x.limit) : "—"; }
      $("gfUsage").textContent = "AI drafts this month: " + fmt(u.aiDrafts) + " · Resume tailors: " + fmt(u.resumeTailors) + " · Cover letters: " + fmt(u.coverLetters);
    } else {
      $("gfUsage").textContent = "Autofill and the tracker are always free and unlimited. AI drafting, resume tailoring and cover letters need Pro or a Season Pass.";
    }

    var signed = s.mode !== "demo" && a && a.token;
    $("gfAuthSignedOut").hidden = !!signed || s.mode === "demo";
    $("gfAuthSignedIn").hidden = !signed;
    if (signed) $("gfAccountEmail").textContent = a.email || "Signed in";
    $("gfUpgrade").hidden = !!p.aiEnabled;
    $("gfBilling").hidden = !signed;
  }

  $("gfMode").addEventListener("change", async function () {
    await GFCloud.setSettings({ mode:this.value }); msg(""); await render();
  });
  $("gfDemoPlan").addEventListener("change", async function () {
    await GFCloud.setSettings({ demoPlan:this.value }); await render();
  });
  $("gfCloudSync").addEventListener("change", async function () {
    var s=await GFCloud.getSettings();
    if (this.checked && s.mode === "demo") { this.checked=false; msg("Cloud sync needs Local backend or Production mode.", true); return; }
    await GFCloud.setSettings({ cloudSync:this.checked });
    msg(this.checked ? "Cloud sync enabled. Profile changes will sync after you sign in." : "Cloud sync disabled.");
    await render();
  });

  async function auth(which) {
    var email=$("gfEmail").value.trim(), password=$("gfPassword").value;
    if (!email || password.length < 8) { msg("Enter an email and a password of at least 8 characters.", true); return; }
    msg(which === "login" ? "Signing in…" : "Creating account…");
    try {
      if (which === "login") await GFCloud.login(email,password); else await GFCloud.register(email,password);
      msg("Signed in."); await render();
    } catch(e) { msg(e.message || "Could not sign in.", true); }
  }
  $("gfLogin").addEventListener("click", function(){auth("login");});
  $("gfRegister").addEventListener("click", function(){auth("register");});
  $("gfLogout").addEventListener("click", async function(){ await GFCloud.logout(); msg("Signed out."); await render(); });
  $("gfUpgrade").addEventListener("click", async function(){ try { msg("Opening secure checkout…"); var r = await GFCloud.checkout("pro"); if (r && r.demo) msg(r.message || "Stripe is not configured on this server yet."); } catch(e){ msg(e.message,true); } });
  $("gfUpgradeSeason").addEventListener("click", async function(){ try { msg("Opening secure checkout…"); var r = await GFCloud.checkout("season"); if (r && r.demo) msg(r.message || "Stripe is not configured on this server yet."); } catch(e){ msg(e.message,true); } });
  $("gfUpgradeSeasonCrypto").addEventListener("click", async function(){ try { msg("Opening crypto checkout…"); var r = await GFCloud.cryptoCheckout("season"); if (r && r.demo) msg(r.message || "Crypto checkout is not configured on this server yet."); } catch(e){ msg(e.message,true); } });
  $("gfBilling").addEventListener("click", async function(){ try { var r = await GFCloud.billingPortal(); if (r && r.demo) msg(r.message || "Stripe is not configured on this server yet."); } catch(e){ msg(e.message,true); } });

  // Debounced opt-in cloud profile sync. The existing setup controller saves
  // locally as the user types; this watches those saves rather than changing
  // the proven setup code path.
  var syncTimer=null;
  chrome.storage.onChanged.addListener(function(changes, area){
    if(area!=="local" || !changes.profile) return;
    clearTimeout(syncTimer);
    syncTimer=setTimeout(async function(){
      var s=await GFCloud.getSettings(); if(!s.cloudSync || s.mode==="demo") return;
      var a=await GFCloud.getAccount(); if(!a || !a.token) return;
      try { await GFCloud.syncProfile(changes.profile.newValue || {}); } catch(e) {}
    },1200);
  });

  render();
})();
