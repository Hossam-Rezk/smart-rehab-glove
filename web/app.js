// Smart Rehab Glove - website logic.
// Live data comes from the local Python server (WebSocket /ws).
// Patients, sessions and tutorials are stored in Supabase.

const $ = (id) => document.getElementById(id);
const db = window.supabase
  ? window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY)
  : null;

const STEPS = ["calibrate", "flex", "thumb", "summary"];

const app = {
  connected: false,
  patients: [],
  patient: null,
  step: "calibrate",
  done: new Set(),
  flex: { reps: [], startedAt: null, target: 60, saved: [] },
  thumb: { trials: [], startedAt: null, total: 10, saved: [] },
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

// ---------------------------------------------------------------- pages and steps
function showPage(name) {
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll("section.page").forEach((s) => s.classList.toggle("active", s.id === "page-" + name));
  if (name === "history") loadHistory();
}
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));
$("see-history").addEventListener("click", () => showPage("history"));

async function goToStep(step) {
  if (exerciseRunning()) await stopRunning();
  if (step === "calibrate" && app.step === "summary") {
    app.done.clear();
    app.flex.saved = [];
    app.thumb.saved = [];
  }
  app.step = step;
  STEPS.forEach((s) => {
    $("step-" + s).classList.toggle("active", s === step);
    const li = document.querySelector(`#stepper li[data-step="${s}"]`);
    li.classList.toggle("active", s === step);
    li.classList.toggle("done", s !== step && app.done.has(s));
  });
  if (step === "flex") suggestTarget();
  if (step === "summary") renderSummary();
}
document.querySelectorAll("#stepper li").forEach((li) => li.addEventListener("click", () => goToStep(li.dataset.step)));
document.querySelectorAll(".next-btn").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.next !== "calibrate") app.done.add(app.step);
  goToStep(b.dataset.next);
}));

function exerciseRunning() {
  return !!(app.flex.startedAt || app.thumb.startedAt);
}

async function stopRunning() {
  await api("/api/stop", {}).catch(() => {});
  if (app.flex.startedAt) await finishFlex();
  if (app.thumb.startedAt) await finishThumb();
}

// ---------------------------------------------------------------- connection
async function loadPorts() {
  try {
    const data = await api("/api/ports");
    const select = $("port-select");
    const current = select.value;
    select.innerHTML = '<option value="">Auto-detect Pico</option>' +
      data.ports.map((p) => `<option value="${escapeHtml(p.port)}">${escapeHtml(p.label)}</option>`).join("");
    if ([...select.options].some((o) => o.value === current)) select.value = current;
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
  if (status) app.connected = status.connected;
  const pill = $("conn-pill");
  pill.className = "pill" + (app.connected ? " on" : "");
  pill.textContent = app.connected ? "Glove connected" : "Not connected";
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
async function loadPatients(selectId) {
  if (!db) return toast("Database library failed to load. Check the internet connection.", true);
  const { data, error } = await db.from("patients").select("*").order("name");
  if (error) return toast("Database error: " + error.message, true);
  app.patients = data;
  const select = $("patient-select");
  select.innerHTML = '<option value="">Choose patient...</option>' +
    data.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  const wanted = selectId || storageGet("patientId");
  if (wanted && data.some((p) => p.id === wanted)) select.value = wanted;
  selectPatient(select.value);
}

function selectPatient(id) {
  app.patient = app.patients.find((p) => p.id === id) || null;
  if (app.patient) storageSet("patientId", app.patient.id);
  if ($("page-history").classList.contains("active")) loadHistory();
  if (app.step === "flex") suggestTarget();
}
$("patient-select").addEventListener("change", (e) => selectPatient(e.target.value));

$("new-patient-btn").addEventListener("click", () => $("patient-dialog").showModal());
$("patient-cancel").addEventListener("click", () => $("patient-dialog").close());
$("patient-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!db) return;
  const row = { name: $("new-name").value.trim(), injured_hand: $("new-hand").value, notes: $("new-notes").value.trim() || null };
  if (!row.name) return;
  const { data, error } = await db.from("patients").insert(row).select().single();
  if (error) return toast("Could not add patient: " + error.message, true);
  $("patient-form").reset();
  $("patient-dialog").close();
  toast("Patient added.");
  await loadPatients(data.id);
});

function needPatient() {
  if (app.patient) return true;
  toast("Choose or add a patient at the top first.", true);
  $("patient-select").focus();
  return false;
}

// ---------------------------------------------------------------- step 1: calibration
$("cal-btn").addEventListener("click", async () => {
  try {
    await api("/api/calibrate", {});
    $("cal-btn").disabled = true;
    $("cal-msg").innerHTML = "<b>1 beep:</b> keep the finger <b>flat</b>...";
  } catch (error) {
    toast(error.message, true);
  }
});

function onCalibration(msg) {
  const text = {
    flat: "<b>1 beep:</b> keep the finger <b>flat</b>...",
    bent: "<b>2 beeps:</b> now <b>bend it fully</b> and hold...",
    done: "<b>Done!</b> The glove is calibrated. Press <b>Next</b>.",
  };
  if (msg.stage === "failed") {
    $("cal-msg").textContent = "Calibration failed: " + (msg.reason || "") + " Try again.";
    $("cal-btn").disabled = false;
    return;
  }
  $("cal-msg").innerHTML = text[msg.stage] || "";
  if (msg.stage === "done") {
    $("cal-btn").disabled = false;
    $("cal-btn").textContent = "Calibrate again";
    app.done.add("calibrate");
  }
}

// ---------------------------------------------------------------- step 2: finger bend
$("flex-target").addEventListener("input", (e) => setTarget(+e.target.value));
function setTarget(value) {
  app.flex.target = value;
  $("flex-target").value = value;
  $("flex-target-value").textContent = value;
  $("flex-target-line").style.left = value + "%";
}

// Adaptive difficulty: raise or lower the target from the last session.
async function suggestTarget() {
  $("flex-suggest").textContent = "";
  if (!db || !app.patient || app.flex.startedAt) return;
  const { data } = await db.from("sessions").select("target_percent, good_rep_ratio")
    .eq("patient_id", app.patient.id).eq("exercise_type", "flex").gt("reps_count", 0)
    .order("started_at", { ascending: false }).limit(1);
  if (!data || !data.length) return;
  const last = data[0];
  let target = last.target_percent || 60;
  if (last.good_rep_ratio >= 0.8) target = Math.min(95, target + 5);
  else if (last.good_rep_ratio < 0.4) target = Math.max(20, target - 5);
  setTarget(target);
  $("flex-suggest").textContent = "Set by AI from the last session";
}

$("flex-start").addEventListener("click", async () => {
  if (!needPatient()) return;
  try {
    await api("/api/flex/start", { target: app.flex.target });
  } catch (error) {
    return toast(error.message, true);
  }
  app.flex.reps = [];
  app.flex.startedAt = new Date().toISOString();
  updateFlexStats();
  $("flex-feedback").className = "feedback";
  $("flex-feedback").textContent = "Go! Bend the finger to the black line.";
  $("flex-start").disabled = true;
  $("flex-stop").disabled = false;
  $("flex-target").disabled = true;
});

$("flex-stop").addEventListener("click", async () => {
  await api("/api/stop", {}).catch(() => {});
  await finishFlex();
});

function onRep(rep) {
  if (!app.flex.startedAt) return;
  app.flex.reps.push(rep);
  const fb = $("flex-feedback");
  fb.className = "feedback " + rep.quality;
  fb.textContent = `Rep ${rep.rep_index}: ${rep.message} (${rep.peak_percent} %)`;
  updateFlexStats();
}

function updateFlexStats() {
  const reps = app.flex.reps;
  $("flex-reps").textContent = reps.length;
  $("flex-good").textContent = reps.filter((r) => r.quality === "good").length;
  $("flex-best").textContent = (reps.length ? Math.max(...reps.map((r) => r.peak_percent)) : 0) + " %";
}

async function finishFlex() {
  $("flex-start").disabled = false;
  $("flex-stop").disabled = true;
  $("flex-target").disabled = false;
  const reps = app.flex.reps;
  const startedAt = app.flex.startedAt;
  app.flex.startedAt = null;
  if (!startedAt || !reps.length) return;
  app.done.add("flex");
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
  app.flex.saved.push(session);
  const { data, error } = await db.from("sessions").insert(session).select("id").single();
  if (error) return toast("Could not save the session: " + error.message, true);
  const rows = reps.map((r) => ({
    session_id: data.id, rep_index: r.rep_index, peak_percent: r.peak_percent, duration_ms: r.duration_ms,
    time_to_peak_ms: r.time_to_peak_ms, hold_ms: r.hold_ms, smoothness: r.smoothness, tremor: r.tremor,
    quality: r.quality, confidence: r.confidence,
  }));
  const result = await db.from("repetitions").insert(rows);
  if (result.error) return toast("Session saved, but repetitions failed: " + result.error.message, true);
  toast(`Saved: ${reps.length} repetitions.`);
}

// ---------------------------------------------------------------- step 3: thumb touch
$("thumb-start").addEventListener("click", async () => {
  if (!needPatient()) return;
  try {
    await api("/api/thumb/start", { trials: app.thumb.total });
  } catch (error) {
    return toast(error.message, true);
  }
  app.thumb.trials = [];
  app.thumb.startedAt = new Date().toISOString();
  $("thumb-trial").textContent = 0;
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
    $("thumb-trial").textContent = msg.trial;
  } else if (msg.stage === "open_hand") {
    setPrompt("Open your hand", "early");
  } else if (msg.stage === "early") {
    setPrompt("Too early! Wait for green", "early");
  } else if (msg.stage === "cue") {
    setPrompt("Touch now!", "cue");
  } else if (msg.stage === "result") {
    app.thumb.trials.push(msg);
    setPrompt(msg.success ? `${msg.reaction_ms} ms` : "Missed", msg.success ? "" : "early");
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
  app.done.add("thumb");
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
  app.thumb.saved.push(session);
  const { data, error } = await db.from("sessions").insert(session).select("id").single();
  if (error) return toast("Could not save the session: " + error.message, true);
  const rows = trials.map((t) => ({ session_id: data.id, trial_index: t.trial, success: t.success, reaction_ms: t.reaction_ms, hold_ms: t.hold_ms }));
  const result = await db.from("touch_trials").insert(rows);
  if (result.error) return toast("Session saved, but trials failed: " + result.error.message, true);
  toast(`Saved: ${trials.length} trials.`);
}

// ---------------------------------------------------------------- summary
function renderSummary() {
  const flex = app.flex.saved;
  const thumb = app.thumb.saved;
  const items = [];
  if (flex.length) {
    const reps = flex.reduce((n, s) => n + s.reps_count, 0);
    const good = Math.round(avg(flex.map((s) => s.good_rep_ratio)) * 100);
    const best = Math.max(...flex.map((s) => s.best_peak_percent));
    items.push([reps, "finger bends"], [good + " %", "good repetitions"], [best + " %", "best bend"]);
  }
  if (thumb.length) {
    const reaction = avg(thumb.map((s) => s.avg_reaction_ms));
    const rate = Math.round(avg(thumb.map((s) => s.success_rate)) * 100);
    items.push([reaction === null ? "-" : Math.round(reaction) + " ms", "thumb reaction"], [rate + " %", "touches made"]);
  }
  $("summary-box").innerHTML = items.length
    ? items.map(([v, l]) => `<div class="item"><div class="value">${v}</div><div class="label">${l}</div></div>`).join("")
    : '<p class="lead">No exercises were recorded in this session.</p>';
}

// ---------------------------------------------------------------- tutorials (inside each step)
async function loadTutorials() {
  if (!db) return;
  const { data, error } = await db.from("tutorials").select("*").order("sort_order");
  if (error) return;
  document.querySelectorAll(".howto").forEach((box) => {
    const list = data.filter((t) => t.exercise_type === box.dataset.type);
    box.querySelector(".howto-body").innerHTML = list.map((t) => `
      <div class="tutorial">
        <div class="level">${escapeHtml(t.level)} &middot; ${t.duration_min} min</div>
        <h3>${escapeHtml(t.title)}</h3>
        <ol>${t.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        ${t.tips ? `<p class="tips">Tip: ${escapeHtml(t.tips)}</p>` : ""}
        ${t.video_url && /^https:\/\//.test(t.video_url) ? `<a target="_blank" rel="noopener" href="${escapeHtml(t.video_url)}">Watch videos &rarr;</a>` : ""}
      </div>`).join("");
  });
}

// ---------------------------------------------------------------- history
async function loadHistory() {
  if (!db || !app.patient) {
    $("progress-summary").textContent = "Choose a patient at the top to see their progress.";
    $("session-table").innerHTML = "";
    return;
  }
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

  // Trend summary: compare the earlier half of the sessions with the later half.
  const halves = (list) => [list.slice(0, Math.floor(list.length / 2)), list.slice(Math.floor(list.length / 2))];
  const parts = [];
  if (flex.length >= 2) {
    const [early, late] = halves(flex);
    const first = avg(early.map((s) => +s.avg_peak_percent));
    const last = avg(late.map((s) => +s.avg_peak_percent));
    const change = Math.round(last - first);
    parts.push(change === 0
      ? `Finger bend steady at ${last.toFixed(0)} %.`
      : `Finger bend ${change > 0 ? "up" : "down"} ${Math.abs(change)} % (from ${first.toFixed(0)} % to ${last.toFixed(0)} %).`);
  }
  if (thumb.length >= 2) {
    const [early, late] = halves(thumb);
    const first = avg(early.map((s) => s.avg_reaction_ms));
    const last = avg(late.map((s) => s.avg_reaction_ms));
    if (first && last) parts.push(`Thumb reaction ${Math.round(first)} ms → ${Math.round(last)} ms (${last <= first ? "faster" : "slower"}).`);
  }
  $("progress-summary").textContent = `${app.patient.name}: ` +
    (parts.length ? parts.join(" ") : `${data.length} session(s) so far. Do at least two of each exercise to see a trend.`);

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
goToStep("calibrate");
loadPorts();
connectSocket();
loadPatients();
loadTutorials();
