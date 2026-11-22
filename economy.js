/*
 * Basement Datacenter: economy rules.
 *
 * This file is pure game logic: no buttons, no screen, no saving to disk.
 * That keeps the math in one place and lets us test it automatically in Node
 * (see tests/ and tools/simulate.js). The page loads it as window.Economy.
 *
 * Every number we expect to tune during playtesting lives in the tables
 * directly below. Change a value, reload the page, play.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Tunable numbers (starting assumptions: adjust these through playtesting)
  // ---------------------------------------------------------------------------

  const CONFIG = {
    clickValue: 1,                    // $ earned per manual "Run a job" click
    baseCooling: 5,                   // the basement is cold; this much cooling is free
    moveGoal: 200000,                 // lifetime $ needed to unlock the move-out choice
    offlineCapSeconds: 2 * 60 * 60,   // offline earnings stop counting after 2 hours
    revealFraction: 0.5,              // an item appears once lifetime earnings reach half its base price
    maxBulkBuy: 1000,                 // safety limit for "Max" purchases

    // Incidents: short events that ask for a quick decision while you're playing.
    firstEventSeconds: 90,            // seconds of play before the first incident
    eventGapMinSeconds: 90,           // cooldown in seconds of live play after an incident
    eventGapMaxSeconds: 180,
    eventOfferSeconds: 20,            // time to answer an offer
    eventLiveGapSeconds: 1.5,         // slower frames are accounted as time away
    eventReturnGraceSeconds: 60,      // minimum time before a new offer after returning
    eventMinMachines: 1,              // keep offers out of the opening tutorial
  };

  // Each threshold multiplies the income of all machines of that type, including earlier purchases.
  const MILESTONES = [
    { count: 10, mult: 2 },
    { count: 25, mult: 2 },
    { count: 50, mult: 2 },
    { count: 100, mult: 2 },
  ];

  // growth = how much the price rises with each one you own (1.15 = +15%)
  const MACHINES = [
    { id: 'laptop', name: 'Old Laptop', icon: '💻', baseCost: 10, growth: 1.15, income: 0.4, heat: 1, revealAt: 0,
      blurb: 'Found it in a closet. The fan sounds like a jet engine.' },
    { id: 'tower', name: 'Desktop Tower', icon: '🖥️', baseCost: 120, growth: 1.15, income: 3, heat: 3,
      blurb: 'A beige box from a garage sale. Still smells like 2009.' },
    { id: 'rack', name: 'Rack Server', icon: '🗄️', baseCost: 1500, growth: 1.15, income: 20, heat: 10,
      blurb: 'Real enterprise hardware. The lights dim when it boots.' },
    { id: 'gpu', name: 'GPU Rig', icon: '🎮', baseCost: 15000, growth: 1.15, income: 125, heat: 40, requiresMove: true,
      blurb: 'Eight graphics cards zip-tied to a shelf.' },
  ];

  const COOLERS = [
    { id: 'fan', name: 'Box Fan', icon: '🌀', baseCost: 25, growth: 1.2, cooling: 4,
      blurb: 'Point it at the problem.' },
    { id: 'ac', name: 'Window AC', icon: '❄️', baseCost: 600, growth: 1.2, cooling: 25,
      blurb: 'The basement window is tiny. It fits. Barely.' },
    { id: 'liquid', name: 'Liquid Loop', icon: '💧', baseCost: 8000, growth: 1.2, cooling: 120,
      blurb: 'Tubes everywhere. What could possibly go wrong?' },
  ];

  // effect keys: clickMult, incomeMult, heatMult, coolingMult, machineMult: { machineId: x }
  const UPGRADES = [
    { id: 'macros', name: 'Keyboard Macros', icon: '⌨️', cost: 50,
      effect: { clickMult: 2 }, desc: 'Clicking earns 2×.' },
    { id: 'paste', name: 'Fresh Thermal Paste', icon: '🧴', cost: 250, requires: { laptop: 1 },
      effect: { machineMult: { laptop: 2 } }, desc: 'Laptops earn 2×.' },
    { id: 'ssd', name: 'SSD Swap', icon: '💾', cost: 1000, requires: { tower: 1 },
      effect: { machineMult: { tower: 2 } }, desc: 'Towers earn 2×.' },
    { id: 'cables', name: 'Cable Management', icon: '🧶', cost: 1500,
      effect: { coolingMult: 1.25 }, desc: 'All cooling +25% (airflow, baby).' },
    { id: 'overclock', name: 'Overclock Everything', icon: '⚡', cost: 5000,
      // Heat must rise MORE than income, or this can never hurt (while overheating, equal
      // multipliers cancel out exactly). With 2× heat it pays off only if you have spare cooling.
      effect: { incomeMult: 1.5, heatMult: 2 }, desc: 'All income 1.5×, but all heat 2×. Only worth it with spare cooling.' },
    { id: 'serveros', name: 'Server OS', icon: '🐧', cost: 10000, requires: { rack: 1 },
      effect: { machineMult: { rack: 2 } }, desc: 'Racks earn 2×.' },
  ];

  const LOCATIONS = {
    basement: { name: "Parents' Basement", room: 'The Basement', effect: {} },
    warehouse: { name: 'Arctic Warehouse', room: 'The Warehouse', icon: '🧊', effect: { coolingMult: 3 },
      desc: 'Cooling ×3. Room to pack in machines without melting anything.' },
    office: { name: 'Downtown Office', room: 'The Office', icon: '🏙️', effect: { incomeMult: 1.5, clickMult: 5 },
      desc: 'All income 1.5× and clicking 5×. Your cooling stays exactly as it is.' },
  };

  /*
   * Ignored offers expire harmlessly, except a heat wave that expires during live play.
   * Each incident has an "accept" and a "decline" outcome. Outcomes can:
   *   cashSeconds  - pay you this many seconds of current income (at least minCash)
   *   costSeconds  - cost this many seconds of current income (at least minCost)
   *   freeMachine  - give one free copy of your best machine
   *   duration + effect - apply temporary multipliers (same keys as upgrades)
   * Prices are locked in when the incident appears, so the button never changes under your cursor.
   */
  const EVENTS = [
    { id: 'blogger', icon: '📸', title: 'A tech blogger wants a tour',
      text: 'Show them around? Free publicity brings in a wave of new clients.',
      accept: { label: 'Give the tour', cashSeconds: 60, minCash: 25 },
      decline: { label: 'No thanks' },
      minMachines: 1 },
    { id: 'rush', icon: '⏱️', title: 'Rush job!',
      text: 'A client needs results NOW and pays double, but running flat out makes a lot of heat. Worth it only if you have spare cooling.',
      accept: { label: 'Take the job', duration: 45, effect: { incomeMult: 2, heatMult: 2.5 }, summary: 'income ×2, heat ×2.5' },
      decline: { label: 'Pass' },
      minMachines: 5 },
    { id: 'heatwave', icon: '☀️', title: 'Heat wave incoming',
      text: "It's going to hit 98°F outside. Unless you do something, cooling drops 30% for a minute.",
      accept: { label: 'Buy bags of ice', costSeconds: 20, minCost: 15 },
      decline: { label: 'Tough it out', duration: 60, effect: { coolingMult: 0.7 }, summary: 'cooling −30%' },
      minMachines: 3 },
    { id: 'liquidation', icon: '📦', title: 'Office liquidation sale',
      text: 'A bankrupt startup is giving away hardware. A free machine, but it brings its own heat.',
      accept: { label: 'Take it', freeMachine: true },
      decline: { label: 'Leave it' },
      minMachines: 3 },
  ];

  const SAVE_VERSION = 1;

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  function byId(list) {
    const out = {};
    for (const item of list) out[item.id] = item;
    return out;
  }
  const MACHINE_BY_ID = byId(MACHINES);
  const COOLER_BY_ID = byId(COOLERS);
  const UPGRADE_BY_ID = byId(UPGRADES);
  const EVENT_BY_ID = byId(EVENTS);
  const TABLES = { machine: MACHINE_BY_ID, cooler: COOLER_BY_ID, upgrade: UPGRADE_BY_ID };

  function lookup(kind, id) {
    const table = TABLES[kind];
    return table && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
  }

  function zeroCounts(list) {
    const out = {};
    for (const item of list) out[item.id] = 0;
    return out;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function newState(now) {
    return {
      version: SAVE_VERSION,
      money: 0,          // spendable cash
      lifetime: 0,       // everything ever earned (never goes down; drives reveals and the milestone)
      clicks: 0,
      machines: zeroCounts(MACHINES),
      coolers: zeroCounts(COOLERS),
      upgrades: [],
      location: 'basement',
      flags: {},         // one-time story messages already shown
      event: null,       // incident waiting for an answer: { id, remaining, cash?, price?, machineId? }
      active: null,      // temporary effect running: { id, side: 'accept' | 'decline', remaining }
      nextEventIn: CONFIG.firstEventSeconds,
      startedAt: now,
      lastTick: now,     // last moment production was credited (used for offline progress)
    };
  }

  function milestoneMult(count) {
    let multiplier = 1;
    for (const tier of MILESTONES) {
      if (count < tier.count) break;
      multiplier *= tier.mult;
    }
    return multiplier;
  }

  function nextMilestone(count) {
    return MILESTONES.find((tier) => tier.count > count) || null;
  }

  // Combine ownership milestones, purchased upgrades, location and any active incident.
  function modifiers(state) {
    const mod = { clickMult: 1, incomeMult: 1, heatMult: 1, coolingMult: 1, machineMult: {} };
    for (const m of MACHINES) mod.machineMult[m.id] = milestoneMult(state.machines[m.id] || 0);
    const effects = state.upgrades.map((id) => UPGRADE_BY_ID[id]).filter(Boolean).map((u) => u.effect);
    effects.push(LOCATIONS[state.location].effect);
    const temp = activeOutcome(state);
    if (temp && temp.effect) effects.push(temp.effect);
    for (const e of effects) {
      for (const key of ['clickMult', 'incomeMult', 'heatMult', 'coolingMult']) {
        if (e[key]) mod[key] *= e[key];
      }
      if (e.machineMult) {
        for (const id of Object.keys(e.machineMult)) {
          mod.machineMult[id] = (mod.machineMult[id] || 1) * e.machineMult[id];
        }
      }
    }
    return mod;
  }

  /*
   * Everything the screen needs to know about production right now.
   *
   * Heat rule: load = heat / cooling. Up to 100% load, machines run at full speed.
   * Above that, they slow down in proportion: 150% load -> 1/1.5 = 67% speed.
   */
  function stats(state) {
    const mod = modifiers(state);
    const incomePerUnit = {};
    const heatPerUnit = {};
    const coolingPerUnit = {};
    let rawIncome = 0;
    let heat = 0;

    for (const m of MACHINES) {
      const n = state.machines[m.id] || 0;
      incomePerUnit[m.id] = m.income * (mod.machineMult[m.id] || 1) * mod.incomeMult;
      heatPerUnit[m.id] = m.heat * mod.heatMult;
      rawIncome += n * incomePerUnit[m.id];
      heat += n * heatPerUnit[m.id];
    }

    let cooling = CONFIG.baseCooling;
    for (const c of COOLERS) cooling += (state.coolers[c.id] || 0) * c.cooling;
    cooling *= mod.coolingMult;
    for (const c of COOLERS) coolingPerUnit[c.id] = c.cooling * mod.coolingMult;

    const load = heat / cooling;
    const throttle = load > 1 ? 1 / load : 1;

    return {
      income: rawIncome * throttle,   // $ per second actually earned
      rawIncome,                      // $ per second if nothing were overheating
      heat,
      cooling,
      load,                           // 1 = exactly at capacity
      throttle,                       // 1 = full speed, 0.5 = half speed
      clickValue: CONFIG.clickValue * mod.clickMult,
      incomePerUnit,
      heatPerUnit,
      coolingPerUnit,
    };
  }

  // ---------------------------------------------------------------------------
  // Prices and purchases
  // ---------------------------------------------------------------------------

  // Price of the next one when you already own `owned` of them. Always a whole dollar.
  function price(def, owned) {
    return Math.ceil(def.baseCost * Math.pow(def.growth, owned) - 1e-9);
  }

  function ownedCount(state, kind, id) {
    if (kind === 'machine') return state.machines[id] || 0;
    if (kind === 'cooler') return state.coolers[id] || 0;
    if (kind === 'upgrade') return state.upgrades.includes(id) ? 1 : 0;
    return 0;
  }

  function cost(state, kind, id) {
    const def = lookup(kind, id);
    if (!def) return Infinity;
    return kind === 'upgrade' ? def.cost : price(def, ownedCount(state, kind, id));
  }

  // Requirements other than money: having moved out, owning a prerequisite machine.
  function meetsRequirements(state, def) {
    if (def.requiresMove && state.location === 'basement') return false;
    if (def.requires) {
      for (const id of Object.keys(def.requires)) {
        if ((state.machines[id] || 0) < def.requires[id]) return false;
      }
    }
    return true;
  }

  // Should the shop show this item yet? Items appear as you approach being able to afford them.
  function isRevealed(state, kind, id) {
    const def = lookup(kind, id);
    if (!def) return false;
    if (ownedCount(state, kind, id) > 0) return true;
    if (!meetsRequirements(state, def)) return false;
    const base = kind === 'upgrade' ? def.cost : def.baseCost;
    const revealAt = def.revealAt != null ? def.revealAt : base * CONFIG.revealFraction;
    return state.lifetime >= revealAt;
  }

  function revealPoint(kind, id) {
    const def = lookup(kind, id);
    if (!def) return Infinity;
    const base = kind === 'upgrade' ? def.cost : def.baseCost;
    return def.revealAt != null ? def.revealAt : base * CONFIG.revealFraction;
  }

  function nextReveal(state) {
    let next = null;
    for (const [kind, table] of Object.entries(TABLES)) {
      for (const def of Object.values(table)) {
        if (!meetsRequirements(state, def) || isRevealed(state, kind, def.id)) continue;
        const at = revealPoint(kind, def.id);
        if (!next || at < next.at) next = { kind, id: def.id, at };
      }
    }
    return next;
  }

  function canBuy(state, kind, id) {
    const def = lookup(kind, id);
    if (!def) return false;
    if (kind === 'upgrade' && state.upgrades.includes(id)) return false;
    return meetsRequirements(state, def) && state.money >= cost(state, kind, id);
  }

  // Returns { ok: true, cost } or { ok: false, reason: 'unknown' | 'owned' | 'locked' | 'poor' }.
  function buy(state, kind, id) {
    const def = lookup(kind, id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (kind === 'upgrade' && state.upgrades.includes(id)) return { ok: false, reason: 'owned' };
    if (!meetsRequirements(state, def)) return { ok: false, reason: 'locked' };
    const c = cost(state, kind, id);
    if (state.money < c) return { ok: false, reason: 'poor' };

    state.money -= c;
    if (kind === 'machine') state.machines[id] += 1;
    else if (kind === 'cooler') state.coolers[id] += 1;
    else state.upgrades.push(id);
    return { ok: true, cost: c };
  }

  // Total price of the next `n` machines/coolers (each one priced as if bought one at a time).
  function bulkCost(state, kind, id, n) {
    const def = lookup(kind, id);
    if (!def) return Infinity;
    if (kind === 'upgrade') return n === 1 ? cost(state, kind, id) : Infinity;
    const owned = ownedCount(state, kind, id);
    let total = 0;
    for (let i = 0; i < n; i++) total += price(def, owned + i);
    return total;
  }

  // How many you could buy right now with the money you have.
  function maxAffordable(state, kind, id) {
    const def = lookup(kind, id);
    if (!def || kind === 'upgrade' || !meetsRequirements(state, def)) return 0;
    const owned = ownedCount(state, kind, id);
    let total = 0;
    let n = 0;
    while (n < CONFIG.maxBulkBuy) {
      const next = price(def, owned + n);
      if (total + next > state.money) break;
      total += next;
      n += 1;
    }
    return n;
  }

  // Buy exactly `n` (all or nothing). Same result as calling buy() n times.
  function buyMany(state, kind, id, n) {
    if (kind === 'upgrade' || n === 1) {
      const r = buy(state, kind, id);
      return r.ok ? { ok: true, cost: r.cost, count: 1 } : r;
    }
    const def = lookup(kind, id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (!(n >= 1) || !Number.isInteger(n)) return { ok: false, reason: 'unknown' };
    if (!meetsRequirements(state, def)) return { ok: false, reason: 'locked' };
    const c = bulkCost(state, kind, id, n);
    if (state.money < c) return { ok: false, reason: 'poor' };
    state.money -= c;
    if (kind === 'machine') state.machines[id] += n;
    else state.coolers[id] += n;
    return { ok: true, cost: c, count: n };
  }

  // ---------------------------------------------------------------------------
  // Earning
  // ---------------------------------------------------------------------------

  function earn(state, amount) {
    state.money += amount;
    state.lifetime += amount;
  }

  // One manual "Run a job" click. Not affected by heat: you're doing it by hand.
  function click(state) {
    const value = stats(state).clickValue;
    earn(state, value);
    state.clicks += 1;
    return value;
  }

  // Run the machines for `seconds`. Income is constant between purchases, so this is exact.
  function advance(state, seconds) {
    if (!(seconds > 0)) return 0;
    const earned = stats(state).income * seconds;
    earn(state, earned);
    return earned;
  }

  /*
   * Credit production for the time since lastTick, then move lastTick to now.
   * Used every frame while playing AND when the page reopens (offline progress).
   * Long gaps are capped at CONFIG.offlineCapSeconds; a clock that went backwards credits nothing.
   *
   * Existing offers and effects age in real time. Only short, visible intervals can start offers
   * or apply an ignored heat wave. A modal can veto a new offer with allowSpawn: false.
   */
  function catchUp(state, now, { live = true, allowSpawn = true, rng = Math.random } = {}) {
    const seconds = Math.max(0, (now - state.lastTick) / 1000);
    const watching = live && seconds <= CONFIG.eventLiveGapSeconds;
    const credited = Math.min(seconds, CONFIG.offlineCapSeconds);
    let creditLeft = credited;
    let earned = 0;
    let throttleSeconds = 0;
    function creditSegment(duration) {
      const paid = Math.min(creditLeft, duration);
      if (paid <= 0) return;
      const rates = stats(state);
      const amount = rates.income * paid;
      earn(state, amount);
      earned += amount;
      throttleSeconds += rates.throttle * paid;
      creditLeft -= paid;
    }
    const notices = tickEvents(state, seconds, rng, { watching, allowSpawn, creditSegment });
    const throttle = credited > 0 ? throttleSeconds / credited : stats(state).throttle;
    state.lastTick = now;
    return { seconds, credited, earned, capped: seconds > CONFIG.offlineCapSeconds, throttle, notices };
  }

  // ---------------------------------------------------------------------------
  // Incidents
  // ---------------------------------------------------------------------------

  function machineCount(state) {
    let n = 0;
    for (const m of MACHINES) n += state.machines[m.id] || 0;
    return n;
  }

  // The outcome whose temporary effect is running right now, if any.
  function activeOutcome(state) {
    if (!state.active) return null;
    const def = EVENT_BY_ID[state.active.id];
    return def ? def[state.active.side] : null;
  }

  function clearIncidents(state) {
    state.event = null;
    state.active = null;
  }

  function nextGap(rng) {
    return CONFIG.eventGapMinSeconds + rng() * (CONFIG.eventGapMaxSeconds - CONFIG.eventGapMinSeconds);
  }

  // Your most advanced machine type (the free one in a liquidation sale).
  function bestOwnedMachine(state) {
    for (let i = MACHINES.length - 1; i >= 0; i--) {
      if (state.machines[MACHINES[i].id] > 0) return MACHINES[i].id;
    }
    return null;
  }

  // Offer an incident now. forceId picks a specific one (for testing and the console helper).
  function startEvent(state, rng, forceId) {
    if (state.event || state.active) return null;
    const pool = forceId
      ? EVENTS.filter((e) => e.id === forceId)
      : EVENTS.filter((e) => machineCount(state) >= e.minMachines);
    if (!pool.length) return null;
    const def = pool[Math.min(pool.length - 1, Math.floor((rng || Math.random)() * pool.length))];
    const income = stats(state).income;
    const ev = { id: def.id, remaining: CONFIG.eventOfferSeconds };
    const a = def.accept;
    if (a.cashSeconds) ev.cash = Math.max(a.minCash, Math.round(income * a.cashSeconds));
    if (a.costSeconds) ev.price = Math.max(a.minCost, Math.ceil(income * a.costSeconds));
    if (a.freeMachine) {
      ev.machineId = bestOwnedMachine(state);
      if (!ev.machineId) return null;
    }
    state.event = ev;
    // Reserve the cooldown now. It starts counting down after the offer and its effect finish.
    state.nextEventIn = nextGap(rng || Math.random);
    return ev;
  }

  // Answer the current incident. Returns { ok, choice, event, outcome } or { ok: false, reason }.
  function respondToEvent(state, choice) {
    const ev = state.event;
    if (!ev) return { ok: false, reason: 'none' };
    const def = EVENT_BY_ID[ev.id];
    if (choice !== 'accept' && choice !== 'decline') return { ok: false, reason: 'unknown' };
    const outcome = def[choice];
    if (choice === 'accept') {
      if (ev.price != null) {
        if (state.money < ev.price) return { ok: false, reason: 'poor' };
        state.money -= ev.price;
      }
      if (ev.cash) earn(state, ev.cash);
      if (ev.machineId) state.machines[ev.machineId] += 1;
    }
    state.event = null;
    if (outcome.duration) state.active = { id: def.id, side: choice, remaining: outcome.duration };
    return { ok: true, choice, event: ev, outcome, def };
  }

  // Credit time on each side of a transition at the rate in effect for that part of the interval.
  function tickEvents(state, seconds, rng = Math.random, {
    watching = true, allowSpawn = true, creditSegment = () => {},
  } = {}) {
    const notices = [];
    let left = seconds;
    function elapse(phase) {
      const duration = Math.min(left, phase.remaining);
      creditSegment(duration);
      // lastTick is measured in milliseconds. Keep matching precision across repeated 100ms frames.
      left = Math.round((left - duration) * 1000) / 1000;
      phase.remaining = Math.round((phase.remaining - duration) * 1000) / 1000;
    }
    if (state.event) {
      elapse(state.event);
      if (state.event.remaining <= 0) {
        const id = state.event.id;
        const result = watching ? respondToEvent(state, 'decline') : null;
        state.event = null;
        notices.push({ type: 'expired', id, away: !watching, result });
      }
    }
    if (state.active) {
      elapse(state.active);
      if (state.active.remaining <= 0) {
        notices.push({ type: 'ended', id: state.active.id, side: state.active.side, away: !watching });
        state.active = null;
      }
    }
    creditSegment(left);
    if (!watching) {
      state.nextEventIn = Math.max(state.nextEventIn, CONFIG.eventReturnGraceSeconds);
    } else if (allowSpawn && left > 0 && !state.event && !state.active) {
      state.nextEventIn = Math.max(0, state.nextEventIn - left);
      if (state.nextEventIn === 0 && machineCount(state) >= CONFIG.eventMinMachines) {
        const ev = startEvent(state, rng);
        if (ev) notices.push({ type: 'offer', event: ev });
      }
    }
    return notices;
  }

  // ---------------------------------------------------------------------------
  // Milestone: moving out
  // ---------------------------------------------------------------------------

  function moveProgress(state) {
    return Math.min(1, state.lifetime / CONFIG.moveGoal);
  }

  function canMove(state) {
    return state.location === 'basement' && state.lifetime >= CONFIG.moveGoal;
  }

  function moveTo(state, destination) {
    if (!canMove(state)) return { ok: false, reason: state.location === 'basement' ? 'poor' : 'moved' };
    if (destination === 'basement' || !LOCATIONS[destination]) return { ok: false, reason: 'unknown' };
    state.location = destination;
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Saving and loading (the page decides WHERE to store the text; this decides WHAT)
  // ---------------------------------------------------------------------------

  function serialize(state) {
    return JSON.stringify(state);
  }

  const nonNegative = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const count = (v) => Math.floor(nonNegative(v));

  function restoreIncident(raw, pending, state) {
    if (!raw || typeof raw.id !== 'string' || !Object.hasOwn(EVENT_BY_ID, raw.id)) return null;
    const def = EVENT_BY_ID[raw.id];
    const remaining = nonNegative(raw.remaining);
    if (remaining === 0) return null;
    if (!pending) {
      if (raw.side !== 'accept' && raw.side !== 'decline') return null;
      const duration = def[raw.side].duration;
      if (!duration || remaining > duration) return null;
      return { id: def.id, side: raw.side, remaining };
    }
    if (remaining > CONFIG.eventOfferSeconds) return null;
    const offer = { id: def.id, remaining };
    if (def.accept.cashSeconds) {
      if (!Number.isSafeInteger(raw.cash) || raw.cash < def.accept.minCash) return null;
      offer.cash = raw.cash;
    }
    if (def.accept.costSeconds) {
      if (!Number.isSafeInteger(raw.price) || raw.price < def.accept.minCost) return null;
      offer.price = raw.price;
    }
    if (def.accept.freeMachine) {
      if (typeof raw.machineId !== 'string' || !lookup('machine', raw.machineId) ||
          !(state.machines[raw.machineId] > 0)) return null;
      offer.machineId = raw.machineId;
    }
    return offer;
  }

  // Never trust saved text: a corrupt or hand-edited save falls back to safe values.
  function deserialize(text, now) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return newState(now);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return newState(now);

    const s = newState(now);
    s.money = nonNegative(raw.money);
    s.lifetime = Math.max(nonNegative(raw.lifetime), s.money);
    s.clicks = count(raw.clicks);
    const machines = raw.machines && typeof raw.machines === 'object' ? raw.machines : {};
    const coolers = raw.coolers && typeof raw.coolers === 'object' ? raw.coolers : {};
    for (const m of MACHINES) s.machines[m.id] = count(machines[m.id]);
    for (const c of COOLERS) s.coolers[c.id] = count(coolers[c.id]);
    if (Array.isArray(raw.upgrades)) {
      s.upgrades = [...new Set(raw.upgrades.filter((id) => typeof id === 'string' && UPGRADE_BY_ID[id]))];
    }
    if (typeof raw.location === 'string' && Object.prototype.hasOwnProperty.call(LOCATIONS, raw.location)) {
      s.location = raw.location;
    }
    if (raw.flags && typeof raw.flags === 'object') {
      for (const key of Object.keys(raw.flags)) if (raw.flags[key]) s.flags[key] = true;
    }
    if (Number.isFinite(raw.nextEventIn) && raw.nextEventIn >= 0) {
      s.nextEventIn = Math.min(raw.nextEventIn, CONFIG.eventGapMaxSeconds);
    }
    if (nonNegative(raw.startedAt) > 0) s.startedAt = raw.startedAt;
    if (Number.isFinite(raw.lastTick) && raw.lastTick >= 0) {
      s.lastTick = raw.lastTick;
      // Restore timers as of lastTick. Startup catch-up then credits any effect through its expiry.
      s.active = restoreIncident(raw.active, false, s);
      if (!s.active) s.event = restoreIncident(raw.event, true, s);
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Number formatting (kept here so it's tested alongside the math)
  // ---------------------------------------------------------------------------

  const SUFFIXES = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

  // mode 'floor' for money you have (never show more than you own), 'ceil' for prices.
  function formatMoney(n, mode) {
    const round = mode === 'ceil' ? Math.ceil : Math.floor;
    if (n < 10000) return '$' + round(n).toLocaleString('en-US');
    for (const [size, suffix] of SUFFIXES) {
      if (n >= size) return '$' + (round((n / size) * 100) / 100).toFixed(2) + suffix;
    }
    return '$' + round(n);
  }

  function formatRate(n) {
    if (n < 10) return '$' + n.toFixed(2) + '/s';
    if (n < 1000) return '$' + n.toFixed(1) + '/s';
    return formatMoney(n) + '/s';
  }

  function formatNumber(n) {
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1);
  }

  function formatDuration(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  const api = {
    CONFIG, MILESTONES, MACHINES, COOLERS, UPGRADES, LOCATIONS, EVENTS, SAVE_VERSION,
    lookup, newState, milestoneMult, nextMilestone, modifiers, stats,
    price, cost, ownedCount, meetsRequirements, isRevealed, revealPoint, nextReveal, canBuy, buy,
    bulkCost, maxAffordable, buyMany,
    click, advance, catchUp,
    machineCount, activeOutcome, startEvent, respondToEvent, tickEvents, clearIncidents,
    moveProgress, canMove, moveTo,
    serialize, deserialize,
    formatMoney, formatRate, formatNumber, formatDuration,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Economy = api;
})(typeof window !== 'undefined' ? window : globalThis);
