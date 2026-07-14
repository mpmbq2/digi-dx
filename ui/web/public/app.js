(function () {
  const AF_MIN = 200;
  const AF_MAX = 3000;
  const AF_WINDOW_HZ = 55;
  const STEP_ORDER = [
    ["CALL", "call-grid"],
    ["RPT", "report"],
    ["R-RPT", "r-report"],
    ["RR73", "rr73"],
    ["73", "73"]
  ];

  const refs = {
    setupOverlay: byId("setup-overlay"),
    connStatus: byId("conn-status"),
    stationCall: byId("station-call"),
    stationGrid: byId("station-grid"),
    stationDial: byId("station-dial"),
    cycleValue: byId("cycle-value"),
    radioCat: byId("radio-cat"),
    sessionBtn: byId("session-btn"),
    releaseBtn: byId("release-btn"),
    txIndicator: byId("tx-indicator"),
    afMinus: byId("af-minus"),
    afPlus: byId("af-plus"),
    afValue: byId("af-value"),
    afSlotLabel: byId("af-slot-label"),
    afEvenName: byId("af-even-name"),
    afOddName: byId("af-odd-name"),
    afEvenLane: byId("af-even-lane"),
    afOddLane: byId("af-odd-lane"),
    afTicks: byId("af-ticks"),
    cqCall: byId("cq-call"),
    cqTitle: byId("cq-title"),
    cqSub: byId("cq-sub"),
    cqSlotToggle: byId("cq-slot-toggle"),
    surveyBtn: byId("survey-btn"),
    activeQsos: byId("active-qsos"),
    activeEmpty: byId("active-empty"),
    completedCount: byId("completed-count"),
    completedList: byId("completed-list"),
    nowCard: byId("now-card"),
    nowDot: byId("now-dot"),
    nowLabel: byId("now-label"),
    nowMeta: byId("now-meta"),
    txSwitch: byId("tx-switch"),
    switchTrack: byId("switch-track"),
    switchLabel: byId("switch-label"),
    haltBtn: byId("halt-btn"),
    nowVerb: byId("now-verb"),
    nowMsg: byId("now-msg"),
    nowCycleWindow: byId("now-cycle-window"),
    nowCycleFill: byId("now-cycle-fill"),
    nowCyclePlayhead: byId("now-cycle-playhead"),
    nowCycleText: byId("now-cycle-text"),
    sortTime: byId("sort-time"),
    sortDist: byId("sort-dist"),
    sortSnr: byId("sort-snr"),
    streamList: byId("stream-list"),
    rosterEven: byId("roster-even"),
    rosterOdd: byId("roster-odd"),
    logBar: byId("log-bar"),
    logToggle: byId("log-toggle"),
    logPeek: byId("log-peek"),
    logChevron: byId("log-chevron"),
    logLines: byId("log-lines")
  };

  let socket = null;
  let state = null;
  let connected = false;
  let clockSkewMs = 0;
  let rosterSort = "time";
  let logOpen = false;
  let draggingSlot = null;
  let setupRefs = null;
  const collapsedQsos = new Set();
  const expandedCompleted = new Set();

  wireControls();
  renderAfTicks();
  connect();
  setInterval(() => {
    if (state) {
      renderClockAndNow();
    }
  }, 200);

  function byId(id) {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error(`missing #${id}`);
    }
    return node;
  }

  function connect() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

    socket.addEventListener("open", () => {
      connected = true;
      renderConnection();
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "state") {
        state = message;
        clockSkewMs = state.serverNow - Date.now();
        render();
      }
    });
    socket.addEventListener("close", () => {
      connected = false;
      renderConnection();
      setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => {
      connected = false;
      renderConnection();
    });
  }

  function send(command) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "command", ...command }));
  }

  function wireControls() {
    refs.stationCall.addEventListener("blur", commitIdentity);
    refs.stationGrid.addEventListener("blur", commitIdentity);
    refs.stationDial.addEventListener("blur", commitDial);
    for (const input of [refs.stationCall, refs.stationGrid, refs.stationDial]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      });
    }

    refs.sessionBtn.addEventListener("click", () => {
      if (!state) {
        return;
      }
      send({ cmd: "session", action: state.station.sessionActive ? "stop" : "start" });
    });
    refs.releaseBtn.addEventListener("click", () => send({ cmd: "releaseControl" }));
    refs.cqCall.addEventListener("click", () => {
      const slot = selectedSlot();
      setLocalSlot(slot);
      send({ cmd: "callCq", slot, ...identityPayload() });
    });
    refs.surveyBtn.addEventListener("click", () => send({ cmd: "survey" }));
    refs.txSwitch.addEventListener("click", () => send({ cmd: "txEnable", enabled: !(state?.now.txEnabled ?? true) }));
    refs.haltBtn.addEventListener("click", () => {
      if (state?.now.txEnabled) {
        send({ cmd: "haltTx" });
      } else {
        send({ cmd: "txEnable", enabled: true });
      }
    });
    refs.afMinus.addEventListener("click", () => setAf((state?.af.value ?? 1000) - 25));
    refs.afPlus.addEventListener("click", () => setAf((state?.af.value ?? 1000) + 25));

    refs.cqSlotToggle.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target.closest("[data-slot]") : null;
      if (target instanceof HTMLElement && target.dataset.slot) {
        setLocalSlot(target.dataset.slot);
        send({ cmd: "setSlot", slot: target.dataset.slot });
      }
    });

    for (const lane of [refs.afEvenLane, refs.afOddLane]) {
      lane.addEventListener("pointerdown", (event) => {
        draggingSlot = lane.dataset.slot;
        lane.setPointerCapture(event.pointerId);
        setAfFromPointer(event, lane);
      });
      lane.addEventListener("pointermove", (event) => {
        if (draggingSlot === lane.dataset.slot) {
          setAfFromPointer(event, lane);
        }
      });
      lane.addEventListener("pointerup", () => {
        draggingSlot = null;
      });
      lane.addEventListener("pointercancel", () => {
        draggingSlot = null;
      });
    }

    for (const button of [refs.sortTime, refs.sortDist, refs.sortSnr]) {
      button.addEventListener("click", () => {
        rosterSort = button.dataset.sort ?? "time";
        renderRosters();
      });
    }

    refs.logToggle.addEventListener("click", () => {
      logOpen = !logOpen;
      renderLog();
    });
  }

  function commitIdentity() {
    send({
      cmd: "setIdentity",
      call: refs.stationCall.value,
      grid: refs.stationGrid.value
    });
  }

  function commitDial() {
    const trimmed = refs.stationDial.value.trim();
    send({ cmd: "setDialFreq", mhz: trimmed ? Number(trimmed) : null });
  }

  function setAf(af) {
    send({ cmd: "setAf", af: clamp(Math.round(af), AF_MIN, AF_MAX) });
  }

  function setAfFromPointer(event, lane) {
    const rect = lane.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const af = clamp(Math.round((ratio * AF_MAX) / 5) * 5, AF_MIN, AF_MAX);
    setLocalSlot(lane.dataset.slot);
    send({ cmd: "setSlot", slot: lane.dataset.slot });
    send({ cmd: "setAf", af });
  }

  function selectedSlot() {
    const selected = refs.cqSlotToggle.querySelector("[data-slot].on");
    return selected instanceof HTMLElement && selected.dataset.slot ? selected.dataset.slot : state?.af.slot ?? "even";
  }

  function setLocalSlot(slot) {
    if (state) {
      state.af.slot = slot;
    }
    for (const item of refs.cqSlotToggle.querySelectorAll("[data-slot]")) {
      item.classList.toggle("on", item.dataset.slot === slot);
    }
    refs.afSlotLabel.textContent = slot;
    refs.afEvenLane.classList.toggle("tx", slot === "even");
    refs.afOddLane.classList.toggle("tx", slot === "odd");
    refs.afEvenName.classList.toggle("tx", slot === "even");
    refs.afOddName.classList.toggle("tx", slot === "odd");
  }

  function identityPayload() {
    return {
      myCall: refs.stationCall.value,
      myGrid: refs.stationGrid.value
    };
  }

  function render() {
    renderConnection();
    renderDemoBanner();
    renderStation();
    renderSetup();
    renderClockAndNow();
    renderAf();
    renderQsos();
    renderCompleted();
    renderBand();
    renderRosters();
    renderLog();
  }

  function renderConnection() {
    refs.connStatus.textContent = connected ? "● session live" : "● offline";
    refs.connStatus.classList.toggle("off", !connected);
  }

  function renderStation() {
    if (!state) {
      return;
    }
    setInputIfIdle(refs.stationCall, state.station.call);
    setInputIfIdle(refs.stationGrid, state.station.grid);
    setInputIfIdle(
      refs.stationDial,
      state.station.dialFreqHz == null ? "" : (state.station.dialFreqHz / 1e6).toFixed(3)
    );
    refs.radioCat.textContent = state.station.catConnected ? "CAT ✓" : "CAT ✗";
    refs.radioCat.style.color = state.station.catConnected ? "var(--green)" : "var(--muted)";
    refs.sessionBtn.textContent = state.station.sessionActive ? "■ stop session" : "▶ start session";
    refs.sessionBtn.classList.toggle("active", state.station.sessionActive);
    refs.releaseBtn.disabled = !state.station.controlMine;
    refs.releaseBtn.style.opacity = state.station.controlMine ? "1" : ".55";
  }

  function setInputIfIdle(input, value) {
    if (document.activeElement !== input) {
      input.value = value ?? "";
    }
  }

  // First-run station setup: a blocking overlay shown until the daemon reports a
  // complete session config. Built once, then only its device list and hint are
  // refreshed so it never clobbers what the operator is typing.
  function renderSetup() {
    if (!state) {
      return;
    }
    const setup = state.setup;
    if (!setup || setup.complete) {
      refs.setupOverlay.hidden = true;
      return;
    }
    buildSetupForm();
    refreshSetupDevices(setup.devices || []);
    refs.setupOverlay.hidden = false;
  }

  function buildSetupForm() {
    if (setupRefs) {
      return;
    }
    const card = document.createElement("div");
    card.className = "setup-card";

    const title = document.createElement("h2");
    title.className = "setup-title";
    title.textContent = "Station setup";
    const sub = document.createElement("p");
    sub.className = "setup-sub";
    sub.textContent = "Enter your station details to start operating. Saved to the daemon config.";
    card.append(title, sub);

    const call = setupField(card, "Callsign", "N0CALL");
    const grid = setupField(card, "Grid", "FN31");

    const device = setupSelect(card, "Audio device");
    const catMode = setupSelect(card, "CAT mode");
    for (const mode of ["rigctld", "dummy"]) {
      const opt = document.createElement("option");
      opt.value = mode;
      opt.textContent = mode;
      catMode.append(opt);
    }

    const catPort = setupField(card, "CAT port", "4532");
    catPort.value = "4532";

    const hint = document.createElement("p");
    hint.className = "setup-hint";
    const save = document.createElement("button");
    save.className = "setup-save";
    save.textContent = "Save & continue";
    card.append(hint, save);

    // The way out for somebody with no radio wired yet. Without this, demo mode
    // is a flag a new user would never type, and the first hour of digi-dx is
    // spent guessing whether the software or the radio is broken.
    const demoNote = document.createElement("p");
    demoNote.className = "setup-sub";
    demoNote.textContent = "No radio connected yet? See it work first — nothing is transmitted.";
    const demo = document.createElement("button");
    demo.className = "setup-save setup-demo";
    demo.textContent = "Try it without a radio";
    demo.addEventListener("click", () => send({ cmd: "startDemo" }));
    card.append(demoNote, demo);

    setupRefs = { call, grid, device, catMode, catPort, hint, save, demo };
    save.addEventListener("click", submitSetup);
    refs.setupOverlay.append(card);

    // Prefill call/grid from anything the daemon already knows.
    if (state && state.station) {
      if (state.station.call) {
        call.value = state.station.call;
      }
      if (state.station.grid) {
        grid.value = state.station.grid;
      }
    }
  }

  function setupField(card, label, placeholder) {
    const row = document.createElement("label");
    row.className = "setup-row";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.className = "setup-input";
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    if (placeholder) {
      input.placeholder = placeholder;
    }
    row.append(span, input);
    card.append(row);
    return input;
  }

  function setupSelect(card, label) {
    const row = document.createElement("label");
    row.className = "setup-row";
    const span = document.createElement("span");
    span.textContent = label;
    const select = document.createElement("select");
    select.className = "setup-input";
    row.append(span, select);
    card.append(row);
    return select;
  }

  function refreshSetupDevices(devices) {
    const select = setupRefs.device;
    if (document.activeElement === select) {
      return;
    }
    const signature = devices.map((d) => `${d.id}:${d.name}`).join("|");
    if (select.dataset.signature === signature) {
      return;
    }
    select.dataset.signature = signature;
    const previous = select.value;
    select.textContent = "";
    if (devices.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No audio devices found";
      select.append(opt);
    }
    for (const device of devices) {
      const opt = document.createElement("option");
      opt.value = String(device.id);
      const rate = device.defaultSampleRate ? ` (${device.defaultSampleRate} Hz)` : "";
      opt.textContent = `${device.id}: ${device.name}${rate}`;
      select.append(opt);
    }
    if (previous) {
      select.value = previous;
    }
  }

  function submitSetup() {
    const callsign = setupRefs.call.value.trim().toUpperCase();
    const grid = setupRefs.grid.value.trim().toUpperCase();
    const deviceId = Number(setupRefs.device.value);
    const catMode = setupRefs.catMode.value;
    const catPort = Number(setupRefs.catPort.value);

    const problems = [];
    if (!callsign) problems.push("callsign");
    if (!grid) problems.push("grid");
    if (!setupRefs.device.value || !Number.isInteger(deviceId)) problems.push("audio device");
    if (!Number.isInteger(catPort) || catPort < 1 || catPort > 65535) problems.push("CAT port");
    if (problems.length > 0) {
      setupRefs.hint.textContent = `Please provide: ${problems.join(", ")}`;
      return;
    }

    setupRefs.hint.textContent = "Saving…";
    send({ cmd: "saveSetup", callsign, grid, deviceId, catMode, catPort });
  }

  // Demo mode must be impossible to miss. A ham who believes they worked a
  // station they did not will log it, and a fabricated contact uploaded to LoTW
  // or QRZ cannot be taken back.
  function renderDemoBanner() {
    let banner = document.getElementById("demo-banner");
    const demo = Boolean(state && state.station && state.station.demo);

    if (!demo) {
      if (banner) {
        banner.remove();
      }
      document.body.classList.remove("demo");
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "demo-banner";
      banner.textContent =
        "DEMO MODE — simulated band. Nothing is transmitted and no QSO here is real.";
      document.body.prepend(banner);
    }
    document.body.classList.add("demo");
  }

  function renderClockAndNow() {
    if (!state) {
      return;
    }
    // The browser does no slot arithmetic. The server publishes the parity and
    // the wall instant of the next boundary, already corrected for whatever
    // rate the engine is running at; we only count down to it, against our own
    // clock corrected for skew against the server's. No scale factor and no
    // 15-second constant live here -- this file has no build step and no test
    // coverage, which makes it the worst possible home for that math.
    const nowMs = Date.now() + clockSkewMs;
    const { parity, nextBoundaryWallMs, slotWallMs, slotSeconds } = state.cycle;

    // Position within the slot, measured in wall time against a wall deadline --
    // then reported in FT8 seconds, because an operator reasons in 15-second
    // cycles no matter what rate the engine happens to be running at.
    let cycleFraction = 0;
    let remainingSeconds = null;
    if (nextBoundaryWallMs !== null && slotWallMs) {
      const remainingWallMs = Math.max(0, nextBoundaryWallMs - nowMs);
      cycleFraction = clamp(1 - remainingWallMs / slotWallMs, 0, 1);
      remainingSeconds = (remainingWallMs / slotWallMs) * slotSeconds;
    }

    const countdown = remainingSeconds === null ? "--" : `t-${remainingSeconds.toFixed(1)}`;
    refs.cycleValue.textContent = `${parity.toUpperCase()} · ${countdown}`;

    const activeQso = state.qsos.active[0] ?? null;
    const message = state.now.message ?? activeQso?.nextTx ?? "No TX queued";
    const slot = state.now.slot ?? activeQso?.slot ?? state.af.slot;
    const af = state.now.af ?? state.af.value;
    const visual = txVisualState();

    refs.nowCard.style.background = `linear-gradient(180deg, ${visual.accent}1f, rgba(255, 255, 255, .03))`;
    refs.nowCard.style.borderColor = `${visual.accent}5c`;
    refs.nowDot.style.background = visual.accent;
    refs.nowDot.style.boxShadow = `0 0 10px ${visual.accent}`;
    refs.nowDot.style.animation = visual.pulse ? "blink 1.1s infinite" : "";
    refs.nowLabel.textContent = visual.label;
    refs.nowLabel.style.color = visual.accent;
    refs.nowMeta.textContent = activeQso?.call ? `→ ${activeQso.call} · ${slot} · af ${af}` : `${slot} · af ${af}`;
    refs.nowVerb.textContent = visual.verb;
    refs.nowMsg.textContent = message;
    refs.nowMsg.style.borderLeftColor = visual.accent;
    refs.switchTrack.classList.toggle("on", state.now.txEnabled);
    refs.switchLabel.textContent = state.now.txEnabled ? "TX Enabled" : "TX Disabled";
    refs.haltBtn.textContent = state.now.txEnabled ? "⏸ Halt TX" : "▶ Resume TX";

    const pct = cycleFraction * 100;
    const elapsedSeconds = slotSeconds === null ? null : cycleFraction * slotSeconds;
    refs.nowCycleWindow.style.background = `${visual.accent}14`;
    refs.nowCycleWindow.style.borderRight = `1px dashed ${visual.accent}55`;
    refs.nowCycleFill.style.width = `${pct}%`;
    refs.nowCycleFill.style.background = visual.live ? visual.accent : "#3a4355";
    refs.nowCycleFill.style.boxShadow = visual.live ? `0 0 10px ${visual.accent}aa` : "";
    refs.nowCyclePlayhead.style.left = `${pct}%`;
    refs.nowCycleText.textContent =
      elapsedSeconds === null
        ? "awaiting slot clock"
        : `${elapsedSeconds.toFixed(1)}s / ${slotSeconds.toFixed(1)}s`;

    refs.txIndicator.textContent = visual.indicator;
    refs.txIndicator.classList.toggle("active", visual.key === "active");
    refs.txIndicator.classList.toggle("pending", visual.key === "pending");
  }

  function txVisualState() {
    if (!state.now.txEnabled) {
      return {
        key: "halted",
        label: "TX HALTED",
        verb: "WOULD SEND",
        indicator: "● TX halted",
        accent: "#ff6b5b",
        live: false,
        pulse: false
      };
    }
    if (state.now.surveyActive) {
      return {
        key: "survey",
        label: "SURVEYING",
        verb: "LISTENING",
        indicator: "● survey active",
        accent: "#7cd3dc",
        live: true,
        pulse: false
      };
    }
    if (state.now.txState === "active") {
      return {
        key: "active",
        label: "ACTIVE TX",
        verb: "SENDING",
        indicator: "● TX active",
        accent: "#46d19e",
        live: true,
        pulse: true
      };
    }
    if (state.now.txState === "pending") {
      return {
        key: "pending",
        label: "PENDING TX",
        verb: "ABOUT TO SEND",
        indicator: "● TX pending",
        accent: "#f5c451",
        live: true,
        pulse: false
      };
    }
    if (state.now.message) {
      return {
        key: "scheduled",
        label: "SCHEDULED TX",
        verb: "WILL SEND",
        indicator: "● TX scheduled",
        accent: "#7c9cff",
        live: true,
        pulse: false
      };
    }
    return {
      key: "idle",
      label: "TX IDLE",
      verb: "WOULD SEND",
      indicator: "● TX idle",
      accent: "#8493ad",
      live: false,
      pulse: false
    };
  }

  function renderAf() {
    refs.afValue.textContent = String(state.af.value);
    refs.afSlotLabel.textContent = state.af.slot;
    for (const item of refs.cqSlotToggle.querySelectorAll("[data-slot]")) {
      item.classList.toggle("on", item.dataset.slot === state.af.slot);
    }

    renderAfLane(refs.afEvenLane, refs.afEvenName, "even");
    renderAfLane(refs.afOddLane, refs.afOddName, "odd");
  }

  function renderAfLane(lane, label, slot) {
    lane.replaceChildren();
    const txLane = state.af.slot === slot;
    lane.classList.toggle("tx", txLane);
    label.classList.toggle("tx", txLane);
    label.textContent = txLane ? `${slot.toUpperCase()} <` : slot.toUpperCase();

    const recent = state.decodes.filter((decode) => decode.slot === slot).slice(-80);
    for (const decode of recent) {
      const win = document.createElement("div");
      const color = decodeColor(decode);
      const left = ((decode.af - AF_WINDOW_HZ / 2) / AF_MAX) * 100;
      const width = (AF_WINDOW_HZ / AF_MAX) * 100;
      win.className = "af-win";
      win.style.left = `${clamp(left, 0, 100)}%`;
      win.style.width = `${width}%`;
      win.style.background = `${color}26`;
      win.style.borderLeft = `2px solid ${color}`;
      win.style.borderRight = `2px solid ${color}`;
      win.title = `${decode.af} Hz ${decode.message}`;
      lane.append(win);
    }

    if (txLane) {
      const marker = document.createElement("div");
      const handle = document.createElement("div");
      const left = (state.af.value / AF_MAX) * 100;
      const winLeft = ((state.af.value - AF_WINDOW_HZ / 2) / AF_MAX) * 100;
      marker.className = "af-tx-marker";
      marker.style.left = `${clamp(winLeft, 0, 100)}%`;
      marker.style.width = `${(AF_WINDOW_HZ / AF_MAX) * 100}%`;
      handle.className = "af-tx-handle";
      handle.style.left = `${clamp(left, 0, 100)}%`;
      lane.append(marker, handle);
    }
  }

  function renderAfTicks() {
    refs.afTicks.replaceChildren();
    for (const hz of [0, 500, 1000, 1500, 2000, 2500, 3000]) {
      const tick = document.createElement("span");
      tick.textContent = String(hz);
      tick.style.left = `${(hz / AF_MAX) * 100}%`;
      refs.afTicks.append(tick);
    }
  }

  function renderQsos() {
    refs.cqCall.classList.toggle("calling", state.qsos.callingCq);
    refs.cqCall.textContent = state.qsos.callingCq ? "■" : "▶";
    refs.cqTitle.textContent = state.qsos.callingCq ? "Calling CQ" : "Call CQ";
    refs.cqSub.textContent = state.qsos.callingCq ? `transmitting on ${state.af.slot.toUpperCase()}` : "auto-stacks replies below";
    refs.surveyBtn.classList.toggle("active", state.now.surveyActive);
    refs.surveyBtn.textContent = state.now.surveyActive ? "⟳ Surveying…" : "⟳ Survey";
    refs.activeQsos.replaceChildren();
    refs.activeEmpty.style.display = state.qsos.active.length === 0 ? "block" : "none";

    for (const qso of state.qsos.active) {
      refs.activeQsos.append(renderQsoCard(qso));
    }
  }

  function renderQsoCard(qso) {
    const collapsed = collapsedQsos.has(qso.id);
    const card = document.createElement("div");
    card.className = `qso status-${qso.status}${collapsed ? " collapsed" : ""}`;

    const stripe = document.createElement("div");
    stripe.className = "qso-stripe";
    stripe.style.background = qso.color;
    card.append(stripe);

    if (collapsed) {
      card.append(qsoPriority(qso), textSpan("qso-call", qso.call ?? "UNKNOWN"), textSpan("qso-grid", qso.grid ?? ""));
      const tag = textSpan("qso-tag", stepLabel(qso.stepKey));
      const expand = iconButton("▸", () => {
        collapsedQsos.delete(qso.id);
        renderQsos();
      });
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      card.append(spacer, tag, expand);
      return card;
    }

    const main = document.createElement("div");
    main.className = "qso-main";
    const head = document.createElement("div");
    head.className = "qso-head";
    head.append(
      qsoPriority(qso),
      textSpan("qso-call", qso.call ?? "UNKNOWN"),
      textSpan("qso-grid", qso.grid ?? ""),
      textSpan("qso-tag", `${qso.attempts} att · ${qso.slot}`),
      textSpan("qso-tag", qso.kind === "caller" ? "FROM CQ" : "HUNTED")
    );
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    head.append(spacer, textSpan("qso-heard", qso.heardAgoSec == null ? "not heard" : `heard ${age(qso.heardAgoSec)} ago`));
    main.append(head, qsoSteps(qso));

    const io = document.createElement("div");
    io.className = "qso-io";
    io.append(labelValue("RX", qso.lastRx ?? "-"), labelValue("TX", qso.nextTx ?? "-", true));
    main.append(io);

    if (qso.note) {
      main.append(textSpan("qso-note", qso.note));
    }

    const actions = document.createElement("div");
    actions.className = "qso-actions";
    actions.append(
      actionButton("‹ step", qso.id, "prevStep"),
      actionButton("step ›", qso.id, "nextStep"),
      actionButton(qso.status === "active" ? "↻ Retry" : "▶ Resume", qso.id, qso.status === "active" ? "retry" : "resume"),
      actionButton("✓ Complete", qso.id, "complete", "go"),
      actionButton("✕ Abandon", qso.id, "abandon", "danger"),
      qrzLink(qso.call, null, "QRZ ↗")
    );
    main.append(actions);

    const side = document.createElement("div");
    side.className = "qso-side";
    side.append(
      iconButton("▾", () => {
        collapsedQsos.add(qso.id);
        renderQsos();
      }),
      actionButton("▲", qso.id, "moveUp"),
      actionButton("▼", qso.id, "moveDown"),
      actionButton("↻", qso.id, "retry")
    );

    card.append(main, side);
    return card;
  }

  function qsoPriority(qso) {
    const prio = textSpan("qso-prio", String(qso.priority));
    prio.style.background = qso.color;
    return prio;
  }

  function qsoSteps(qso) {
    const wrap = document.createElement("div");
    wrap.className = "qso-steps";
    const current = stepIndex(qso.stepKey);
    for (let index = 0; index < STEP_ORDER.length; index++) {
      const [label] = STEP_ORDER[index];
      const step = document.createElement("div");
      const seg = document.createElement("div");
      const text = document.createElement("span");
      step.className = "qso-step";
      seg.className = "qso-step-seg";
      text.className = "qso-step-label";
      text.textContent = label;
      if (index <= current) {
        seg.style.background = qso.color;
        seg.style.opacity = index < current ? ".5" : "1";
        text.style.color = index === current ? qso.color : "#7c8797";
        if (index === current) {
          seg.style.boxShadow = `0 0 8px ${qso.color}`;
        }
      }
      step.append(seg, text);
      wrap.append(step);
    }
    return wrap;
  }

  function renderCompleted() {
    refs.completedCount.textContent = String(state.qsos.completed.length);
    refs.completedList.replaceChildren();
    for (const qso of state.qsos.completed) {
      refs.completedList.append(renderCompletedRow(qso));
    }
  }

  function renderCompletedRow(qso) {
    if (expandedCompleted.has(qso.id)) {
      const wrap = document.createElement("div");
      wrap.className = "done-expand";
      const row = document.createElement("div");
      row.className = "row1";
      row.append(
        textSpan("done-check", "✓"),
        textSpan("done-call", qso.call ?? "UNKNOWN"),
        textSpan("done-grid", qso.grid ?? ""),
        textSpan("logged", "LOGGED"),
        spacer(),
        textSpan("done-time", qso.time)
      );
      row.addEventListener("click", () => {
        expandedCompleted.delete(qso.id);
        renderCompleted();
      });
      const io = document.createElement("div");
      io.className = "io";
      io.append(
        textSpan("lbl", "SENT"),
        document.createTextNode(qso.sentReport ?? "-"),
        textSpan("lbl", "RCVD"),
        document.createTextNode(qso.receivedReport ?? "-"),
        textSpan("lbl", "SLOT"),
        document.createTextNode(qso.slot ?? "-")
      );
      const links = document.createElement("div");
      links.className = "links";
      links.append(qrzLink(qso.call, null, "QRZ ↗"));
      wrap.append(row, io, links);
      return wrap;
    }

    const row = document.createElement("div");
    row.className = "done-row";
    row.append(
      textSpan("done-check", "✓"),
      textSpan("done-call", qso.call ?? "UNKNOWN"),
      textSpan("done-grid", qso.grid ?? ""),
      textSpan("done-rep", `${qso.sentReport ?? "-"} / ${qso.receivedReport ?? "-"}`),
      spacer(),
      textSpan("done-time", qso.time)
    );
    row.addEventListener("click", () => {
      expandedCompleted.add(qso.id);
      renderCompleted();
    });
    return row;
  }

  function renderBand() {
    refs.streamList.replaceChildren();
    const rows = [...state.decodes].reverse();
    let previousCycle = null;
    for (const decode of rows) {
      const cycle = decode.cycleStart;
      if (cycle !== previousCycle) {
        previousCycle = cycle;
        const divider = document.createElement("div");
        divider.className = "cycle-divider";
        divider.textContent = `${time(cycle)} ${decode.slot.toUpperCase()} CYCLE`;
        refs.streamList.append(divider);
      }
      refs.streamList.append(renderDecodeRow(decode));
    }
  }

  function renderDecodeRow(decode) {
    const row = document.createElement("div");
    row.className = "decode-row";
    row.title = "Double-click to start a QSO";
    row.addEventListener("dblclick", () => {
      if (decode.from) {
        send({ cmd: "replyToCall", call: decode.from, ...identityPayload() });
      }
    });

    const bar = document.createElement("div");
    bar.className = "decode-bar";
    bar.style.background = decodeColor(decode);
    const snr = textSpan("decode-snr", signed(decode.snr));
    snr.style.color = snrColor(decode.snr);
    const msg = textSpan("decode-msg", decode.message);
    msg.style.color = decode.kind === "worked" ? "#5b636f" : decode.kind === "reply" ? "#f3d896" : "#c6cfdb";

    const tags = document.createElement("div");
    tags.className = "decode-tags";
    if (decode.kind === "reply") {
      tags.append(textSpan("tag-mini tag-you", "TO YOU"));
    } else if (decode.kind === "worked") {
      tags.append(textSpan("tag-mini tag-worked", "✓"));
    }
    if (decode.from) {
      const work = document.createElement("button");
      work.className = "decode-work";
      work.textContent = "▶";
      work.addEventListener("click", (event) => {
        event.stopPropagation();
        send({ cmd: "replyToCall", call: decode.from, ...identityPayload() });
      });
      tags.append(work);
    }
    row.append(bar, snr, msg, tags);
    return row;
  }

  function renderRosters() {
    for (const button of [refs.sortTime, refs.sortDist, refs.sortSnr]) {
      button.classList.toggle("active", button.dataset.sort === rosterSort);
    }
    renderRoster(refs.rosterEven, state.rosters.even);
    renderRoster(refs.rosterOdd, state.rosters.odd);
  }

  function renderRoster(container, entries) {
    container.replaceChildren();
    for (const entry of sortedRoster(entries)) {
      const row = document.createElement("div");
      row.className = `roster-row${entry.kind === "worked" ? " worked" : ""}`;
      row.title = "Double-click to start a QSO";
      row.addEventListener("dblclick", () => send({ cmd: "replyToCall", call: entry.call, ...identityPayload() }));

      const r1 = document.createElement("div");
      r1.className = "r1";
      const dot = document.createElement("span");
      dot.className = "roster-dot";
      dot.style.background = decodeColor(entry);
      dot.style.boxShadow = `0 0 6px ${decodeColor(entry)}88`;
      const snr = textSpan("roster-snr", `${signed(entry.snr)} dB`);
      snr.style.color = snrColor(entry.snr);
      r1.append(dot, textSpan("roster-call", entry.call), spacer(), snr, qrzLink(entry.call, "roster-qrz"));

      const meta = document.createElement("div");
      meta.className = "roster-meta";
      const dist = distanceLabel(state.station.grid, entry.grid);
      meta.append(
        textSpan("", entry.grid ?? "--"),
        document.createTextNode("·"),
        textSpan("dist", dist),
        document.createTextNode("·"),
        document.createTextNode(age(entry.ageSec))
      );
      row.append(r1, meta);
      container.append(row);
    }
  }

  function sortedRoster(entries) {
    return [...entries]
      .map((entry) => ({ ...entry, distMi: distanceMiles(state.station.grid, entry.grid) }))
      .sort((a, b) => {
        if (rosterSort === "dist") {
          return (b.distMi ?? -1) - (a.distMi ?? -1);
        }
        if (rosterSort === "snr") {
          return b.snr - a.snr;
        }
        return a.ageSec - b.ageSec;
      });
  }

  function renderLog() {
    refs.logBar.classList.toggle("open", logOpen);
    refs.logChevron.textContent = logOpen ? "▾ hide" : "▸ show";
    const last = state.log[state.log.length - 1];
    refs.logPeek.textContent = last?.text ?? "";
    refs.logLines.replaceChildren();
    for (const line of state.log.slice().reverse()) {
      const item = document.createElement("div");
      item.className = `l-${line.level}`;
      item.textContent = line.text;
      refs.logLines.append(item);
    }
  }

  function actionButton(label, id, action, className) {
    const button = document.createElement("button");
    button.textContent = label;
    if (className) {
      button.className = className;
    }
    button.addEventListener("click", () => send({ cmd: "qso", id, action }));
    return button;
  }

  function iconButton(label, onClick) {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function qrzLink(call, className, label) {
    const link = document.createElement("a");
    link.href = call ? `https://www.qrz.com/db/${encodeURIComponent(call)}` : "#";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = label ?? "QRZ";
    if (className) {
      link.className = className;
    }
    link.addEventListener("click", (event) => event.stopPropagation());
    return link;
  }

  function labelValue(label, value, tx) {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "6px";
    wrap.style.minWidth = "0";
    wrap.append(textSpan(tx ? "tx-lbl" : "lbl", label), textSpan(tx ? "tx" : "rx", value));
    return wrap;
  }

  function textSpan(className, text) {
    const span = document.createElement("span");
    if (className) {
      span.className = className;
    }
    span.textContent = text;
    return span;
  }

  function spacer() {
    const span = document.createElement("span");
    span.className = "spacer";
    return span;
  }

  function stepIndex(stepKey) {
    if (stepKey === "done") {
      return STEP_ORDER.length;
    }
    return Math.max(0, STEP_ORDER.findIndex(([, key]) => key === stepKey));
  }

  function stepLabel(stepKey) {
    return STEP_ORDER.find(([, key]) => key === stepKey)?.[0] ?? stepKey.toUpperCase();
  }

  function decodeColor(item) {
    if (item.kind === "reply") {
      return "#f5c451";
    }
    if (item.kind === "worked") {
      return "#5b6472";
    }
    if (item.kind === "qso" && item.color) {
      return item.color;
    }
    return "#7c9cff";
  }

  function snrColor(snr) {
    return snr > -10 ? "#3fb950" : snr > -18 ? "#c6cfdb" : "#6b7684";
  }

  function signed(value) {
    return value > 0 ? `+${value}` : String(value);
  }

  function age(seconds) {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    }
    if (seconds < 3600) {
      return `${Math.round(seconds / 60)}m`;
    }
    return `${Math.round(seconds / 3600)}h`;
  }

  function time(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }


  function distanceLabel(fromGrid, toGrid) {
    const miles = distanceMiles(fromGrid, toGrid);
    return miles == null ? "-- mi" : `${miles.toLocaleString()} mi`;
  }

  function distanceMiles(fromGrid, toGrid) {
    const from = gridToLatLon(fromGrid);
    const to = gridToLatLon(toGrid);
    if (!from || !to) {
      return null;
    }
    const earthKm = 6371;
    const toRad = Math.PI / 180;
    const dLat = (to.lat - from.lat) * toRad;
    const dLon = (to.lon - from.lon) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(from.lat * toRad) * Math.cos(to.lat * toRad) * Math.sin(dLon / 2) ** 2;
    const km = earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(km * 0.621371);
  }

  function gridToLatLon(grid) {
    if (!grid || !/^[A-Ra-r]{2}\d{2}/.test(grid)) {
      return null;
    }
    const g = grid.toUpperCase();
    const lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2 + 1;
    const lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) + 0.5;
    return { lat, lon };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
})();
