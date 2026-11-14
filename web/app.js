// Smart Rehab Glove - website logic.
// Live data comes from the local Python server (WebSocket /ws).
// Nothing is stored: results are shown for the current visit only.

const $ = (id) => document.getElementById(id);

const STEPS = ["calibrate", "flex", "thumb", "summary"];

const app = {
  connected: false,
  step: "calibrate",
  done: new Set(),
  flex: { reps: [], running: false, target: 60, results: [] },
  thumb: { trials: [], running: false, total: 10, results: [] },
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

function avg(values) {
  const list = values.filter((v) => v !== null && v !== undefined);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

// ---------------------------------------------------------------- steps
async function goToStep(step) {
  if (app.flex.running || app.thumb.running) await stopRunning();
  if (step === "calibrate" && app.step === "summary") {
    app.done.clear();
    app.flex.results = [];
    app.thumb.results = [];
  }
  app.step = step;
  STEPS.forEach((s) => {
    $("step-" + s).classList.toggle("active", s === step);
    const li = document.querySelector(`#stepper li[data-step="${s}"]`);
    li.classList.toggle("active", s === step);
    li.classList.toggle("done", s !== step && app.done.has(s));
  });
  if (step === "summary") renderSummary();
}
document.querySelectorAll("#stepper li").forEach((li) => li.addEventListener("click", () => goToStep(li.dataset.step)));
document.querySelectorAll(".next-btn").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.next !== "calibrate") app.done.add(app.step);
  goToStep(b.dataset.next);
}));

async function stopRunning() {
  await api("/api/stop", {}).catch(() => {});
  if (app.flex.running) finishFlex();
  if (app.thumb.running) finishThumb();
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

$("flex-start").addEventListener("click", async () => {
  try {
    await api("/api/flex/start", { target: app.flex.target });
  } catch (error) {
    return toast(error.message, true);
  }
  app.flex.reps = [];
  app.flex.running = true;
  updateFlexStats();
  $("flex-feedback").className = "feedback";
  $("flex-feedback").textContent = "Go! Bend the finger to the black line.";
  $("flex-start").disabled = true;
  $("flex-stop").disabled = false;
  $("flex-target").disabled = true;
});

$("flex-stop").addEventListener("click", async () => {
  await api("/api/stop", {}).catch(() => {});
  finishFlex();
});

function onRep(rep) {
  if (!app.flex.running) return;
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

function finishFlex() {
  $("flex-start").disabled = false;
  $("flex-stop").disabled = true;
  $("flex-target").disabled = false;
  app.flex.running = false;
  if (!app.flex.reps.length) return;
  app.flex.results.push(...app.flex.reps);
  app.flex.reps = [];
  app.done.add("flex");
}

// ---------------------------------------------------------------- step 3: thumb touch
$("thumb-start").addEventListener("click", async () => {
  try {
    await api("/api/thumb/start", { trials: app.thumb.total });
  } catch (error) {
    return toast(error.message, true);
  }
  app.thumb.trials = [];
  app.thumb.running = true;
  $("thumb-trial").textContent = 0;
  $("thumb-total").textContent = app.thumb.total;
  updateThumbStats();
  $("thumb-start").disabled = true;
  $("thumb-stop").disabled = false;
});

$("thumb-stop").addEventListener("click", async () => {
  await api("/api/stop", {}).catch(() => {});
  finishThumb();
});

function setPrompt(text, cls = "") {
  const el = $("thumb-prompt");
  el.textContent = text;
  el.className = "prompt " + cls;
}

function onThumb(msg) {
  if (!app.thumb.running) return;
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
    finishThumb();
  }
}

function updateThumbStats() {
  const trials = app.thumb.trials;
  const ok = trials.filter((t) => t.success);
  const reaction = avg(ok.map((t) => t.reaction_ms));
  $("thumb-avg").textContent = reaction === null ? "-" : Math.round(reaction) + " ms";
  $("thumb-rate").textContent = trials.length ? Math.round((ok.length / trials.length) * 100) + " %" : "-";
}

function finishThumb() {
  $("thumb-start").disabled = false;
  $("thumb-stop").disabled = true;
  app.thumb.running = false;
  if (!app.thumb.trials.length) return;
  app.thumb.results.push(...app.thumb.trials);
  app.thumb.trials = [];
  app.done.add("thumb");
}

// ---------------------------------------------------------------- summary
function renderSummary() {
  const reps = app.flex.results;
  const trials = app.thumb.results;
  const items = [];
  if (reps.length) {
    const good = Math.round((reps.filter((r) => r.quality === "good").length / reps.length) * 100);
    items.push(
      [reps.length, "finger bends"],
      [good + " %", "good repetitions"],
      [Math.max(...reps.map((r) => r.peak_percent)) + " %", "best bend"],
      [Math.round(avg(reps.map((r) => r.peak_percent))) + " %", "average bend"],
    );
  }
  if (trials.length) {
    const ok = trials.filter((t) => t.success);
    const reaction = avg(ok.map((t) => t.reaction_ms));
    items.push(
      [reaction === null ? "-" : Math.round(reaction) + " ms", "thumb reaction"],
      [Math.round((ok.length / trials.length) * 100) + " %", "touches made"],
    );
  }
  $("summary-box").innerHTML = items.length
    ? items.map(([v, l]) => `<div class="item"><div class="value">${v}</div><div class="label">${l}</div></div>`).join("")
    : '<p class="lead">No exercises were recorded yet.</p>';
}

// ---------------------------------------------------------------- tutorials (inside each step)
async function loadTutorials() {
  let tutorials;
  try {
    tutorials = await (await fetch("tutorials.json")).json();
  } catch {
    return;
  }
  document.querySelectorAll(".howto").forEach((box) => {
    const list = tutorials.filter((t) => t.exercise_type === box.dataset.type);
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

// ---------------------------------------------------------------- start
setTarget(60);
updateConnection();
goToStep("calibrate");
loadPorts();
connectSocket();
loadTutorials();
