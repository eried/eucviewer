// EUC RUN — minigame. Hold the logo on the load screen to play, or open
// the page with #skills in the URL.
// One button: tap / click / space jumps, hold the press for a higher jump.
// Self-contained: injects its own overlay + styles, no dependencies.
(function () {
  "use strict";
  if (window.eucGameOpen) return;

  const BEST_KEY = "euc_runner_best_v2"; // v2: points scoring (was meters)
  const CYAN = "#00e5ff", PURPLE = "#b388ff", GREEN = "#69f0ae", RED = "#ff5252";

  let root = null, canvas = null, ctx = null, msgEl = null, scoreEl = null;
  let raf = 0, lastT = 0, open = false, prevHash = "";

  // --- game state ---
  let mode = "ready";           // ready | run | dead
  let speed = 0, dist = 0, best = 0;
  // Score: 1 point per second survived + 1 point per obstacle cleared.
  // Small memorable numbers instead of a giant odometer.
  let ptsTime = 0, ptsJumps = 0;
  let wheel = null;             // { y, vy, onGround }
  let obstacles = [];           // { type: 'rock'|'hole', x, w, h }
  let nextSpawn = 0;
  let holdingJump = false, jumpBuffer = 0, diedAt = 0, shake = 0;
  let bannerEl = null, invincible = false;

  // Ragdoll crash: on death the rider flies off as a small verlet ragdoll
  // (the wheel stays behind) and the camera chases the tumbling body,
  // launched at whatever speed the run had when it ended.
  let ragdoll = null, crashWheel = null, dieMsg = null;
  const RD_DT = 1 / 60, RD_G = 2600;

  // Rush mode: every 30 s of riding, a 10 s burst layered on top of the
  // normal acceleration (base speed keeps climbing on its own; the rush is
  // a temporary multiplier). Two flavours picked at random: a cop car
  // nosing in from behind, or a slower "lame" e-rider ahead to chase.
  let sinceRush = 0, rushActive = false, rushT = 0, rushKind = "cop", leaderType = "ebike", rushMult = 1;
  const RUSH_EVERY = 30, RUSH_LEN = 10, RUSH_BOOST = 0.38;

  const WHEEL_X = 96, WHEEL_R = 17;
  const GRAV = 2400, JUMP_V = -760, JUMP_CUT = -280;

  function cssH() { return canvas.clientHeight; }
  function cssW() { return canvas.clientWidth; }
  // Ground sits ~16% up from the bottom (min 70 px) so the action rides
  // closer to the middle of the screen.
  function groundY() { return cssH() - Math.max(70, cssH() * 0.16); }

  function setRushClass(kind) {
    if (!root) return;
    // Ending a rush leaves a static glow of the same colour behind
    // (rush-out-*) so the border can fade out slowly instead of vanishing
    // with the animation.
    const wasCop = root.classList.contains("rush-cop");
    const wasLame = root.classList.contains("rush-lame");
    root.classList.remove("rush-cop", "rush-lame", "rush-out-cop", "rush-out-lame");
    if (kind === "cop") root.classList.add("rush-cop");
    else if (kind === "lame") root.classList.add("rush-lame");
    else if (wasCop) root.classList.add("rush-out-cop");
    else if (wasLame) root.classList.add("rush-out-lame");
  }

  function reset() {
    speed = 280; dist = 0;
    ptsTime = 0; ptsJumps = 0;
    sinceRush = 0; rushActive = false; rushT = 0; rushMult = 1;
    ragdoll = null; crashWheel = null; dieMsg = null;
    setRushClass(null);
    wheel = { y: groundY() - WHEEL_R, vy: 0, onGround: true };
    obstacles = [];
    nextSpawn = cssW() + 120;
    holdingJump = false; jumpBuffer = 0; shake = 0;
  }

  function start() { reset(); mode = "run"; msgEl.classList.add("eg-hide"); }

  function die(kind) {
    if (invincible) return;
    mode = "dead"; diedAt = performance.now(); shake = 10;
    rushActive = false; sinceRush = 0; rushMult = 1;
    setRushClass(null);
    if (bannerEl) bannerEl.classList.remove("show");
    // Launch the ragdoll at the speed the run had. Normal crashes leave the
    // wheel behind; a shelf clotheslines the rider off while the riderless
    // wheel bounces away down the road.
    crashWheel = {
      x: WHEEL_X, y: wheel.y,
      vx: kind === "shelf" ? speed : 0,
      // a shelf hit always happens mid-jump: the wheel keeps its live
      // vertical momentum, finishes the arc and bounces out
      vy: kind === "shelf" ? wheel.vy : 0,
      trav: 0,
    };
    ragdoll = makeRagdoll(WHEEL_X, wheel.y, speed, kind);
    const s = Math.floor(ptsTime) + ptsJumps;
    if (s > best) { best = s; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} }
    // Reveal the panel after the tumble has had its moment (see loop()).
    dieMsg = `<div class="eg-title eg-bad">${kind === "shelf" ? "WATCHOUT" : "CUTOUT"}</div>` +
      `<div class="eg-sub">${s} pts &middot; best ${best}</div>` +
      `<div class="eg-hint">${ptsJumps} obstacle${ptsJumps === 1 ? "" : "s"} &middot; ${Math.floor(ptsTime)} s &middot; tap to ride again</div>`;
  }

  function makeRagdoll(wx, wy, v, kind) {
    const jit = () => (Math.random() - 0.5) * 140;
    const mk = (x, y, vx, vy) => ({ x, y, px: x - vx * RD_DT, py: y - vy * RD_DT });
    let d;
    if (kind === "shelf") {
      // Clotheslined: the upper body stops dead against the shelf and drops,
      // the legs whip forward from under the rider.
      d = {
        head:  mk(wx + 3, wy - 66, -v * 0.06 + jit() * 0.3, 40 + jit() * 0.3),
        hip:   mk(wx,     wy - 42, v * 0.10 + jit() * 0.3, -30 + jit() * 0.3),
        footL: mk(wx - 4, wy - 12, v * 0.55 + jit() * 0.5, -120 + jit() * 0.5),
        footR: mk(wx + 6, wy - 12, v * 0.55 + jit() * 0.5, -120 + jit() * 0.5),
        hand:  mk(wx + 12, wy - 36, -v * 0.05 + jit() * 0.3, -60 + jit() * 0.3),
        acc: 0,
      };
    } else {
      d = {
        head:  mk(wx + 3, wy - 66, v + jit(), -340 + jit()),
        hip:   mk(wx,     wy - 42, v + jit(), -240 + jit()),
        footL: mk(wx - 4, wy - 12, v * 1.1 + jit(), -150 + jit()),
        footR: mk(wx + 6, wy - 12, v * 1.1 + jit(), -150 + jit()),
        hand:  mk(wx + 12, wy - 36, v + jit(), -320 + jit()),
        acc: 0,
      };
    }
    d.links = [
      [d.head, d.hip, 25], [d.hip, d.footL, 30], [d.hip, d.footR, 30],
      [d.head, d.hand, 22], [d.footL, d.footR, 12],
    ];
    return d;
  }

  function stepRagdoll(dt) {
    // A shelf crash leaves the wheel bouncing away riderless.
    if (crashWheel && crashWheel.vx > 0) {
      crashWheel.x += crashWheel.vx * dt;
      crashWheel.trav += crashWheel.vx * dt;
      crashWheel.vy += RD_G * dt;
      crashWheel.y += crashWheel.vy * dt;
      const wg = groundY() - WHEEL_R;
      if (crashWheel.y > wg) {
        crashWheel.y = wg;
        crashWheel.vy = -Math.abs(crashWheel.vy) * 0.55; // damped bounce
        crashWheel.vx *= 0.97;
      }
    }
    ragdoll.acc = Math.min(0.1, ragdoll.acc + dt);
    const gy = groundY();
    while (ragdoll.acc >= RD_DT) {
      ragdoll.acc -= RD_DT;
      for (const k of ["head", "hip", "footL", "footR", "hand"]) {
        const p = ragdoll[k];
        const vx = (p.x - p.px) * 0.995;
        const vy = (p.y - p.py) * 0.995 + RD_G * RD_DT * RD_DT;
        p.px = p.x; p.py = p.y;
        p.x += vx; p.y += vy;
        if (p.y > gy - 3) {
          p.y = gy - 3;
          p.py = p.y + vy * 0.5;   // bounce, damped
          p.px = p.x - vx * 0.55;  // ground friction
        }
      }
      for (let i = 0; i < 3; i++) {
        for (const [a, b, len] of ragdoll.links) {
          const dx = b.x - a.x, dy = b.y - a.y;
          const cur = Math.sqrt(dx * dx + dy * dy) || 1;
          const k = (cur - len) / cur / 2;
          a.x += dx * k; a.y += dy * k;
          b.x -= dx * k; b.y -= dy * k;
        }
      }
    }
  }

  function showBanner(text, color) {
    if (!bannerEl) return;
    bannerEl.textContent = text;
    bannerEl.style.color = color;
    bannerEl.style.textShadow = "0 0 20px " + color;
    bannerEl.classList.add("show");
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => bannerEl.classList.remove("show"), 2400);
  }

  function popScore() {
    if (!scoreEl) return;
    scoreEl.classList.remove("eg-pop");
    void scoreEl.offsetWidth; // restart the pop animation
    scoreEl.classList.add("eg-pop");
  }

  function jump() {
    if (mode === "ready") { start(); return; }
    if (mode === "dead") {
      if (performance.now() - diedAt > 700) start();
      return;
    }
    holdingJump = true;
    if (wheel.onGround) { wheel.vy = JUMP_V; wheel.onGround = false; }
    else jumpBuffer = 0.1; // buffered: fires the instant we land
  }
  function endJump() {
    holdingJump = false;
    jumpBuffer = 0;
    if (mode === "run" && wheel.vy < JUMP_CUT) wheel.vy = JUMP_CUT; // early release = lower hop
  }

  function spawn() {
    // Keep every layout jumpable: holes stay shorter than the airtime arc,
    // rocks stay under the apex (tall ones need a full held jump). Shelves
    // invert the rule: ride under them, never jump. Faster = denser traffic.
    // Difficulty gates: the first 10 s are rocks only, holes join after
    // that, tall rocks and shelves only after the first minute.
    const roll = Math.random();
    if (roll < 0.42 && ptsTime >= 10) {
      const w = 55 + Math.random() * (45 + Math.min(60, speed * 0.08));
      obstacles.push({ type: "hole", x: nextSpawn, w, h: 0 });
      nextSpawn += w;
    } else if (roll >= 0.42 && roll < 0.52 && ptsTime >= 60) {
      // extra lead-in so a shelf never sits where you land from a forced jump
      nextSpawn += 150;
      const w = 46 + Math.random() * 22;
      obstacles.push({ type: "shelf", x: nextSpawn, w, h: 10 });
      nextSpawn += w;
    } else {
      const tall = ptsTime >= 60 && Math.random() < 0.1;
      const h = tall ? 50 + Math.random() * 16 : 16 + Math.random() * 26;
      const w = 16 + Math.random() * 18;
      obstacles.push({ type: "rock", x: nextSpawn, w, h });
      nextSpawn += w;
    }
    // Gaps tighten as the run goes on (full squeeze by ~80 s) so nobody
    // cruises forever; scores stay small and memorable.
    const shrink = Math.max(0.45, 1 - ptsTime / 90);
    nextSpawn += (240 + Math.random() * 300) * shrink + speed * rushMult * 0.22;
  }

  function step(dt) {
    if (mode === "dead" && ragdoll) { stepRagdoll(dt); return; }
    if (mode !== "run") return;
    speed = Math.min(860, speed + 11 * dt);
    ptsTime += dt;

    // Rush scheduling: burst multiplier ramps in and out over 0.8 s so the
    // speed change feels like a shove, not a teleport.
    sinceRush += dt;
    if (!rushActive && sinceRush >= RUSH_EVERY) {
      rushActive = true; rushT = 0;
      rushKind = Math.random() < 0.5 ? "cop" : "lame";
      if (rushKind === "lame") leaderType = ["ebike", "onewheel", "board"][Math.floor(Math.random() * 3)];
      showBanner(
        rushKind === "cop" ? "LICENSE? LOL!" : "FOLLOW THE LAME!",
        rushKind === "cop" ? RED : GREEN
      );
      setRushClass(rushKind);
    }
    if (rushActive) {
      rushT += dt;
      if (rushT >= RUSH_LEN) { rushActive = false; sinceRush = 0; setRushClass(null); }
    }
    const ramp = rushActive ? Math.max(0, Math.min(1, rushT / 0.8, (RUSH_LEN - rushT) / 0.8)) : 0;
    rushMult = 1 + RUSH_BOOST * ramp;

    const dx = speed * rushMult * dt;
    dist += dx;

    for (const o of obstacles) {
      o.x -= dx;
      if (!o.scored && o.x + o.w < WHEEL_X - WHEEL_R) { o.scored = true; ptsJumps++; popScore(); }
    }
    obstacles = obstacles.filter((o) => o.x + o.w > -40);
    nextSpawn -= dx;
    if (nextSpawn < cssW() + 60) spawn();

    // vertical physics
    wheel.vy += GRAV * dt;
    wheel.y += wheel.vy * dt;
    const gy = groundY();

    // is the wheel over a hole?
    let overHole = null;
    for (const o of obstacles) {
      if (o.type === "hole" && WHEEL_X > o.x + 6 && WHEEL_X < o.x + o.w - 6) { overHole = o; break; }
    }
    if (wheel.y >= gy - WHEEL_R) {
      if (overHole) {
        // no ground under the wheel: fall through and wipe out
        if (wheel.y - WHEEL_R > gy + 6) die();
        wheel.onGround = false;
      } else {
        wheel.y = gy - WHEEL_R;
        wheel.vy = 0;
        if (!wheel.onGround && jumpBuffer > 0 && holdingJump) { wheel.vy = JUMP_V; jumpBuffer = 0; }
        else wheel.onGround = true;
      }
    } else {
      wheel.onGround = false;
    }
    if (jumpBuffer > 0) jumpBuffer -= dt;

    // rock collision: circle vs rect, forgiving margins
    for (const o of obstacles) {
      if (o.type === "rock") {
        const rx = o.x + 3, rw = o.w - 6, ry = gy - o.h + 3;
        const cx = Math.max(rx, Math.min(WHEEL_X, rx + rw));
        const cy = Math.max(ry, Math.min(wheel.y, gy));
        const ddx = WHEEL_X - cx, ddy = wheel.y - cy;
        if (ddx * ddx + ddy * ddy < (WHEEL_R - 3) * (WHEEL_R - 3)) { die(); break; }
      } else if (o.type === "shelf") {
        // safe to roll under; lethal the moment you rise into it
        if (WHEEL_X > o.x - 4 && WHEEL_X < o.x + o.w + 4 &&
            wheel.y < gy - WHEEL_R - 10) { die("shelf"); break; }
      }
    }
  }

  function draw() {
    const w = cssW(), h = cssH(), gy = groundY();
    ctx.clearRect(0, 0, w, h);

    // Camera: pinned during the run; after a crash it chases the ragdoll
    // so the tumble plays out while the wheel shrinks into the distance.
    const camX = ragdoll ? Math.max(0, ragdoll.hip.x - WHEEL_X) : 0;

    let ox = 0, oy = 0;
    if (shake > 0) { ox = (Math.random() - 0.5) * shake; oy = (Math.random() - 0.5) * shake; shake *= 0.85; }
    ctx.save();
    ctx.translate(ox, oy);

    // sky: distant grid lines drifting for a sense of speed
    ctx.strokeStyle = "rgba(0,229,255,0.07)";
    ctx.lineWidth = 1;
    const grid = 90, off = -((dist * 0.35 + camX * 0.35) % grid);
    for (let x = off; x < w; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, gy); ctx.stroke();
    }

    // ground with holes cut out
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 3;
    ctx.shadowColor = CYAN; ctx.shadowBlur = 8;
    let segStart = 0;
    const holes = obstacles.filter((o) => o.type === "hole").sort((a, b) => a.x - b.x);
    ctx.beginPath();
    for (const o of holes) {
      const a = Math.max(0, o.x - camX), b = Math.min(w, o.x + o.w - camX);
      if (a > segStart) { ctx.moveTo(segStart, gy); ctx.lineTo(a, gy); }
      segStart = Math.max(segStart, b);
    }
    if (segStart < w) { ctx.moveTo(segStart, gy); ctx.lineTo(w, gy); }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // hole depth walls
    ctx.strokeStyle = "rgba(0,229,255,0.35)";
    ctx.lineWidth = 2;
    for (const o of holes) {
      const hx = o.x - camX;
      ctx.beginPath();
      ctx.moveTo(hx, gy); ctx.lineTo(hx + 6, h);
      ctx.moveTo(hx + o.w, gy); ctx.lineTo(hx + o.w - 6, h);
      ctx.stroke();
    }

    // rocks + overhead shelves
    for (const o of obstacles) {
      if (o.type === "rock") {
        const rx = o.x - camX;
        ctx.fillStyle = "rgba(179,136,255,0.25)";
        ctx.strokeStyle = PURPLE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(rx, gy);
        ctx.lineTo(rx + o.w * 0.2, gy - o.h);
        ctx.lineTo(rx + o.w * 0.85, gy - o.h * 0.8);
        ctx.lineTo(rx + o.w, gy);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      } else if (o.type === "shelf") {
        const sx = o.x - camX, sy = gy - 106;
        ctx.fillStyle = "rgba(255,215,64,0.22)";
        ctx.strokeStyle = "#ffd740";
        ctx.lineWidth = 2;
        ctx.shadowColor = "#ffd740"; ctx.shadowBlur = 8;
        ctx.fillRect(sx, sy, o.w, o.h);
        ctx.strokeRect(sx, sy, o.w, o.h);
        ctx.shadowBlur = 0;
      }
    }

    // rush guests slide in while the burst is on
    const slide = rushActive ? Math.max(0, Math.min(1, rushT / 0.6, (RUSH_LEN - rushT) / 0.6)) : 0;
    if (slide > 0) {
      if (rushKind === "cop") drawCop(70 * slide, gy);
      else drawLeader(104 * slide, gy);
    }

    if (ragdoll) {
      // crashed wheel left behind, spokes frozen
      const wxs = crashWheel.x - camX;
      ctx.strokeStyle = "rgba(0,229,255,0.8)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(wxs, crashWheel.y, WHEEL_R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(0,229,255,0.45)"; ctx.lineWidth = 2;
      const rot0 = (dist + (crashWheel.trav || 0)) / WHEEL_R;
      for (let i = 0; i < 3; i++) {
        const a = rot0 + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.moveTo(wxs + Math.cos(a) * 4, crashWheel.y + Math.sin(a) * 4);
        ctx.lineTo(wxs + Math.cos(a) * (WHEEL_R - 4), crashWheel.y + Math.sin(a) * (WHEEL_R - 4));
        ctx.stroke();
      }
      // the ragdoll itself
      const r = ragdoll;
      ctx.strokeStyle = "#e0e0e0"; ctx.lineWidth = 3; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(r.head.x - camX, r.head.y); ctx.lineTo(r.hip.x - camX, r.hip.y);
      ctx.moveTo(r.hip.x - camX, r.hip.y); ctx.lineTo(r.footL.x - camX, r.footL.y);
      ctx.moveTo(r.hip.x - camX, r.hip.y); ctx.lineTo(r.footR.x - camX, r.footR.y);
      ctx.moveTo(r.head.x - camX, r.head.y); ctx.lineTo(r.hand.x - camX, r.hand.y);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(r.head.x - camX, r.head.y - 4, 6, 0, Math.PI * 2); ctx.stroke();
    } else {
      // rider: wheel + lean-forward stick figure (leans harder in a rush)
      const wy = wheel ? wheel.y : gy - WHEEL_R;
      const rushRamp = (rushMult - 1) / RUSH_BOOST;
      const lean = (mode === "run" ? Math.min(0.35, speed / 1800) : 0.12) + 0.24 * rushRamp;
      ctx.save();
      ctx.translate(WHEEL_X, wy);
      ctx.strokeStyle = CYAN; ctx.lineWidth = 3;
      ctx.shadowColor = CYAN; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(0, 0, WHEEL_R, 0, Math.PI * 2); ctx.stroke();
      ctx.shadowBlur = 0;
      const rot = dist / WHEEL_R;
      ctx.strokeStyle = "rgba(0,229,255,0.55)"; ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const a = rot + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
        ctx.lineTo(Math.cos(a) * (WHEEL_R - 4), Math.sin(a) * (WHEEL_R - 4));
        ctx.stroke();
      }
      const air = wheel && !wheel.onGround;
      ctx.rotate(lean);
      ctx.strokeStyle = "#e0e0e0"; ctx.lineWidth = 3; ctx.lineCap = "round";
      const hipY = air ? -34 : -42, headY = air ? -56 : -66;
      ctx.beginPath();
      ctx.moveTo(-4, -WHEEL_R + 6); ctx.lineTo(0, hipY);           // legs
      ctx.moveTo(6, -WHEEL_R + 6); ctx.lineTo(0, hipY);
      ctx.moveTo(0, hipY); ctx.lineTo(2, headY + 8);               // torso
      ctx.moveTo(2, headY + 10); ctx.lineTo(12, hipY + 6);         // arm
      ctx.stroke();
      ctx.beginPath(); ctx.arc(3, headY, 6, 0, Math.PI * 2); ctx.stroke(); // head
      ctx.restore();
    }

    ctx.restore();

    // HUD: just the number, big, plus the best badge. Write only when the
    // value changes: a per-frame innerHTML rewrite keeps invalidating the
    // bar and the text shimmers on mobile GPUs.
    const s = Math.floor(ptsTime) + ptsJumps;
    const hudKey = s + "|" + best;
    if (draw._hudKey !== hudKey) {
      draw._hudKey = hudKey;
      scoreEl.innerHTML = `<b>${s}</b>` + (best ? `<span class="eg-best">BEST ${best}</span>` : "");
    }
  }

  // Front of a compact cop SUV nosing in from the left edge, light bar
  // strobing, driver waving out of the windshield. Sized so the nose stays
  // just behind the player's wheel.
  function drawCop(vis, gy) {
    const W = 95, x = vis - W, y = gy - 50;
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#dfe7ef";
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + W * 0.45, y);                                  // roof
    ctx.lineTo(x + W * 0.64, y + 18);                             // windshield
    ctx.lineTo(x + W * 0.92, y + 22);                             // hood
    ctx.quadraticCurveTo(x + W + 4, y + 25, x + W - 2, y + 36);   // nose
    ctx.lineTo(x + W - 2, gy - 7);
    ctx.lineTo(x, gy - 7);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    const red = Math.sin(rushT * 14) > 0;
    ctx.fillStyle = red ? RED : "#448aff";
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 14;
    ctx.fillRect(x + W * 0.28, y - 8, 22, 8);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#9fb3c8"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x + W * 0.75, gy - 5, 10, 0, Math.PI * 2); ctx.stroke();
    // driver waving behind the windshield
    const hx = x + W * 0.40, hy = y + 11;
    const wave = Math.sin(rushT * 9);
    ctx.strokeStyle = "#e0e0e0"; ctx.lineWidth = 2.5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hx + 2, hy + 5); ctx.lineTo(hx + 5, hy + 16);
    ctx.moveTo(hx + 3, hy + 8); ctx.lineTo(hx + 13, hy - 3 - wave * 6);
    ctx.stroke();
    ctx.restore();
  }

  // Back of a slower e-rider poking in from the right edge: the one to
  // chase. Random vehicle per rush, rider waves back tauntingly.
  function drawLeader(vis, gy) {
    const x0 = cssW() - vis;
    const bob = Math.sin(rushT * 5) * 2;
    ctx.save();
    ctx.translate(x0, gy + bob);
    ctx.strokeStyle = GREEN; ctx.lineWidth = 2.5; ctx.lineCap = "round";
    ctx.shadowColor = GREEN; ctx.shadowBlur = 8;
    if (leaderType === "ebike") {
      ctx.beginPath(); ctx.arc(18, -13, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(18, -13); ctx.lineTo(40, -34); ctx.lineTo(58, -34);
      ctx.moveTo(34, -38); ctx.lineTo(40, -34);
      ctx.stroke();
      drawLeaderRider(30, -38);
    } else if (leaderType === "onewheel") {
      ctx.beginPath(); ctx.arc(30, -14, 14, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, -26); ctx.lineTo(62, -26); ctx.stroke();
      drawLeaderRider(22, -26);
    } else {
      ctx.beginPath(); ctx.arc(12, -8, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(52, -8, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(6, -16); ctx.lineTo(58, -16); ctx.stroke();
      drawLeaderRider(30, -16);
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  function drawLeaderRider(px, py) {
    const wave = Math.sin(rushT * 9);
    ctx.strokeStyle = "#e0e0e0"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px - 5, py); ctx.lineTo(px, py - 16);
    ctx.moveTo(px + 6, py); ctx.lineTo(px, py - 16);
    ctx.moveTo(px, py - 16); ctx.lineTo(px + 2, py - 34);
    ctx.moveTo(px + 1, py - 30); ctx.lineTo(px - 10, py - 40 - wave * 5);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(px + 3, py - 40, 6, 0, Math.PI * 2); ctx.stroke();
  }

  function loop(t) {
    if (!open) return;
    const dt = Math.max(0, Math.min(0.032, (t - lastT) / 1000 || 0));
    lastT = t;
    step(dt);
    draw();
    // Let the ragdoll tumble steal the show before the result panel drops.
    if (mode === "dead" && dieMsg && performance.now() - diedAt > 900) {
      msgEl.innerHTML = dieMsg;
      dieMsg = null;
      msgEl.classList.remove("eg-hide");
    }
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (wheel && wheel.onGround) wheel.y = groundY() - WHEEL_R;
  }

  function close() {
    open = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKeyUp);
    if (root) root.remove();
    root = null;
    // Leave the shareable #skills only while the game is up; restore
    // whatever the page had (replaceState, so no router/hashchange runs).
    try {
      const back = prevHash && prevHash !== "#skills" ? prevHash : "#load";
      history.replaceState(null, "", location.pathname + location.search + back);
    } catch (e) {}
  }

  function onKey(e) {
    if (e.key === "Escape") { close(); return; }
    if (e.code === "Space" || e.key === "ArrowUp") { e.preventDefault(); if (!e.repeat) jump(); }
  }
  function onKeyUp(e) {
    if (e.code === "Space" || e.key === "ArrowUp") endJump();
  }

  function build() {
    root = document.createElement("div");
    root.id = "euc-game";
    root.innerHTML =
      `<style>
        #euc-game { position: fixed; inset: 0; z-index: 3000; background: #0a0a12;
          display: flex; flex-direction: column;
          font-family: "Orbitron", ui-monospace, Consolas, monospace;
          user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
        #euc-game .eg-bar { display: flex; align-items: center; gap: 12px;
          padding: max(18px, env(safe-area-inset-top)) 16px 10px; }
        #euc-game .eg-logo { color: ${CYAN}; font-weight: 700; letter-spacing: 0.18em;
          font-size: 0.8rem; text-transform: uppercase; }
        #euc-game .eg-score { margin-left: auto; display: flex; flex-direction: column;
          align-items: flex-end; gap: 4px; color: #fff; font-variant-numeric: tabular-nums; line-height: 1; }
        #euc-game .eg-score b { font-size: 1.8rem; font-weight: 900; display: inline-block;
          min-width: 2.6em; text-align: right; /* fixed box: digits changing width can't jiggle the number */
          transform-origin: 100% 100%; } /* pop grows up-left, never over BEST */
        #euc-game .eg-score .eg-best { color: ${GREEN}; font-size: 0.62rem; letter-spacing: 0.14em; }
        #euc-game .eg-close { background: transparent; border: 1px solid rgba(255,255,255,0.2);
          color: #aaa; width: 30px; height: 30px; border-radius: 2px; cursor: pointer; font-size: 1rem; }
        #euc-game .eg-close:hover { color: #fff; border-color: ${CYAN}; }
        #euc-game canvas { flex: 1; width: 100%; height: 100%; display: block; touch-action: none; }
        #euc-game .eg-msg { position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 8px; pointer-events: none;
          text-align: center; transition: opacity 0.2s; }
        #euc-game .eg-msg.eg-hide { opacity: 0; }
        #euc-game .eg-title { color: #fff; font-size: 2.2rem; font-weight: 900; letter-spacing: 0.28em; }
        #euc-game .eg-title.eg-bad { color: ${RED}; text-shadow: 0 0 26px rgba(255, 82, 82, 0.6); }
        #euc-game .eg-sub { color: ${PURPLE}; font-size: 1rem; }
        #euc-game .eg-hint { color: #888; font-size: 0.78rem; margin-top: 10px; letter-spacing: 0.08em; }
        #euc-game .eg-banner { position: absolute; top: 16%; left: 50%;
          transform: translate(-50%, 0) scale(0.9); font-weight: 800; font-size: 1.7rem;
          letter-spacing: 0.18em; text-transform: uppercase; opacity: 0;
          pointer-events: none; transition: opacity 0.25s, transform 0.25s; }
        #euc-game .eg-banner.show { opacity: 1; transform: translate(-50%, 0) scale(1.06); }
        #euc-game .eg-score.eg-pop b { animation: eg-pop 0.3s ease-out; color: ${GREEN}; }
        @keyframes eg-pop { 0% { transform: scale(1.4); } 100% { transform: scale(1); } }
        #euc-game::after { content: ""; position: absolute; inset: 0; pointer-events: none;
          opacity: 0; transition: opacity 3s; } /* slow fade-out after a rush */
        #euc-game.rush-cop::after, #euc-game.rush-lame::after { transition: opacity 1s; }
        #euc-game.rush-cop::after { opacity: 1; animation: eg-cop 0.6s linear infinite; }
        @keyframes eg-cop {
          0%, 49%  { box-shadow: inset 0 0 70px rgba(255, 82, 82, 0.5); }
          50%, 100% { box-shadow: inset 0 0 70px rgba(68, 138, 255, 0.5); }
        }
        #euc-game.rush-lame::after { opacity: 1; animation: eg-lame 1.1s ease-in-out infinite alternate; }
        @keyframes eg-lame {
          0%   { box-shadow: inset 0 0 40px rgba(105, 240, 174, 0.3); }
          100% { box-shadow: inset 0 0 75px rgba(105, 240, 174, 0.65); }
        }
        #euc-game.rush-out-cop::after  { box-shadow: inset 0 0 70px rgba(255, 82, 82, 0.5); }
        #euc-game.rush-out-lame::after { box-shadow: inset 0 0 60px rgba(105, 240, 174, 0.5); }
      </style>
      <div class="eg-bar">
        <button type="button" class="eg-close" aria-label="Close">&times;</button>
        <span class="eg-logo">EUC RUN</span>
        <span class="eg-score" id="eg-score"></span>
      </div>
      <canvas></canvas>
      <div class="eg-banner" id="eg-banner"></div>
      <div class="eg-msg" id="eg-msg">
        <div class="eg-hint">tap / click / space to begin</div>
      </div>`;
    document.body.appendChild(root);
    canvas = root.querySelector("canvas");
    msgEl = root.querySelector("#eg-msg");
    scoreEl = root.querySelector("#eg-score");
    bannerEl = root.querySelector("#eg-banner");
    // Drop the pop class once its animation finishes: a lingering class
    // replays the pulse whenever the browser restarts CSS animations
    // (e.g. returning to the tab via the back button).
    scoreEl.addEventListener("animationend", () => scoreEl.classList.remove("eg-pop"));
    root.querySelector(".eg-close").addEventListener("click", close);
    canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); jump(); });
    canvas.addEventListener("pointerup", endJump);
    canvas.addEventListener("pointercancel", endJump);
  }

  // The display font loads from Google Fonts; building the UI before it
  // arrives paints fallback glyphs that visibly swap. Inject the
  // stylesheet (once), wait for the faces (capped at 900 ms), then build.
  function ensureFont() {
    return new Promise((resolve) => {
      let link = document.getElementById("eg-font");
      if (!link) {
        link = document.createElement("link");
        link.id = "eg-font";
        link.rel = "stylesheet";
        link.href = "https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&display=swap";
        document.head.appendChild(link);
      }
      const done = () => {
        if (!document.fonts || !document.fonts.load) { resolve(); return; }
        Promise.all(["500", "700", "900"].map((w) => document.fonts.load(w + " 16px Orbitron")))
          .then(resolve, resolve);
      };
      if (link.sheet) done();
      else { link.addEventListener("load", done); link.addEventListener("error", () => resolve()); }
      setTimeout(resolve, 900); // never block the game on a slow font CDN
    });
  }

  window.eucGameOpen = function (opts) {
    if (open) return;
    open = true;
    invincible = !!(opts && opts.invincible);
    // Put the shareable link in the URL bar while the game is up.
    prevHash = location.hash;
    try { history.replaceState(null, "", location.pathname + location.search + "#skills"); } catch (e) {}
    try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { best = 0; }
    ensureFont().then(() => {
      if (!open || root) return;
      build();
      resize();
      window.addEventListener("resize", resize);
      document.addEventListener("keydown", onKey);
      document.addEventListener("keyup", onKeyUp);
      mode = "ready";
      reset();
      lastT = performance.now();
      raf = requestAnimationFrame(loop);
    });
  };
  // Tiny state probe so automated tests can watch a run without reaching
  // into the closure.
  window.eucGameState = function () {
    return {
      mode, rushActive, rushKind, leaderType,
      rushMult: +rushMult.toFixed(2),
      speed: Math.round(speed),
      score: Math.floor(ptsTime) + ptsJumps,
      jumps: ptsJumps,
      t: +ptsTime.toFixed(1),
      crashWheelX: crashWheel ? Math.round(crashWheel.x) : null,
      crashWheelY: crashWheel ? Math.round(crashWheel.y) : null,
      obstacleTypes: obstacles.map((o) => o.type),
      obstacles: obstacles.map((o) => ({ t: o.type, x: Math.round(o.x), w: Math.round(o.w) })),
      wheelY: wheel ? Math.round(wheel.y) : null,
      grounded: wheel ? wheel.onGround : null,
    };
  };
})();
