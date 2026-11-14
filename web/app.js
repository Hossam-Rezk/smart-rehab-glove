// Smart Rehab Glove - website logic.
// Live data comes from the local Python server (WebSocket /ws).
// Patients, sessions and tutorials are stored in Supabase.

const $ = (id) => document.getElementById(id);
const db = window.supabase
  ? window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY)
  : null;

const QUALITY_NAMES = { good: "Good", partial: "Bend further", too_fast: "Too fast", shaky: "Shaky" };

const app = {
  connected: false,
  patients: [],
  patient: null,
  exercise: null,
  flex: { reps: [], startedAt: null, target: 60 },
  thumb: { trials: [], startedAt: null, total: 10 },
  charts: {},
};

// ---------------------------------------------------------------- helpers
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 6000 : 3000);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "Request failed (" + response.status + ")");
  return data;
}

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

function avg(values) {
  const list = values.filter((v) => v !== null && v !== undefined);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

// ---------------------------------------------------------------- navigation
function showPage(name) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll("section.page").forEach((s) => s.classList.toggle("active", s.id === "page-" + name));
  if (name === "progress") loadProgress();
  if (name === "flex") suggestTarget();
}
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));

// ---------------------------------------------------------------- connection
async function loadPorts() {
  try {
    const data = await api("/api/ports");
    const select = $("port-select");
    select.innerHTML = '<option value="">Auto-detect Pico</option>' +
      data.ports.map((p) => `<option value="${escapeHtml(p.port)}">${escapeHtml(p.label)}</option>`).join("");
  } catch {
    toast("Cannot reach the local server. Is start.bat running?", true);
  }
}
$("port-select").addEventListener("focus", loadPorts);

$("connect-btn").addEventListener("click", async () => {
  const btn = $("connect-btn");
  btn.disabled = true;
  try {
    if (app.connected) {
      await api("/api/disconnect", {});
      toast("Glove disconnected.");
    } else {
      btn.textContent = "Connecting...";
      const data = await api("/api/connect", { port: $("port-select").value || null });
      toast("Connected: " + (data.description || "glove"));
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    btn.disabled = false;
    updateConnection();
  }
});

function updateConnection(status) {
  if (status) {
    app.connected = status.connected;
    app.exercise = status.exercise;
  }
  const pill = $("conn-pill");
  pill.className = "pill" + (app.connected ? " on" : "");
  pill.textContent = app.connected ? "Glove connected" : "Glove not connected";
  $("connect-btn").textContent = app.connected ? "Disconnect" : "Connect glove";
  $("connect-btn").className = app.connected ? "btn secondary" : "btn";
  $("port-select").style.display = app.connected ? "none" : "";
}

// ---------------------------------------------------------------- live data
function connectSocket() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
  ws.onclose = () => {
    app.connected = false;
    updateConnection();
    setTimeout(connectSocket, 1500);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case "status": updateConnection(msg); break;
    case "sample": showSample(msg); break;
    case "rep": onRep(msg); break;
    case "thumb": onThumb(msg); break;
    case "calib": onCalibration(msg); break;
    case "error": toast(msg.message, true); break;
  }
}

function setGauge(fillId, textId, bend, target) {
  const fill = $(fillId);
  fill.style.width = bend + "%";
  fill.className = "fill" + (bend >= target ? " ok" : bend > 30 ? " mid" : "");
  $(textId).textContent = bend + " %";
}

function showSample(msg) {
  setGauge("cal-fill", "cal-text", msg.bend, 101);
  setGauge("flex-fill", "flex-text", msg.bend, app.flex.target);
  $("cal-touch").textContent = msg.touch ? "TOUCHED" : "not touched";
  $("thumb-prompt").classList.toggle("touching", !!msg.touch);
}

// ---------------------------------------------------------------- patients
async function loadPatients() {
  if (!db) return toast("Database library failed to load. Check the internet connection.", true);
  const { data, error } = await db.from("patients").select("*").order("created_at", { ascending: false });
  if (error) return toast("Database error: " + error.message, true);
  app.patients = data;
  const saved = storageGet("patientId");
  const select = $("patient-select");
  select.innerHTML = '<option value="">- choose -</option>' +
    data.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  if (saved && data.some((p) => p.id === saved)) select.value = saved;
  selectPatient(select.value);
}

function selectPatient(id) {
  app.patient = app.patients.find((p) => p.id === id) || null;
  $("patient-name").textContent = app.patient ? app.patient.name : "none selected";
  $("patient-info").textContent = app.patient
    ? `Injured hand: ${app.patient.injured_hand}. ${app.patient.notes || ""}`
    : "Select a patient so sessions are saved to their history.";
  if (app.patient) storageSet("patientId", app.patient.id);
}
$("patient-select").addEventListener("change", (e) => selectPatient(e.target.value));

$("patient-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!db) return;
  const row = { name: $("new-name").value.trim(), injured_hand: $("new-hand").value, notes: $("new-notes").value.trim() || null };
  if (!row.name) return;
  const { data, error } = await db.from("patients").insert(row).select().single();
  if (error) return toast("Could not add patient: " + error.message, true);
  storageSet("patientId", data.id);
  $("patient-form").reset();
  toast("Patient added.");
  await loadPatients();
});

// ---------------------------------------------------------------- calibration
const calSteps = ["flat", "bent", "done"];
function markCalibration(stage) {
  const index = calSteps.indexOf(stage);
  calSteps.forEach((s, i) => {
    $("cal-step-" + s).className = "step" + (i < index ? " done" : i === index ? (stage === "done" ? " done" : " active") : "");
  });
}

$("cal-btn").addEventListener("click", async () => {
  try {
    await api("/api/calibrate", {});
    $("cal-btn").disabled = true;
    $("cal-msg").textContent = "Calibrating... follow the beeps.";
  } catch (error) {
    toast(error.message, true);
  }
});

function onCalibration(msg) {
  if (msg.stage === "failed") {
    calSteps.forEach((s) => ($("cal-step-" + s).className = "step"));
    $("cal-msg").textContent = "Calibration failed: " + (msg.reason || "") + " Try again.";
    $("cal-btn").disabled = false;
    return;
  }
  markCalibration(msg.stage);
  if (msg.stage === "done") {
    $("cal-msg").textContent = "Calibration done! Go to Finger Bend to start exercising.";
    $("cal-btn").disabled = false;
    $("cal-btn").textContent = "Calibrate again";
  }
}

// ---------------------------------------------------------------- finger bend exercise
$("flex-target").addEventListener("input", (e) => setTarget(+e.target.value));
function setTarget(value) {
  app.flex.target = value;
  $("flex-target").value = value;
  $("flex-target-value").textContent = value;
  $("flex-target-line").style.left = value + "%";
}

// Adaptive difficulty: raise or lower the target from the last session.
async function suggestTarget() {
  const box = $("flex-suggest");
  box.style.display = "none";
  if (!db || !app.patient || app.exercise === "flex") return;
  const { data } = await db.from("sessions").select("target_percent, good_rep_ratio, reps_count")
    .eq("patient_id", app.patient.id).eq("exercise_type", "flex").gt("reps_count", 0)
    .order("started_at", { ascending: false }).limit(1);
  if (!data || !data.length) return;
  const last = data[0];
  let target = last.target_percent || 60;
  let reason = "Same target as last time.";
  if (last.good_rep_ratio >= 0.8) { target = Math.min(95, target + 5); reason = "Great last session - target raised."; }
  else if (last.good_rep_ratio < 0.4) { target = Math.max(20, target - 5); reason = "Target lowered a little to build up."; }
  setTarget(target);
  box.textContent = `AI suggestion: ${target} %. ${reason}`;
  box.style.display = "";
}

$("flex-start").addEventListener("click", async () => {
  if (!app.patient) toast("No patient selected: this session will not be saved.", true);
  try {
    await api("/api/flex/start", { target: app.flex.target });
  } catch (error) {
    return toast(error.message, true);
  }
  app.flex.reps = [];
  app.flex.startedAt = new Date().toISOString();
  $("flex-table").innerHTML = "";
  updateFlexStats();
  $("flex-feedback").className = "feedback";
  $("flex-feedback").textContent = "Go! Bend the finger to the target line.";
  $("flex-start").disabled = true;
  $("flex-stop").disabled = false;
  $("flex-target").disabled = true;
});

$("flex-stop").addEventListener("click", async () => {
  await api("/api/stop", {}).catch(() => {});
  $("flex-start").disabled = false;
  $("flex-stop").disabled = true;
  $("flex-target").disabled = false;
  await saveFlexSession();
});

function onRep(rep) {
  if (!app.flex.startedAt) return;
  app.flex.reps.push(rep);
  const fb = $("flex-feedback");
  fb.className = "feedback " + rep.quality;
  fb.textContent = `Rep ${rep.rep_index}: ${rep.message} (${rep.peak_percent} %)`;
  const row = document.createElement("tr");
  row.innerHTML = `<td>${rep.rep_index}</td><td>${rep.peak_percent} %</td><td>${(rep.duration_ms / 1000).toFixed(1)} s</td>` +
    `<td>${Math.round(rep.smoothness * 100)} %</td><td><span class="tag ${rep.quality}">${QUALITY_NAMES[rep.quality]}</span></td>`;
  $("flex-table").prepend(row);
  updateFlexStats();
}

function updateFlexStats() {
  const reps = app.flex.reps;
  $("flex-reps").textContent = reps.length;
  $("flex-good").textContent = reps.filter((r) => r.quality === "good").length;
  $("flex-best").textContent = (reps.length ? Math.max(...reps.map((r) => r.peak_percent)) : 0) + " %";
}

async function saveFlexSession() {
  const reps = app.flex.reps;
  const startedAt = app.flex.startedAt;
  app.flex.startedAt = null;
  if (!reps.length) return toast("No repetitions recorded.");
  if (!db || !app.patient) return toast("Not saved: choose a patient on the Home page first.", true);
  const session = {
    patient_id: app.patient.id,
    exercise_type: "flex",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    target_percent: app.flex.target,
    reps_count: reps.length,
    avg_peak_percent: +avg(reps.map((r) => r.peak_percent)).toFixed(1),
    best_peak_percent: Math.max(...reps.map((r) => r.peak_percent)),
    avg_smoothness: +avg(reps.map((r) => r.smoothness)).toFixed(3),
    good_rep_ratio: +(reps.filter((r) => r.quality === "good").length / reps.length).toFixed(3),
  };
  const { data, error } = await db.from("sessions").insert(session).select("id").single();
  if (error) return toast("Could not save the session: " + error.message, true);
  const rows = reps.map((r) => ({
    session_id: data.id, rep_index: r.rep_index, peak_percent: r.peak_percent, duration_ms: r.duration_ms,
    time_to_peak_ms: r.time_to_peak_ms, hold_ms: r.hold_ms, smoothness: r.smoothness, tremor: r.tremor,
    quality: r.quality, confidence: r.confidence,
  }));
  const result = await db.from("repetitions").insert(rows);
  if (result.error) return toast("Session saved, but repetitions failed: " + result.error.message, true);
  toast(`Session saved: ${reps.length} repetitions.`);
}

// ---------------------------------------------------------------- thumb touch exercise
$("thumb-start").addEventListener("click", async () => {
  if (!app.patient) toast("No patient selected: this session will not be saved.", true);
  app.thumb.total = +$("thumb-trials").value;
  try {
    await api("/api/thumb/start", { trials: app.thumb.total });
  } catch (error) {
    return toast(error.message, true);
  }
  app.thumb.trials = [];
  app.thumb.startedAt = new Date().toISOString();
  $("thumb-table").innerHTML = "";
  updateThumbStats();
  $("thumb-start").disabled = true;
  $("thumb-stop").disabled = false;
});

$("thumb-stop").addEventListener("click", async () => {
  await api("/api/stop", {}).catch(() => {});
  await finishThumb();
});

function setPrompt(text, cls = "") {
  const el = $("thumb-prompt");
  el.textContent = text;
  el.className = "prompt " + cls;
}

async function onThumb(msg) {
  if (!app.thumb.startedAt) return;
  if (msg.stage === "wait") {
    setPrompt("Wait...");
    $("thumb-trial").textContent = `Trial ${msg.trial} of ${msg.trials}`;
  } else if (msg.stage === "open_hand") {
    setPrompt("Open your hand", "early");
  } else if (msg.stage === "early") {
    setPrompt("Too early! Wait for green", "early");
  } else if (msg.stage === "cue") {
    setPrompt("Touch now!", "cue");
  } else if (msg.stage === "result") {
    app.thumb.trials.push(msg);
    setPrompt(msg.success ? `${msg.reaction_ms} ms` : "Missed", msg.success ? "" : "early");
    const row = document.createElement("tr");
    row.innerHTML = `<td>${msg.trial}</td><td><span class="tag ${msg.success ? "good" : "fail"}">${msg.success ? "Touched" : "Missed"}</span></td>` +
      `<td>${msg.success ? msg.reaction_ms + " ms" : "-"}</td><td>${msg.success ? (msg.hold_ms / 1000).toFixed(1) + " s" : "-"}</td>`;
    $("thumb-table").prepend(row);
    updateThumbStats();
  } else if (msg.stage === "done") {
    setPrompt("Well done!");
    await finishThumb();
  }
}

function updateThumbStats() {
  const trials = app.thumb.trials;
  const ok = trials.filter((t) => t.success);
  const reaction = avg(ok.map((t) => t.reaction_ms));
  $("thumb-avg").textContent = reaction === null ? "-" : Math.round(reaction) + " ms";
  $("thumb-rate").textContent = trials.length ? Math.round((ok.length / trials.length) * 100) + " %" : "-";
}

async function finishThumb() {
  $("thumb-start").disabled = false;
  $("thumb-stop").disabled = true;
  const startedAt = app.thumb.startedAt;
  app.thumb.startedAt = null;
  const trials = app.thumb.trials;
  if (!startedAt || !trials.length) return;
  if (!db || !app.patient) return toast("Not saved: choose a patient on the Home page first.", true);
  const ok = trials.filter((t) => t.success);
  const reaction = avg(ok.map((t) => t.reaction_ms));
  const session = {
    patient_id: app.patient.id,
    exercise_type: "thumb",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    trials_count: trials.length,
    success_rate: +(ok.length / trials.length).toFixed(3),
    avg_reaction_ms: reaction === null ? null : Math.round(reaction),
  };
  const { data, error } = await db.from("sessions").insert(session).select("id").single();
  if (error) return toast("Could not save the session: " + error.message, true);
  const rows = trials.map((t) => ({ session_id: data.id, trial_index: t.trial, success: t.success, reaction_ms: t.reaction_ms, hold_ms: t.hold_ms }));
  const result = await db.from("touch_trials").insert(rows);
  if (result.error) return toast("Session saved, but trials failed: " + result.error.message, true);
  toast(`Session saved: ${trials.length} trials.`);
}

// ---------------------------------------------------------------- tutorials
let tutorials = [];
async function loadTutorials() {
  if (!db) return;
  const { data, error } = await db.from("tutorials").select("*").order("sort_order");
  if (error) return ($("tutorial-list").innerHTML = `<p class="lead">Could not load tutorials: ${escapeHtml(error.message)}</p>`);
  tutorials = data;
  renderTutorials();
}

function renderTutorials() {
  const filter = $("tutorial-filter").value;
  const list = tutorials.filter((t) => filter === "all" || t.exercise_type === filter);
  $("tutorial-list").innerHTML = list.map((t) => `
    <div class="card tutorial">
      <div class="level">${escapeHtml(t.level)} &middot; ${t.duration_min} min</div>
      <h3>${escapeHtml(t.title)}</h3>
      <p>${escapeHtml(t.description)}</p>
      <ol>${t.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
      ${t.tips ? `<p class="tips">Tip: ${escapeHtml(t.tips)}</p>` : ""}
      ${t.video_url && /^https:\/\//.test(t.video_url) ? `<a class="btn secondary" target="_blank" rel="noopener" href="${escapeHtml(t.video_url)}">Watch videos</a>` : ""}
    </div>`).join("") || '<p class="lead">No tutorials.</p>';
}
$("tutorial-filter").addEventListener("change", renderTutorials);

// ---------------------------------------------------------------- progress
async function loadProgress() {
  if (!db || !app.patient) return;
  $("progress-lead").textContent = `Progress for ${app.patient.name}.`;
  const { data, error } = await db.from("sessions").select("*").eq("patient_id", app.patient.id).order("started_at");
  if (error) return toast("Database error: " + error.message, true);

  const flex = data.filter((s) => s.exercise_type === "flex" && s.reps_count > 0);
  const thumb = data.filter((s) => s.exercise_type === "thumb" && s.trials_count > 0);
  const day = (s) => new Date(s.started_at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  drawChart("chart-flex", flex.map(day), [
    { label: "Average bend %", data: flex.map((s) => +s.avg_peak_percent), borderColor: "#2563eb" },
    { label: "Good reps %", data: flex.map((s) => Math.round(s.good_rep_ratio * 100)), borderColor: "#16a34a" },
  ], "%");
  drawChart("chart-thumb", thumb.map(day), [
    { label: "Reaction (ms)", data: thumb.map((s) => s.avg_reaction_ms), borderColor: "#d97706" },
  ], "ms");

  // Trend summary: compare the first and last 3 sessions.
  const parts = [];
  if (flex.length >= 2) {
    const first = avg(flex.slice(0, 3).map((s) => +s.avg_peak_percent));
    const last = avg(flex.slice(-3).map((s) => +s.avg_peak_percent));
    const change = last - first;
    parts.push(`Finger bend: ${change >= 0 ? "+" : ""}${change.toFixed(0)} % compared with the first sessions (now ${last.toFixed(0)} % on average).`);
  }
  if (thumb.length >= 2) {
    const first = avg(thumb.slice(0, 3).map((s) => s.avg_reaction_ms));
    const last = avg(thumb.slice(-3).map((s) => s.avg_reaction_ms));
    if (first && last) parts.push(`Thumb reaction: ${Math.round(last)} ms now, ${last <= first ? "faster" : "slower"} than at the start (${Math.round(first)} ms).`);
  }
  $("progress-summary").textContent = parts.length ? parts.join(" ") : `${data.length} session(s) so far. Do at least two of each exercise to see a trend.`;

  $("session-table").innerHTML = data.slice().reverse().map((s) => {
    const result = s.exercise_type === "flex"
      ? `${s.reps_count} reps, avg ${s.avg_peak_percent ?? "-"} %, ${Math.round((s.good_rep_ratio || 0) * 100)} % good`
      : `${s.trials_count ?? 0} trials, ${Math.round((s.success_rate || 0) * 100)} % success, ${s.avg_reaction_ms ?? "-"} ms`;
    return `<tr><td>${new Date(s.started_at).toLocaleString()}</td><td>${s.exercise_type === "flex" ? "Finger bend" : "Thumb touch"}</td><td>${result}</td></tr>`;
  }).join("");
}

function drawChart(canvasId, labels, datasets, unit) {
  if (!window.Chart) return;
  if (app.charts[canvasId]) app.charts[canvasId].destroy();
  app.charts[canvasId] = new Chart($(canvasId), {
    type: "line",
    data: { labels, datasets: datasets.map((d) => ({ ...d, backgroundColor: d.borderColor, tension: 0.3, pointRadius: 4 })) },
    options: {
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: unit } } },
      plugins: { legend: { position: "bottom" } },
    },
  });
}

// ---------------------------------------------------------------- start
setTarget(60);
updateConnection();
loadPorts();
connectSocket();
loadPatients();
loadTutorials();
