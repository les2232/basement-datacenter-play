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
    clickValue: 1,                    // base pay for a job, before adding the machine-income share
    jobIncomeShare: 0.02,             // fraction of one second of actual machine income paid per job
    baseCooling: 5,                   // the basement is cold; this much cooling is free
    moveGoal: 200000,                 // lifetime $ needed to unlock the move-out choice
    offlineCapSeconds: 2 * 60 * 60,   // base cap, before offline-power upgrades
    sysadminSpendShare: 0.5,          // fraction of cash the sysadmin may spend on a single cooler
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

  const POWER = { min: 0.5, max: 1.25, step: 0.05, normal: 1, heatExponent: 1.5, achievementSeconds: 60 };
  const PRESTIGE = { bonusPerStar: 0.10, divisor: 1e6, unlockLifetime: 1e7 };
  const GOALS = {
    slots: 3, swapSeconds: 600, minSizingSeconds: 120, sizingSeconds: 240, maxSizingSeconds: 360,
    sizingClicksPerSecond: 1, minimumEarnings: 2500, handJobs: 200,
    heatMin: 0.8, heatMax: 1, heatSeconds: 60, closeToMove: 0.75,
    firstBadge: 10, secondBadge: 100,
  };
  const GOAL_TEMPLATES = {
    machine: { rewardSeconds: 5 }, earnings: { rewardSeconds: 4 }, priority: { rewardSeconds: 45 },
    jobs: { rewardSeconds: 4 }, upgrade: { rewardSeconds: 12 }, incident: { rewardSeconds: 45 },
    heat: { rewardSeconds: 20 }, milestone: { rewardSeconds: 10 }, move: { rewardSeconds: 30 },
  };
  const AFTER_FIRST_SALE = 1, CLUSTER_FLEET_GOAL = 50;
  const MALL_EQUIPMENT_PRICE_MULT = 0.20;
  const AI_TRAINING_CLUSTER = { baseCost: 2000000, growth: 1.28, income: 8500, heat: 1200 };
  const MODEL_DISTILLATION = { cost: 80000000, clusterIncomeMult: 2 };
  const PERK_TIERS = [
    { stars: 3, options: [
      { id: 'starterKit', name: 'Starter Kit', icon: '🧰', effect: { laptops: 5, fans: 1, macros: true, cash: 2000 },
        get desc() { const { laptops, fans, macros, cash } = this.effect;
          return `Start each run with ${laptops} Old Laptops, ${fans} Box Fan${fans === 1 ? '' : 's'}${macros ? ', Keyboard Macros' : ''} and $${cash.toLocaleString('en-US')}.`; } },
      { id: 'seedFunding', name: 'Seed Funding', icon: '💵', effect: { cash: 5000 },
        get desc() { return `Start each run with $${this.effect.cash.toLocaleString('en-US')} to spend.`; } },
    ] },
    { stars: 6, options: [
      { id: 'familyBusiness', name: 'Family Business', icon: '🧒', effect: { sibling: 2 },
        get desc() { return `Little Sibling starts each run at level ${this.effect.sibling}.`; } },
      { id: 'itRetainer', name: 'IT on Retainer', icon: '🧑‍🔧', effect: { sysadmin: 1 },
        desc: 'Start each run with the Sysadmin already hired.' },
    ] },
    { stars: 12, options: [
      { id: 'bulkSupplier', name: 'Bulk Supplier', icon: '📦', effect: { machinePriceMult: 0.85 },
        get desc() { return `Pay ${Math.round((1 - this.effect.machinePriceMult) * 100)}% less for every machine.`; } },
      { id: 'industrialFans', name: 'Industrial Fans', icon: '🌬️', effect: { coolingMult: 1.5 },
        get desc() { return `Get ${Math.round((this.effect.coolingMult - 1) * 100)}% more cooling from all sources.`; } },
    ] },
    { stars: 24, options: [
      { id: 'vipClients', name: 'VIP Clients', icon: '🪪', effect: { bonusGapMult: 0.5 },
        get desc() { return `Priority requests appear ${1 / this.effect.bonusGapMult}× as often during live play.`; } },
      { id: 'overachiever', name: 'Overachiever', icon: '🏅', effect: { milestoneMult: 2.3 },
        get desc() { return `Each ownership milestone multiplies that machine’s income by ${this.effect.milestoneMult}.`; } },
    ] },
    { stars: 48, options: [
      { id: 'franchise', name: 'Franchise', icon: '🏢', effect: { bothLocations: true },
        desc: 'When you move out, choose one other available location’s bonus.' },
      { id: 'angelInvestors', name: 'Angel Investors', icon: '😇', effect: { bonusPerStar: 0.12 },
        get desc() { return `Each star adds ${Math.round(this.effect.bonusPerStar * 100)}% to income and job pay.`; } },
    ] },
  ];
  const perkIndex = new Map(PERK_TIERS.flatMap(tier => tier.options.map(option => [option.id, { tier, option }])));
  function perkEffect(state, id) {
    const { tier, option } = perkIndex.get(id);
    return state?.perks?.[tier.stars] === id ? option.effect : null;
  }
  const INVESTOR_STAR_GOAL = 10, ANGEL_STAR_GOAL = 50, FAST_RUN_MOVE_SECONDS = 2 * 60;

  const BONUS = {
    firstGapMinSeconds: 45, firstGapMaxSeconds: 90,
    gapMinSeconds: 240, gapMaxSeconds: 420, returnGraceSeconds: 30, durationSeconds: 10,
    minClickMultiple: 20,
    tiers: [
      { id: 'small', weight: 70, seconds: 90 },
      { id: 'big', weight: 25, seconds: 360 },
      { id: 'jackpot', weight: 5, seconds: 1440 },
    ],
  };
  const HEAT_BAND_MIN = 0.95, HEAT_BAND_SECONDS = 60;
  const TAP_BURST_COUNT = 50, TAP_BURST_MS = 10000, FAST_MOVE_SECONDS = 8 * 60;
  const LONG_ABSENCE_SECONDS = 2 * 60 * 60;

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
    { id: 'cluster', name: 'AI Training Cluster', icon: '🧠', ...AI_TRAINING_CLUSTER,
      requiresMove: true, minRuns: AFTER_FIRST_SALE, blurb: 'A wall of processors that keeps the whole building warm.' },
  ];

  const COOLERS = [
    { id: 'fan', name: 'Box Fan', icon: '🌀', baseCost: 25, growth: 1.2, cooling: 4,
      blurb: 'Point it at the problem.' },
    { id: 'ac', name: 'Window AC', icon: '❄️', baseCost: 600, growth: 1.2, cooling: 25,
      blurb: 'The basement window is tiny. It fits. Barely.' },
    { id: 'liquid', name: 'Liquid Loop', icon: '💧', baseCost: 8000, growth: 1.2, cooling: 120,
      blurb: 'Tubes everywhere. What could possibly go wrong?' },
  ];

  // Multipliers stack; the highest offlineCapSeconds upgrade sets the offline limit.
  const UPGRADES = [
    { id: 'macros', name: 'Keyboard Macros', icon: '⌨️', cost: 50,
      effect: { clickMult: 2 }, desc: 'Doubles the base pay for manual and sibling jobs.' },
    { id: 'paste', name: 'Fresh Thermal Paste', icon: '🧴', cost: 250, requires: { laptop: 1 },
      effect: { machineMult: { laptop: 2 } }, desc: 'Laptops earn 2×.' },
    { id: 'ssd', name: 'SSD Swap', icon: '💾', cost: 1000, requires: { tower: 1 },
      effect: { machineMult: { tower: 2 } }, desc: 'Towers earn 2×.' },
    { id: 'cables', name: 'Cable Management', icon: '🧶', cost: 1500,
      effect: { coolingMult: 1.25 }, desc: 'All cooling +25% (airflow, baby).' },
    { id: 'overclock', name: 'Overclock Everything', icon: '⚡', cost: 5000,
      // Heat must rise MORE than income, or this can never hurt (while overheating, equal
      // multipliers cancel out exactly). With 2× heat it pays off only if you have spare cooling.
      effect: { incomeMult: 1.5, heatMult: 2 }, desc: 'Machine income 1.5×, but all heat 2×. Only worth it with spare cooling.' },
    { id: 'serveros', name: 'Server OS', icon: '🐧', cost: 10000, requires: { rack: 1 },
      effect: { machineMult: { rack: 2 } }, desc: 'Racks earn 2×.' },
    { id: 'ups', name: 'UPS Battery Backup', icon: '🔋', cost: 40000,
      effect: { offlineCapSeconds: 4 * 3600 }, desc: 'Earn up to 4 hours of income while away.' },
    { id: 'solar', name: 'Solar Panels on the Roof', icon: '☀️', cost: 1000000, requiresUpgrade: 'ups',
      effect: { offlineCapSeconds: 8 * 3600 }, desc: 'Earn up to 8 hours of income while away. Requires UPS Battery Backup.' },
    { id: 'distillation', name: 'Model Distillation', icon: '⚗️', cost: MODEL_DISTILLATION.cost, requires: { cluster: 1 },
      effect: { machineMult: { cluster: MODEL_DISTILLATION.clusterIncomeMult } },
      get desc() { return `AI Training Clusters earn ${this.effect.machineMult.cluster}×.`; } },
  ];

  const STAFF = [
    { id: 'sibling', name: 'Little Sibling', icon: '🧒', prices: [260, 1000, 3500, 12000, 40000],
      jobsPerSecond: [1, 2, 4, 7, 12], blurb: 'Runs jobs for the going click rate. Takes payment in snacks.' },
    { id: 'sysadmin', name: 'Sysadmin', icon: '🧑‍🔧', prices: [60000],
      blurb: 'Buys the best-value cooling when the room overheats during live play.' },
  ];

  const LOCATIONS = {
    basement: { name: "Parents' Basement", room: 'The Basement', effect: {} },
    warehouse: { name: 'Arctic Warehouse', room: 'The Warehouse', icon: '🧊', effect: { coolingMult: 3 },
      desc: 'Cooling ×3. Room to pack in machines without melting anything.' },
    office: { name: 'Downtown Office', room: 'The Office', icon: '🏙️', effect: { incomeMult: 1.5, clickMult: 5, jobShareMult: 2 },
      desc: 'Machine income ×1.5. Jobs pay 5× the base plus double the usual share of machine income.' },
    mall: { name: 'Dead Mall', room: 'The Mall', icon: '🏬', minRuns: AFTER_FIRST_SALE, effect: { priceMult: MALL_EQUIPMENT_PRICE_MULT },
      get desc() { return `Cheap rent in an abandoned shopping mall. Machines and coolers cost ${Math.round((1 - this.effect.priceMult) * 100)}% less.`; } },
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
      accept: { label: 'Take the job', duration: 45, effect: { incomeMult: 2, heatMult: 2.5 }, summary: 'machine income ×2, heat ×2.5' },
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
  const STAFF_BY_ID = byId(STAFF);
  const EVENT_BY_ID = byId(EVENTS);
  const TABLES = { machine: MACHINE_BY_ID, cooler: COOLER_BY_ID, upgrade: UPGRADE_BY_ID, staff: STAFF_BY_ID };
  const SHOP_ITEMS = Object.entries(TABLES).flatMap(([kind, table]) =>
    Object.values(table).map(def => ({ kind, id: def.id })));
  const COOLING_STEPS_PER_MACHINE = 20;

  function lookup(kind, id) {
    const table = TABLES[kind];
    return table && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
  }

  function zeroCounts(list) {
    const out = {};
    for (const item of list) out[item.id] = 0;
    return out;
  }

  function newCounters() {
    return {
      goalsClaimed: 0,
      machinesBought: 0, coolersBought: 0, siblingJobs: 0, sysadminPurchases: 0,
      incidentsAccepted: 0, incidentsDeclined: 0,
      heatWavesSurvived: 0, bonusesCaught: 0, bonusesMissed: 0, bonusCashEarned: 0,
      liveSeconds: 0, highestIncome: 0, timeToMove: 0, jackpotsCaught: 0,
      moveTimeRecorded: 0, everOverheated: 0,
      longestHeatStreakSeconds: 0, longestMaxPowerSeconds: 0, bestTapBurst: 0, longestAbsenceSeconds: 0,
    };
  }

  // These streaks require uninterrupted play. Only their best results survive a reload.
  const LIVE_SESSION = Symbol('live session');
  function liveSession(state) {
    if (!state[LIVE_SESSION]) {
      Object.defineProperty(state, LIVE_SESSION, { value: { taps: [], heatSeconds: 0, powerSeconds: 0 } });
    }
    return state[LIVE_SESSION];
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function newState(now) {
    return {
      version: SAVE_VERSION, power: POWER.normal,
      money: 0,          // spendable cash
      lifetime: 0,       // earnings in this run, used for shop reveals and moving out
      stars: 0, runs: 0, allTimeEarnings: 0, runStartedAt: now,
      perks: {}, perkChoicePending: false, runBestIncome: 0, runStartingCash: 0,
      records: { fastestMoveSeconds: null, bestRunEarnings: 0 },
      clicks: 0,
      counters: newCounters(),
      achievements: [],
      machines: zeroCounts(MACHINES),
      coolers: zeroCounts(COOLERS),
      staff: { sibling: 0, sysadmin: 0, sysadminEnabled: true },
      upgrades: [],
      location: 'basement',
      extraLocation: null,  // a Franchise bonus; only the physical location counts as the move
      flags: {},         // one-time story messages already shown
      event: null,       // incident waiting for an answer: { id, remaining, cash?, price?, machineId? }
      active: null,      // temporary effect running: { id, side: 'accept' | 'decline', remaining }
      nextEventIn: CONFIG.firstEventSeconds,
      startedAt: now,
      lastTick: now,     // last moment production was credited (used for offline progress)
    };
  }

  function milestoneMult(count, state) {
    let multiplier = 1;
    const upgrade = perkEffect(state, 'overachiever');
    for (const tier of MILESTONES) {
      if (count < tier.count) break;
      multiplier *= upgrade?.milestoneMult ?? tier.mult;
    }
    return multiplier;
  }

  function nextMilestone(count) {
    return MILESTONES.find((tier) => tier.count > count) || null;
  }

  function offlineCapSeconds(state) {
    let cap = CONFIG.offlineCapSeconds;
    for (const id of state.upgrades) cap = Math.max(cap, UPGRADE_BY_ID[id].effect.offlineCapSeconds || 0);
    return cap;
  }

  function moveDestinations(state) {
    return Object.keys(LOCATIONS).filter(id => id !== 'basement' && state.runs >= (LOCATIONS[id].minRuns || 0));
  }

  function franchiseChoices(state, physical) {
    if (!perkEffect(state, 'franchise')?.bothLocations) return [];
    const available = moveDestinations(state);
    return available.includes(physical) ? available.filter(id => id !== physical) : [];
  }

  function extraLocationEffect(state) {
    if (!state?.extraLocation || state.location === 'basement' || state.location === state.extraLocation ||
        !perkEffect(state, 'franchise')?.bothLocations) return null;
    return LOCATIONS[state.extraLocation]?.effect;
  }

  function locationPriceMult(state) {
    return state ? (LOCATIONS[state.location].effect.priceMult ?? 1) * (extraLocationEffect(state)?.priceMult ?? 1) : 1;
  }

  // Combine ownership milestones, purchased upgrades, location and any active incident.
  function modifiers(state) {
    const mod = { clickMult: 1, jobShareMult: 1, incomeMult: 1, heatMult: 1, coolingMult: 1, priceMult: 1, machineMult: {} };
    for (const m of MACHINES) mod.machineMult[m.id] = milestoneMult(state.machines[m.id] || 0, state);
    const effects = state.upgrades.map((id) => UPGRADE_BY_ID[id]).filter(Boolean).map((u) => u.effect);
    effects.push(LOCATIONS[state.location].effect);
    const extra = extraLocationEffect(state);
    if (extra) effects.push(extra);
    const cooling = perkEffect(state, 'industrialFans');
    if (cooling) effects.push(cooling);
    if (state.stars) {
      const reputation = reputationMultiplier(state);
      // The machine-derived part of each job already receives this through machine income.
      effects.push({ incomeMult: reputation, clickMult: reputation });
    }
    const temp = activeOutcome(state);
    if (temp && temp.effect) effects.push(temp.effect);
    for (const e of effects) {
      for (const key of ['clickMult', 'jobShareMult', 'incomeMult', 'heatMult', 'coolingMult', 'priceMult']) {
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
  function stats(state, mod = modifiers(state)) {
    const incomePerUnit = {};
    const heatPerUnit = {};
    const coolingPerUnit = {};
    let rawMachineIncome = 0;
    let heatAtNormalPower = 0;
    const power = state.power === POWER.normal || !hasPowerHistory(state) ? POWER.normal : normalizedPower(state.power);
    const powerHeatMult = power ** POWER.heatExponent;

    for (const m of MACHINES) {
      const n = state.machines[m.id] || 0;
      incomePerUnit[m.id] = m.income * (mod.machineMult[m.id] || 1) * mod.incomeMult * power;
      const unitHeat = m.heat * mod.heatMult;
      heatPerUnit[m.id] = unitHeat * powerHeatMult;
      rawMachineIncome += n * incomePerUnit[m.id];
      heatAtNormalPower += n * unitHeat;
    }

    const cooling = baseCoolingCapacity(state) * mod.coolingMult;
    for (const c of COOLERS) coolingPerUnit[c.id] = c.cooling * mod.coolingMult;

    const heat = heatAtNormalPower * powerHeatMult;
    const load = heat / cooling;
    const throttle = load > 1 ? 1 / load : 1;
    const machineIncome = rawMachineIncome * throttle;
    const baseJobPay = CONFIG.clickValue * mod.clickMult;
    const jobShare = CONFIG.jobIncomeShare * mod.jobShareMult;
    const clickValue = baseJobPay + machineIncome * jobShare;
    const siblingJobsPerSecond = STAFF_BY_ID.sibling.jobsPerSecond[state.staff.sibling - 1] || 0;
    const staffIncome = siblingJobsPerSecond * clickValue;

    return {
      income: machineIncome + staffIncome,
      rawIncome: rawMachineIncome + siblingJobsPerSecond * (baseJobPay + rawMachineIncome * jobShare),
      machineIncome, staffIncome, siblingJobsPerSecond, offlineCapSeconds: offlineCapSeconds(state),
      heat, heatAtNormalPower, power, powerHeatMult,
      cooling,
      load,                           // 1 = exactly at capacity
      throttle,                       // 1 = full speed, 0.5 = half speed
      clickValue,
      incomePerUnit,
      heatPerUnit,
      coolingPerUnit,
    };
  }

  function hasPowerHistory(state) {
    return state.counters.everOverheated === 1 || state.flags.firstHot === true || state.achievements.includes('overheat');
  }

  function powerUnlocked(state, st) {
    return hasPowerHistory(state) || (st ?? stats(state)).throttle < 1;
  }

  const boundPower = value => Math.min(POWER.max, Math.max(POWER.min, value));
  function normalizedPower(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return POWER.normal;
    const stepsPerUnit = 1 / POWER.step;
    return boundPower(Math.round((boundPower(value) + Number.EPSILON) * stepsPerUnit) / stepsPerUnit);
  }

  function setPower(state, value) {
    const unlocked = !state.perkChoicePending && powerUnlocked(state);
    if (unlocked && !hasPowerHistory(state)) state.counters.everOverheated = 1;
    const applied = unlocked ? normalizedPower(value) : POWER.normal;
    if (state.power !== applied) {
      state.power = applied;
      recordRates(state, stats(state));
    }
    return applied;
  }

  function powerSweetSpot(state, st = stats(state)) {
    return st.heatAtNormalPower > 0 ? boundPower((st.cooling / st.heatAtNormalPower) ** (1 / POWER.heatExponent)) : POWER.max;
  }

  function bestPower(state, st = stats(state)) {
    if (state.perkChoicePending || !powerUnlocked(state, st)) return POWER.normal;
    const ideal = powerSweetSpot(state, st);
    const stepsPerUnit = 1 / POWER.step;
    const lower = boundPower(Math.floor(ideal * stepsPerUnit) / stepsPerUnit);
    const upper = boundPower(Math.ceil(ideal * stepsPerUnit) / stepsPerUnit);
    // On either side of full load the income curve is monotone. Compare the
    // two neighboring settings because the steeper hot side need not win a nearest-step tie.
    const output = p => p / Math.max(1, st.heatAtNormalPower * p ** POWER.heatExponent / st.cooling);
    return output(upper) > output(lower) ? upper : lower;
  }

  function baseCoolingCapacity(state) {
    let capacity = CONFIG.baseCooling;
    for (const c of COOLERS) capacity += (state.coolers[c.id] || 0) * c.cooling;
    return capacity;
  }

  const inHeatBand = st => st.load >= HEAT_BAND_MIN && st.throttle === 1;
  const atMaxPower = st => st.power === POWER.max && st.heatAtNormalPower > 0 && st.throttle === 1;
  function advancePowerStreak(state, st, seconds) {
    if (state.counters.longestMaxPowerSeconds >= POWER.achievementSeconds) return;
    if (!st || !atMaxPower(st) || !hasPowerHistory(state)) {
      if (state[LIVE_SESSION]) state[LIVE_SESSION].powerSeconds = 0;
      return;
    }
    const session = liveSession(state);
    session.powerSeconds = Math.min(POWER.achievementSeconds, Math.round((session.powerSeconds + seconds) * 1000) / 1000);
    state.counters.longestMaxPowerSeconds = Math.max(state.counters.longestMaxPowerSeconds, session.powerSeconds);
  }
  function recordRates(state, st) {
    state.runBestIncome = Math.max(state.runBestIncome, st.income);
    state.counters.highestIncome = Math.max(state.counters.highestIncome, st.income);
    if (st.throttle < 1) state.counters.everOverheated = 1;
    if (state[LIVE_SESSION] && !inHeatBand(st)) state[LIVE_SESSION].heatSeconds = 0;
    if (state[LIVE_SESSION] && !atMaxPower(st)) state[LIVE_SESSION].powerSeconds = 0;
    if (state.goals && (st.load < GOALS.heatMin || st.load > GOALS.heatMax)) updateGoalHeat(state, null, 0);
  }

  function recordPurchase(state, kind, n) {
    if (kind === 'machine') state.counters.machinesBought += n;
    if (kind === 'cooler') state.counters.coolersBought += n;
    recordRates(state, stats(state));
  }

  // ---------------------------------------------------------------------------
  // Prices and purchases
  // ---------------------------------------------------------------------------

  // Price of the next one when you already own `owned` of them. Always a whole dollar.
  function price(def, owned, state) {
    const discount = MACHINE_BY_ID[def.id] ? perkEffect(state, 'bulkSupplier')?.machinePriceMult ?? 1 : 1;
    return Math.ceil(def.baseCost * Math.pow(def.growth, owned) * discount * locationPriceMult(state) - 1e-9);
  }

  function ownedCount(state, kind, id) {
    if (kind === 'machine') return state.machines[id] || 0;
    if (kind === 'cooler') return state.coolers[id] || 0;
    if (kind === 'upgrade') return state.upgrades.includes(id) ? 1 : 0;
    if (kind === 'staff') return state.staff[id] || 0;
    return 0;
  }

  function cost(state, kind, id) {
    const def = lookup(kind, id);
    if (!def) return Infinity;
    if (kind === 'staff') return def.prices[ownedCount(state, kind, id)] ?? Infinity;
    return kind === 'upgrade' ? def.cost : price(def, ownedCount(state, kind, id), state);
  }

  // Requirements other than money: having moved out, owning a prerequisite machine.
  function meetsRequirements(state, def) {
    if (def.minRuns && state.runs < def.minRuns) return false;
    if (def.requiresMove && state.location === 'basement') return false;
    if (def.requiresUpgrade && !state.upgrades.includes(def.requiresUpgrade)) return false;
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
    return state.lifetime >= revealPoint(kind, id, state);
  }

  function revealPoint(kind, id, state) {
    const def = lookup(kind, id);
    if (!def) return Infinity;
    if (def.revealAt != null) return def.revealAt;
    // Preserve the original reveal schedule outside the Mall. Its equipment offers
    // reveal at half the discounted, rounded first price, including any supplier deal.
    const base = def.baseCost != null && locationPriceMult(state) !== 1
      ? price(def, 0, state) : def.baseCost ?? def.cost ?? def.prices[0];
    return base * CONFIG.revealFraction;
  }

  function nextReveal(state) {
    let next = null;
    for (const [kind, table] of Object.entries(TABLES)) {
      for (const def of Object.values(table)) {
        if (!meetsRequirements(state, def) || isRevealed(state, kind, def.id)) continue;
        const at = revealPoint(kind, def.id, state);
        if (!next || at < next.at) next = { kind, id: def.id, at };
      }
    }
    return next;
  }

  function canBuy(state, kind, id) {
    if (state.perkChoicePending) return false;
    const def = lookup(kind, id);
    if (!def) return false;
    if (kind === 'upgrade' && state.upgrades.includes(id)) return false;
    if (kind === 'staff' && ownedCount(state, kind, id) >= def.prices.length) return false;
    return meetsRequirements(state, def) && state.money >= cost(state, kind, id);
  }

  // Returns { ok: true, cost } or { ok: false, reason: 'unknown' | 'owned' | 'locked' | 'poor' }.
  function buy(state, kind, id) {
    if (state.perkChoicePending) return { ok: false, reason: 'perk-choice' };
    const def = lookup(kind, id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (kind === 'upgrade' && state.upgrades.includes(id)) return { ok: false, reason: 'owned' };
    if (kind === 'staff' && ownedCount(state, kind, id) >= def.prices.length) return { ok: false, reason: 'owned' };
    if (!meetsRequirements(state, def)) return { ok: false, reason: 'locked' };
    const c = cost(state, kind, id);
    if (state.money < c) return { ok: false, reason: 'poor' };

    state.money -= c;
    addToInventory(state, kind, id, 1);
    recordPurchase(state, kind, 1);
    return { ok: true, cost: c };
  }

  // Total price of the next `n` machines/coolers (each one priced as if bought one at a time).
  function bulkCost(state, kind, id, n) {
    const def = lookup(kind, id);
    if (!def) return Infinity;
    if (kind === 'upgrade' || kind === 'staff') return n === 1 ? cost(state, kind, id) : Infinity;
    const owned = ownedCount(state, kind, id);
    let total = 0;
    for (let i = 0; i < n; i++) total += price(def, owned + i, state);
    return total;
  }

  // How many you could buy right now with the money you have.
  function maxAffordable(state, kind, id) {
    if (state.perkChoicePending) return 0;
    const def = lookup(kind, id);
    if (!def || kind === 'upgrade' || kind === 'staff' || !meetsRequirements(state, def)) return 0;
    const owned = ownedCount(state, kind, id);
    let total = 0;
    let n = 0;
    while (n < CONFIG.maxBulkBuy) {
      const next = price(def, owned + n, state);
      if (total + next > state.money) break;
      total += next;
      n += 1;
    }
    return n;
  }

  // Buy exactly `n` (all or nothing). Same result as calling buy() n times.
  function buyMany(state, kind, id, n) {
    if (state.perkChoicePending) return { ok: false, reason: 'perk-choice' };
    if (kind === 'staff' && n !== 1) return { ok: false, reason: 'unknown' };
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
    addToInventory(state, kind, id, n);
    recordPurchase(state, kind, n);
    return { ok: true, cost: c, count: n };
  }

  function cheapestCoolerFor(state, st = stats(state)) {
    let selected = null;
    let lowest = Infinity;
    for (const cooler of COOLERS) {
      if (!isRevealed(state, 'cooler', cooler.id)) continue;
      const perUnit = cost(state, 'cooler', cooler.id) / st.coolingPerUnit[cooler.id];
      if (perUnit < lowest) {
        selected = cooler.id;
        lowest = perUnit;
      }
    }
    return selected;
  }

  function addToInventory(state, kind, id, count) {
    if (kind === 'machine') state.machines[id] += count;
    else if (kind === 'cooler') state.coolers[id] += count;
    else if (kind === 'staff') state.staff[id] += count;
    else state.upgrades.push(id);
  }

  function availableForAdvice(state, kind, id) {
    const def = lookup(kind, id);
    if (!def || state.perkChoicePending || !isRevealed(state, kind, id) || !meetsRequirements(state, def)) return false;
    if (kind === 'upgrade') return !state.upgrades.includes(id);
    return kind !== 'staff' || ownedCount(state, kind, id) < def.prices.length;
  }

  function earningRate(st, cps) {
    return st.income + st.clickValue * cps;
  }

  function secondsToAfford(price, cash, income) {
    if (cash >= price) return 0;
    return income > 0 ? (price - cash) / income : null;
  }

  // Price and production from an inventory-only preview. Records, timers and
  // state shared with the real game are read-only throughout this calculation.
  function quoteAvailable(state, kind, id, count, cps, current) {
    const trial = { ...state };
    if (kind === 'machine') trial.machines = { ...state.machines };
    if (kind === 'machine' || kind === 'cooler') trial.coolers = { ...state.coolers };
    if (kind === 'staff') trial.staff = { ...state.staff };
    if (kind === 'upgrade') trial.upgrades = [...state.upgrades];
    const itemCost = bulkCost(state, kind, id, count);
    const steps = Array.from({ length: count }, () => ({ kind, id }));
    let total = itemCost;
    addToInventory(trial, kind, id, count);
    const mod = modifiers(trial);
    let projected = stats(trial, mod);
    if (kind === 'machine' && projected.load > 1) {
      // Only capacity changes as cooling is added; keep the heat, modifiers and
      // per-cooler capacities for the whole bundle, including large Max quotes.
      let capacity = baseCoolingCapacity(trial);
      for (let i = 0; projected.heat / (capacity * mod.coolingMult) > 1 && i < COOLING_STEPS_PER_MACHINE * count; i++) {
        const cooler = cheapestCoolerFor(trial, projected);
        if (!cooler) break;
        total += cost(trial, 'cooler', cooler);
        addToInventory(trial, 'cooler', cooler, 1);
        capacity += COOLER_BY_ID[cooler].cooling;
        steps.push({ kind: 'cooler', id: cooler });
      }
      projected = stats(trial, mod);
    }
    const gain = earningRate(projected, cps) - earningRate(current, cps);
    return { kind, id, count, itemCost, cost: total, gain, steps,
      paybackSeconds: gain > 1e-9 ? total / gain : null,
      affordableSeconds: secondsToAfford(itemCost, state.money, current.income) };
  }

  function purchaseQuote(state, kind, id, count = 1, clicksPerSecond = 0) {
    if (!Number.isInteger(count) || count < 1 || count > CONFIG.maxBulkBuy ||
        ((kind === 'upgrade' || kind === 'staff') && count !== 1) || !availableForAdvice(state, kind, id)) return null;
    const cps = nonNegative(clicksPerSecond);
    return quoteAvailable(state, kind, id, count, cps, stats(state));
  }

  // The simulator and shop rank a single purchase by its time to afford plus time to pay back.
  function bestBuy(state, clicksPerSecond = 0) {
    const cps = nonNegative(clicksPerSecond);
    const current = stats(state);
    const base = earningRate(current, cps);
    let best = null;
    let bestScore = Infinity;
    for (const { kind, id } of SHOP_ITEMS) {
      if (!availableForAdvice(state, kind, id)) continue;
      // The original bot hires the Sysadmin once affordable, without saving up for it.
      if (kind === 'staff' && id === 'sysadmin') {
        const price = cost(state, kind, id);
        if (price <= state.money) return { kind, id, cost: price, gain: 0, paybackSeconds: null, steps: [{ kind, id }] };
        continue;
      }
      const quote = quoteAvailable(state, kind, id, 1, cps, current);
      if (quote.paybackSeconds === null) continue;
      const score = Math.max(0, (quote.cost - state.money) / Math.max(base, 0.01)) + quote.paybackSeconds;
      if (!best || score < bestScore) {
        const { cost, gain, paybackSeconds, steps } = quote;
        best = { kind, id, cost, gain, paybackSeconds, steps };
        bestScore = score;
      }
    }
    return best;
  }

  // The welcome screen commits the exact bundle the player saw. Reprice it before
  // touching inventory, in case cooling requirements or a shop price changed.
  function buyRecommendation(state, plan) {
    if (!plan || !Array.isArray(plan.steps)) return { ok: false };
    const quote = purchaseQuote(state, plan.kind, plan.id);
    if (!quote || quote.cost !== plan.cost || state.money < quote.cost ||
        quote.steps.length !== plan.steps.length || !quote.steps.every((step, i) =>
          step.kind === plan.steps[i]?.kind && step.id === plan.steps[i]?.id)) return { ok: false };
    const purchases = quote.steps.map(({ kind, id }) => ({ kind, id, ...buy(state, kind, id) }));
    return { ok: true, cost: quote.cost, purchases };
  }

  // Live game ticks and the simulator call this after crediting production. Offline catch-up never calls it.
  function runSysadmin(state) {
    if (!state.staff.sysadmin || !state.staff.sysadminEnabled) return [];
    const counts = {};
    let st = stats(state);
    while (st.load > 1) {
      const id = cheapestCoolerFor(state, st);
      if (!id || cost(state, 'cooler', id) > state.money * CONFIG.sysadminSpendShare) break;
      if (!buy(state, 'cooler', id).ok) break;
      counts[id] = (counts[id] || 0) + 1;
      state.counters.sysadminPurchases += 1;
      st = stats(state);
    }
    return Object.entries(counts).map(([id, count]) => ({ id, count }));
  }

  // ---------------------------------------------------------------------------
  // Earning
  // ---------------------------------------------------------------------------

  function earn(state, amount) {
    if (state.perkChoicePending || !Number.isFinite(amount) || amount <= 0) return 0;
    state.money += amount;
    state.lifetime += amount;
    state.allTimeEarnings += amount;
    state.records.bestRunEarnings = Math.max(state.records.bestRunEarnings, state.lifetime);
    return amount;
  }

  // The base is paid by hand; the additional share follows the machines' current output.
  function click(state, now = state.lastTick) {
    if (state.perkChoicePending) return 0;
    const value = stats(state).clickValue;
    earn(state, value);
    state.clicks += 1;
    if (state.counters.bestTapBurst < TAP_BURST_COUNT && Number.isFinite(now)) {
      const taps = liveSession(state).taps;
      if (taps.length) {
        const lastTap = taps[taps.length - 1];
        // An input can arrive before the first timer callback following a suspension.
        const sinceActivity = now - Math.max(lastTap, state.lastTick);
        if (now < lastTap || sinceActivity > CONFIG.eventLiveGapSeconds * 1000) taps.length = 0;
      }
      while (taps.length && now - taps[0] > TAP_BURST_MS) taps.shift();
      taps.push(now);
      state.counters.bestTapBurst = Math.max(state.counters.bestTapBurst, taps.length);
    }
    return value;
  }

  function nextBonusGap(state, rng = Math.random) {
    const seen = state.flags.firstPriorityRequestSeen;
    const min = seen ? BONUS.gapMinSeconds : BONUS.firstGapMinSeconds;
    const max = seen ? BONUS.gapMaxSeconds : BONUS.firstGapMaxSeconds;
    return (min + rng() * (max - min)) * (perkEffect(state, 'vipClients')?.bonusGapMult ?? 1);
  }

  function markBonusAppeared(state) {
    if (!state.perkChoicePending) state.flags.firstPriorityRequestSeen = true;
  }

  function rollBonusReward(state, st = stats(state), rng = Math.random) {
    let draw = rng() * BONUS.tiers.reduce((total, tier) => total + tier.weight, 0);
    let selected = BONUS.tiers[BONUS.tiers.length - 1];
    for (const tier of BONUS.tiers) {
      draw -= tier.weight;
      if (draw < 0) { selected = tier; break; }
    }
    const amount = Math.max(Math.round(st.income * selected.seconds), Math.ceil(st.clickValue * BONUS.minClickMultiple));
    return { tier: selected.id, amount };
  }

  function claimBonus(state, rng = Math.random) {
    if (state.perkChoicePending) return null;
    const reward = rollBonusReward(state, stats(state), rng);
    earn(state, reward.amount);
    state.counters.bonusesCaught += 1;
    state.counters.bonusCashEarned += reward.amount;
    if (reward.tier === 'jackpot') state.counters.jackpotsCaught += 1;
    return reward;
  }

  function missBonus(state) {
    if (!state.perkChoicePending) state.counters.bonusesMissed += 1;
  }

  function creditProduction(state, rates, seconds) {
    const amount = rates.income * seconds;
    earn(state, amount);
    if (rates.siblingJobsPerSecond) {
      const jobs = state.counters.siblingJobs + rates.siblingJobsPerSecond * seconds;
      // Ten 0.1-second ticks complete a job. Discard floating-point error at whole-job boundaries.
      const whole = Math.round(jobs);
      state.counters.siblingJobs = Math.abs(jobs - whole) <= Number.EPSILON * jobs * 4 ? whole : jobs;
    }
    return amount;
  }

  // Run the machines and staff for `seconds`. Income is constant between purchases.
  function advance(state, seconds, { live = false } = {}) {
    if (state.perkChoicePending || !(seconds > 0)) return 0;
    const st = stats(state);
    recordRates(state, st);
    const liveRates = live && seconds <= CONFIG.eventLiveGapSeconds ? st : null;
    advancePowerStreak(state, liveRates, seconds);
    if (state.goals) updateGoalHeat(state, liveRates, seconds);
    return creditProduction(state, st, seconds);
  }

  /*
   * Credit production for the time since lastTick, then move lastTick to now.
   * Used every frame while playing AND when the page reopens (offline progress).
   * Long gaps are capped by the installed backup power. A clock that went backwards credits nothing.
   *
   * Existing offers and effects age in real time. Only short, visible intervals can start offers
   * or apply an ignored heat wave. A modal can veto a new offer with allowSpawn: false.
   */
  function catchUp(state, now, { live = true, allowSpawn = true, countLive = live, rng = Math.random } = {}) {
    if (state.perkChoicePending) {
      state.lastTick = now;
      return { seconds: 0, credited: 0, earned: 0, siblingJobs: 0, capped: false, offlineCapSeconds: offlineCapSeconds(state), throttle: 1, notices: [] };
    }
    const seconds = Math.max(0, (now - state.lastTick) / 1000);
    const watching = live && seconds <= CONFIG.eventLiveGapSeconds;
    const playing = watching && countLive && now >= state.lastTick;
    if (!playing && state.goals) updateGoalHeat(state, null, 0);
    if (playing) {
      state.counters.liveSeconds += seconds;
    } else if (state[LIVE_SESSION]) {
      state[LIVE_SESSION].taps.length = 0;
      state[LIVE_SESSION].heatSeconds = 0;
      state[LIVE_SESSION].powerSeconds = 0;
    }
    if (!watching) state.counters.longestAbsenceSeconds = Math.max(state.counters.longestAbsenceSeconds, seconds);
    const priorJobs = Math.floor(state.counters.siblingJobs);
    const cap = offlineCapSeconds(state);
    const credited = Math.min(seconds, cap);
    let creditLeft = credited;
    let earned = 0;
    let throttleSeconds = 0;
    function creditSegment(duration) {
      const paid = Math.min(creditLeft, duration);
      if (paid <= 0) return;
      const rates = stats(state);
      recordRates(state, rates);
      if (playing) advancePowerStreak(state, rates, paid);
      if (playing && state.goals) updateGoalHeat(state, rates, paid);
      if (playing && inHeatBand(rates)) {
        const session = liveSession(state);
        session.heatSeconds = Math.round((session.heatSeconds + paid) * 1000) / 1000;
        state.counters.longestHeatStreakSeconds = Math.max(state.counters.longestHeatStreakSeconds, session.heatSeconds);
      }
      earned += creditProduction(state, rates, paid);
      throttleSeconds += rates.throttle * paid;
      creditLeft -= paid;
    }
    const notices = tickEvents(state, seconds, rng, { watching, allowSpawn, creditSegment });
    if (!credited || notices.length) recordRates(state, stats(state));
    const throttle = credited > 0 ? throttleSeconds / credited : stats(state).throttle;
    state.lastTick = now;
    const siblingJobs = Math.floor(state.counters.siblingJobs) - priorJobs;
    return { seconds, credited, earned, siblingJobs, capped: seconds > cap, offlineCapSeconds: cap, throttle, notices };
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
    if (state.perkChoicePending) return null;
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
    if (choice === 'accept') state.counters.incidentsAccepted += 1;
    else state.counters.incidentsDeclined += 1;
    state.event = null;
    if (outcome.duration) state.active = { id: def.id, side: choice, remaining: outcome.duration };
    recordRates(state, stats(state));
    return { ok: true, choice, event: ev, outcome, def };
  }

  // Credit time on each side of a transition at the rate in effect for that part of the interval.
  function tickEvents(state, seconds, rng = Math.random, {
    watching = true, allowSpawn = true, creditSegment = () => {},
  } = {}) {
    if (state.perkChoicePending) return [];
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
        if (!watching) state.counters.incidentsDeclined += 1;
        state.event = null;
        notices.push({ type: 'expired', id, away: !watching, result });
      }
    }
    if (state.active) {
      elapse(state.active);
      if (state.active.remaining <= 0) {
        if (state.active.id === 'heatwave' && state.active.side === 'decline') state.counters.heatWavesSurvived += 1;
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
    return !state.perkChoicePending && state.location === 'basement' && state.lifetime >= CONFIG.moveGoal;
  }

  function moveTo(state, destination, now = state.lastTick, extra = null) {
    if (!canMove(state)) return { ok: false, reason: state.location === 'basement' ? 'poor' : 'moved' };
    if (!moveDestinations(state).includes(destination)) return { ok: false, reason: 'unknown' };
    const choices = franchiseChoices(state, destination);
    if (choices.length ? !choices.includes(extra) : extra !== null) return { ok: false, reason: 'extra-location' };
    state.location = destination;
    state.extraLocation = extra;
    if (destination === 'mall') state.flags.movedToMall = true;
    if (Number.isFinite(now) && Number.isFinite(state.runStartedAt) && now >= state.runStartedAt) {
      state.counters.timeToMove = (now - state.runStartedAt) / 1000;
      state.counters.moveTimeRecorded = 1;
      state.records.fastestMoveSeconds = Math.min(state.records.fastestMoveSeconds ?? Infinity, state.counters.timeToMove);
    } else {
      state.counters.timeToMove = 0;
      state.counters.moveTimeRecorded = 0;
    }
    recordRates(state, stats(state));
    return { ok: true };
  }

  function starsForEarnings(all) {
    return Math.floor(Math.sqrt(nonNegative(all) / PRESTIGE.divisor));
  }

  function pendingStars(state) {
    return Math.max(0, starsForEarnings(state.allTimeEarnings) - state.stars);
  }

  function nextStarAt(state) {
    const next = Math.max(state.stars, starsForEarnings(state.allTimeEarnings)) + 1;
    return next * next * PRESTIGE.divisor;
  }

  function reputationMultiplier(state, stars = state.stars) {
    return 1 + stars * (perkEffect(state, 'angelInvestors')?.bonusPerStar ?? PRESTIGE.bonusPerStar);
  }

  function nextPerkOffer(state) {
    if (!state.perkChoicePending) return null;
    return PERK_TIERS.find(tier => tier.stars <= state.stars && !state.perks[tier.stars]) ?? null;
  }

  function runStartCash(state) {
    return state.runStartingCash;
  }

  function runSummary(state, now = state.lastTick) {
    let durationSeconds = null;
    if (state.perkChoicePending) durationSeconds = 0;
    else if (state.runStartedAt !== null) durationSeconds = Math.max(0, (now - state.runStartedAt) / 1000);
    return { durationSeconds, earnings: state.lifetime, machines: machineCount(state),
      bestIncome: Math.max(state.runBestIncome, stats(state).income), location: state.location };
  }

  // Only called once, at the sale or after its last outstanding choice. Never replay grants on load.
  function startNextRun(state, now) {
    const kit = perkEffect(state, 'starterKit');
    if (kit) {
      state.machines.laptop = kit.laptops;
      state.coolers.fan = kit.fans;
      if (kit.macros) state.upgrades.push('macros');
    }
    state.runStartingCash = kit?.cash ?? perkEffect(state, 'seedFunding')?.cash ?? 0;
    state.money = state.runStartingCash;
    state.staff.sibling = perkEffect(state, 'familyBusiness')?.sibling ?? 0;
    state.staff.sysadmin = perkEffect(state, 'itRetainer')?.sysadmin ?? 0;
    state.perkChoicePending = false;
    state.runStartedAt = state.lastTick = now;
    recordRates(state, stats(state));
  }

  function pickPerk(state, id, now = state.lastTick) {
    const offer = nextPerkOffer(state);
    if (!offer || !offer.options.some(option => option.id === id)) return { ok: false, reason: 'unavailable' };
    if (!Number.isFinite(now) || now < 0) return { ok: false, reason: 'time' };
    state.perks[offer.stars] = id;
    const started = !nextPerkOffer(state);
    if (started) startNextRun(state, now);
    return { ok: true, started };
  }

  function saleBlocker(state) {
    if (state.location === 'basement') return 'basement';
    if (state.lifetime < PRESTIGE.unlockLifetime) return 'earnings';
    if (pendingStars(state) < 1) return 'no-gain';
    return null;
  }

  function canSell(state) {
    return saleBlocker(state) === null;
  }

  function goalStrip(state) {
    if (state.location === 'basement') {
      return { phase: 'move', current: state.lifetime, target: CONFIG.moveGoal,
        progress: moveProgress(state), ready: canMove(state), pendingStars: 0, nextStarAt: null, doubleAt: null };
    }
    const gained = pendingStars(state);
    const next = nextStarAt(state);
    if (!canSell(state)) {
      // Later runs may fill the earnings bar before the next all-time star.
      const target = PRESTIGE.unlockLifetime;
      return { phase: 'sell', current: state.lifetime, target, progress: Math.min(1, state.lifetime / target),
        ready: false, pendingStars: gained, nextStarAt: next, doubleAt: null };
    }
    const current = state.allTimeEarnings;
    const previous = starsForEarnings(current) ** 2 * PRESTIGE.divisor;
    const double = (state.stars * 2) ** 2 * PRESTIGE.divisor;
    return { phase: 'ready', current, target: next, progress: (current - previous) / (next - previous),
      ready: true, pendingStars: gained, nextStarAt: next, doubleAt: double > next ? double : null };
  }

  function sellStartup(state, now = state.lastTick) {
    const reason = saleBlocker(state);
    if (reason) return { ok: false, reason };
    if (!Number.isFinite(now) || now < 0) return { ok: false, reason: 'time' };
    const gained = pendingStars(state);
    const stars = state.stars + gained;
    const keep = {
      stars, runs: state.runs + 1, allTimeEarnings: state.allTimeEarnings, perks: state.perks,
      clicks: state.clicks, startedAt: state.startedAt, flags: state.flags,
      counters: state.counters, achievements: state.achievements, records: state.records,
    };
    Object.assign(state, newState(now), keep);
    delete state.goals;
    delete state.priorityWaitSeconds;
    delete state.priorityWasFlying;
    if (state[LIVE_SESSION]) {
      state[LIVE_SESSION].taps.length = 0;
      state[LIVE_SESSION].heatSeconds = 0;
      state[LIVE_SESSION].powerSeconds = 0;
    }
    state.perkChoicePending = true;
    if (!nextPerkOffer(state)) startNextRun(state, now);
    return { ok: true, gained, stars };
  }

  // Short goals compare current run facts with a snapshot taken when the slot was filled.
  function goalFact(state, slot) {
    switch (slot.kind) {
      case 'machine': case 'milestone': return state.machines[slot.machine];
      case 'earnings': return state.lifetime;
      case 'priority': return state.counters.bonusesCaught;
      case 'jobs': return state.clicks;
      case 'upgrade': return Number(state.upgrades.includes(slot.upgrade));
      case 'incident': return state.counters.incidentsAccepted;
      case 'heat': return slot.streak;
      case 'move': return Number(state.location !== 'basement');
    }
  }

  function goalProgress(state, slot) {
    return Math.min(slot.target, Math.max(0, goalFact(state, slot) - slot.start));
  }

  function updateGoalHeat(state, rates, seconds) {
    const slot = state.goals.slots.find(g => g?.kind === 'heat');
    if (!slot || slot.streak >= slot.target) return;
    slot.streak = rates && rates.load >= GOALS.heatMin && rates.load <= GOALS.heatMax
      ? Math.min(slot.target, Math.round((slot.streak + seconds) * 1000) / 1000) : 0;
  }

  function goalCandidates(state) {
    const rates = stats(state);
    const pace = rates.income + rates.clickValue * GOALS.sizingClicksPerSecond;
    // A first laptop understates what the next few purchases will earn. Use a
    // modest opening budget, then scale with the player's present equipment.
    const earnTarget = Math.max(GOALS.minimumEarnings, Math.ceil(pace * GOALS.sizingSeconds));
    const minBudget = state.money + earnTarget * GOALS.minSizingSeconds / GOALS.sizingSeconds;
    const budget = state.money + earnTarget;
    const maxBudget = state.money + earnTarget * GOALS.maxSizingSeconds / GOALS.sizingSeconds;
    const candidates = [];
    function add(kind, target, details) {
      const slot = { kind, target, ...details };
      if (kind === 'heat') slot.streak = 0;
      slot.start = goalFact(state, slot);
      candidates.push(slot);
    }
    for (const m of MACHINES) {
      if (!isRevealed(state, 'machine', m.id) || !meetsRequirements(state, m)) continue;
      const owned = state.machines[m.id];
      let total = 0, units = 0;
      while (units < CONFIG.maxBulkBuy) {
        const next = price(m, owned + units, state);
        if (total + next > budget) break;
        total += next;
        units++;
      }
      if (units && total >= minBudget) add('machine', units, { machine: m.id });
      const next = nextMilestone(owned);
      if (next) {
        const cost = bulkCost(state, 'machine', m.id, next.count - owned);
        if (cost >= minBudget && cost <= maxBudget) add('milestone', next.count - owned, { machine: m.id });
      }
    }
    add('earnings', earnTarget);
    add('priority', 1);
    add('jobs', GOALS.handJobs);
    for (const u of UPGRADES) {
      if (!state.upgrades.includes(u.id) && isRevealed(state, 'upgrade', u.id) && meetsRequirements(state, u) &&
          u.cost >= minBudget && u.cost <= maxBudget) add('upgrade', 1, { upgrade: u.id });
    }
    if (state.event || machineCount(state) >= CONFIG.eventMinMachines) add('incident', 1);
    if (rates.load >= GOALS.heatMin && rates.load <= GOALS.heatMax &&
        (!state.active || state.active.remaining >= GOALS.heatSeconds)) add('heat', GOALS.heatSeconds);
    if (state.location === 'basement' && !canMove(state) && state.lifetime >= CONFIG.moveGoal * GOALS.closeToMove &&
        CONFIG.moveGoal - state.lifetime <= earnTarget * GOALS.maxSizingSeconds / GOALS.sizingSeconds) add('move', 1);
    return candidates;
  }

  function drawGoal(state, candidates, rng, previous, swapping = false) {
    const board = state.goals;
    const otherSlots = board.slots.filter(g => g && g !== previous);
    const otherKinds = new Set(otherSlots.map(g => g.kind));
    const reservedMachines = new Set(otherSlots.filter(g => g.machine).map(g => g.machine));
    const available = candidates.filter(g => !otherKinds.has(g.kind) && !reservedMachines.has(g.machine));
    const alternatives = available.filter(g => g.kind !== previous?.kind || g.machine !== previous.machine || g.upgrade !== previous.upgrade);
    if (swapping && !alternatives.length) return null;
    const choices = alternatives.length ? alternatives : available;
    if (!choices.length) return null;
    const pick = list => list[Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)))];
    const kind = pick([...new Set(choices.map(g => g.kind))]);
    const options = choices.filter(g => g.kind === kind);
    const selected = options.length === 1 ? options[0] : pick(options);
    return { ...selected, id: state.runs + ':' + ++board.serial };
  }

  function ensureGoals(state, rng = Math.random) {
    if (state.perkChoicePending || !state.machines.laptop) return;
    const board = state.goals ??= { serial: 0, slots: Array(GOALS.slots).fill(null), lastSwapAt: null };
    if (board.slots.every(Boolean)) return;
    const candidates = goalCandidates(state);
    for (let i = 0; i < board.slots.length; i++) {
      if (!board.slots[i]) board.slots[i] = drawGoal(state, candidates, rng);
    }
  }

  function goalTitle(slot) {
    const name = slot.machine && MACHINE_BY_ID[slot.machine].name;
    switch (slot.kind) {
      case 'machine': return `Own ${slot.target} more ${name}${slot.target === 1 ? '' : 's'}`;
      case 'earnings': return `Earn another ${formatMoney(slot.target)} this run`;
      case 'priority': return 'Catch a priority request';
      case 'jobs': return `Run ${slot.target} jobs by hand`;
      case 'upgrade': return `Buy ${UPGRADE_BY_ID[slot.upgrade].name}`;
      case 'incident': return 'Accept an incident offer';
      case 'heat': return `Keep load at ${GOALS.heatMin * 100}–${GOALS.heatMax * 100}% for ${slot.target} live seconds`;
      case 'milestone': return `Reach the ${slot.start + slot.target} ${name} milestone`;
      case 'move': return 'Move out of the basement';
    }
  }

  function swapWait(board, now) {
    return board?.lastSwapAt == null ? 0 : Math.max(0, Math.ceil(GOALS.swapSeconds - (now - board.lastSwapAt) / 1000));
  }

  function goalList(state, now = state.lastTick) {
    const slots = (state.goals?.slots || []).filter(Boolean).map(slot => {
      const current = goalProgress(state, slot);
      return { id: slot.id, kind: slot.kind, title: goalTitle(slot), current, target: slot.target,
        ready: current >= slot.target, rewardSeconds: GOAL_TEMPLATES[slot.kind].rewardSeconds };
    });
    return { slots, swapRemainingSeconds: swapWait(state.goals, now) };
  }

  function replaceGoal(state, index, rng, swapping = false) {
    const board = state.goals;
    const previous = board.slots[index];
    const next = drawGoal(state, goalCandidates(state), rng, previous, swapping);
    if (next) board.slots[index] = next;
    return Boolean(next);
  }

  function claimGoal(state, id, rng = Math.random) {
    const board = state.goals;
    const index = board?.slots.findIndex(g => g && g.id === id) ?? -1;
    if (typeof id !== 'string' || index < 0 || state.perkChoicePending || !state.machines.laptop) return { ok: false };
    const slot = board.slots[index];
    if (goalProgress(state, slot) < slot.target) return { ok: false };
    const rewardSeconds = GOAL_TEMPLATES[slot.kind].rewardSeconds;
    const amount = stats(state).income * rewardSeconds;
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false };
    // Size the replacement from the post-payout wallet before committing the
    // claim, so a failed replacement can never pay the same slot twice.
    const after = { ...state, money: state.money + amount, lifetime: state.lifetime + amount };
    if (!Number.isFinite(after.money) || !Number.isFinite(state.allTimeEarnings + amount) || !replaceGoal(after, index, rng)) {
      return { ok: false };
    }
    earn(state, amount);
    state.counters.goalsClaimed++;
    return { ok: true, amount, rewardSeconds };
  }

  function swapGoal(state, id, now = state.lastTick, rng = Math.random) {
    const board = state.goals;
    const index = board?.slots.findIndex(g => g && g.id === id) ?? -1;
    if (typeof id !== 'string' || index < 0 || !Number.isFinite(now) || now < 0 ||
        state.perkChoicePending || !state.machines.laptop || swapWait(board, now)) return { ok: false };
    const slot = board.slots[index];
    if (goalProgress(state, slot) >= slot.target) return { ok: false };
    if (!replaceGoal(state, index, rng, true)) return { ok: false };
    board.lastSwapAt = now;
    return { ok: true };
  }

  function restoreGoals(state, raw, now) {
    if (!state.machines.laptop || state.perkChoicePending || !Array.isArray(raw?.slots)) return;
    const board = { serial: 0, lastSwapAt: null, slots: Array(GOALS.slots).fill(null) };
    if (Number.isFinite(raw.lastSwapAt) && raw.lastSwapAt >= 0) board.lastSwapAt = Math.min(raw.lastSwapAt, now);
    const used = new Set(), kinds = new Set();
    for (let i = 0; i < board.slots.length; i++) {
      const entry = raw.slots[i];
      if (!entry || typeof entry.kind !== 'string' || !Object.hasOwn(GOAL_TEMPLATES, entry.kind) || kinds.has(entry.kind) ||
          typeof entry.id !== 'string' || used.has(entry.id)) continue;
      const serial = Number(entry.id.split(':')[1]);
      if (!Number.isSafeInteger(serial) || serial < 1 || serial >= Number.MAX_SAFE_INTEGER - GOALS.slots ||
          entry.id !== state.runs + ':' + serial) continue;
      const { kind, id, target, start } = entry;
      if (!Number.isFinite(start) || start < 0 || !Number.isInteger(target) || target <= 0) continue;
      const slot = { kind, id, target, start };
      if (kind === 'machine' || kind === 'milestone') {
        const machine = lookup('machine', entry.machine);
        if (!machine || !meetsRequirements(state, machine) || !isRevealed(state, 'machine', machine.id) ||
            !Number.isSafeInteger(start) || target > CONFIG.maxBulkBuy) continue;
        if (kind === 'milestone' && nextMilestone(start)?.count !== start + target) continue;
        slot.machine = machine.id;
      } else if (kind === 'heat') {
        if (start !== 0 || target !== GOALS.heatSeconds || !Number.isFinite(entry.streak) ||
            entry.streak < 0 || entry.streak > target) continue;
        slot.streak = entry.streak === target ? target : 0;
      } else if (kind === 'earnings') {
        const st = stats(state);
        const maxPace = Math.max(st.income, state.counters.highestIncome) + st.clickValue * GOALS.sizingClicksPerSecond;
        const maxTarget = Math.max(GOALS.minimumEarnings, Math.ceil(maxPace * GOALS.maxSizingSeconds));
        if (target < GOALS.minimumEarnings || target > maxTarget) continue;
      } else {
        const required = kind === 'jobs' ? GOALS.handJobs : 1;
        if (target !== required || !Number.isSafeInteger(start)) continue;
        if (kind === 'upgrade') {
          if (start !== 0 || typeof entry.upgrade !== 'string' || !lookup('upgrade', entry.upgrade) ||
              !isRevealed(state, 'upgrade', entry.upgrade)) continue;
          slot.upgrade = entry.upgrade;
        }
        if (kind === 'move' && (start !== 0 || state.location === 'basement' && state.lifetime < CONFIG.moveGoal * GOALS.closeToMove)) continue;
      }
      if (start > goalFact(state, slot)) continue;
      board.slots[i] = slot;
      board.serial = Math.max(board.serial, serial);
      used.add(id); kinds.add(kind);
    }
    // Even if one corrupt entry was discarded, do not reissue its old button ID.
    if (Number.isSafeInteger(raw.serial) && raw.serial < Number.MAX_SAFE_INTEGER - GOALS.slots) {
      board.serial = Math.max(board.serial, raw.serial);
    }
    state.goals = board;
  }

  // Badges read facts; claiming one never changes an economy multiplier.
  function goal(id, name, icon, desc, amount, target, hidden = false) {
    return { id, name, icon, desc, hidden,
      check: (s, st) => amount(s, st) >= target,
      progress: (s, st) => Math.max(0, Math.min(1, amount(s, st) / target)) };
  }
  const lifetime = s => s.allTimeEarnings;
  const largestFleet = s => Math.max(...MACHINES.map(m => s.machines[m.id]));
  const jobs = s => s.clicks;
  const catches = s => s.counters.bonusesCaught;
  const originalMachineIds = ['laptop', 'tower', 'rack', 'gpu'];
  const ACHIEVEMENTS = [
    { ...goal('power-steady', 'Permission to Launch', '🎛️', '', s => s.counters.longestMaxPowerSeconds, POWER.achievementSeconds),
      get desc() { return `Run machines at ${Math.round(POWER.max * 100)}% power for ${POWER.achievementSeconds} live seconds without overheating.`; } },
    goal('goals-10', 'List Person', '📋', 'Claim 10 to-do rewards.', s => s.counters.goalsClaimed, GOALS.firstBadge),
    goal('goals-100', 'Clipboard Supervisor', '✍️', 'Claim 100 to-do rewards.', s => s.counters.goalsClaimed, GOALS.secondBadge),
    { id: 'mall-move', name: 'Anchor Tenant', icon: '🏬', desc: 'Move your startup into the Dead Mall.',
      check: s => s.location === 'mall' || s.flags.movedToMall === true },
    goal('cluster-1', 'Training Wheels', '🧠', 'Own your first AI Training Cluster.', s => s.machines.cluster, 1),
    goal('cluster-50', 'Group Project', '🎓', 'Own 50 AI Training Clusters.', s => s.machines.cluster, CLUSTER_FLEET_GOAL),
    goal('first-sale', 'Priced to Sell', '💼', 'Sell your startup for the first time.', s => s.runs, 1),
    goal('stars-10', 'Pitch Deck Veteran', '📊', 'Earn 10 Investor Reputation stars.', s => s.stars, INVESTOR_STAR_GOAL),
    goal('stars-50', 'Angel in Sweatpants', '😇', 'Earn 50 Investor Reputation stars.', s => s.stars, ANGEL_STAR_GOAL),
    { id: 'two-minute-move', name: 'Boxes Still Packed', icon: '📦', desc: 'Move out within two minutes of starting a run.',
      check: s => s.records.fastestMoveSeconds !== null && s.records.fastestMoveSeconds <= FAST_RUN_MOVE_SECONDS },
    goal('sibling-hired', 'Allowance Payroll', '🧃', 'Hire your little sibling.', s => s.staff.sibling, 1),
    goal('sibling-max', 'Senior Keyboard Smasher', '🎹', 'Train your little sibling to level 5.',
      s => s.staff.sibling, STAFF_BY_ID.sibling.prices.length),
    goal('self-cooling', 'Self-cooling', '🧑‍🔧', 'Have the Sysadmin buy 25 coolers.', s => s.counters.sysadminPurchases, 25),
    goal('earn-1k', 'Pizza Budget', '🍕', 'Earn $1,000 in total.', lifetime, 1000),
    goal('earn-10k', 'Garage Payroll', '🧾', 'Earn $10,000 in total.', lifetime, 10000),
    goal('earn-100k', 'Six-Figure Basement', '💼', 'Earn $100,000 in total.', lifetime, 100000),
    goal('earn-1m', 'Million-Dollar Modem', '📡', 'Earn $1 million in total.', lifetime, 1e6),
    goal('earn-1b', 'Basement Billionaire', '💎', 'Earn $1 billion in total.', lifetime, 1e9),
    goal('hardware-10', 'Matching Set', '💻', 'Own 10 of one machine.', largestFleet, 10),
    goal('hardware-50', 'Bulk Discount, Please', '📦', 'Own 50 of one machine.', largestFleet, 50),
    goal('hardware-100', 'Serial Collector', '🔢', 'Own 100 of one machine.', largestFleet, 100),
    goal('complete-fleet', 'Mixed Fleet', '🗄️', 'Own a Laptop, Desktop Tower, Rack Server and GPU Rig.',
      s => originalMachineIds.filter(id => s.machines[id] > 0).length, originalMachineIds.length),
    goal('max-milestones', 'No Shelf Space', '🏗️', 'Reach every milestone on one machine type.',
      largestFleet, MILESTONES[MILESTONES.length - 1].count),
    { id: 'overheat', name: 'Toaster Mode', icon: '🍞', desc: 'Overheat the room for the first time.',
      check: (s, st) => !!(s.flags.firstHot || s.counters.everOverheated || st.throttle < 1) },
    goal('thermal-balance', 'The Thin Green Line', '🌡️', 'Stay at 95–100% load for 60 consecutive live seconds.',
      s => s.counters.longestHeatStreakSeconds, HEAT_BAND_SECONDS),
    goal('heatwave-survivor', 'Hold the Ice', '☀️', 'Finish a heat wave without buying ice.',
      s => s.counters.heatWavesSurvived, 1),
    goal('hands-100', 'Help Desk', '🖱️', 'Run 100 jobs by hand.', jobs, 100),
    goal('hands-1000', 'Keyboard Contractor', '⌨️', 'Run 1,000 jobs by hand.', jobs, 1000),
    goal('hands-10000', 'Warranty Void', '🔧', 'Run 10,000 jobs by hand.', jobs, 10000),
    goal('first-accept', 'Sure, We Can Do That', '🤝', 'Accept your first incident offer.',
      s => s.counters.incidentsAccepted, 1),
    goal('incident-10', 'On-Call Veteran', '☎️', 'Handle 10 incident offers.',
      s => s.counters.incidentsAccepted + s.counters.incidentsDeclined, 10),
    goal('bonus-1', 'Special Delivery', '⚡', 'Catch your first priority request.', catches, 1),
    goal('bonus-10', 'Priority Lane', '📨', 'Catch 10 priority requests.', catches, 10),
    // Keep its original ID so previously earned badges stay unlocked.
    goal('bonus-50', 'Request Magnet', '🧲', 'Catch 25 priority requests.', catches, 25),
    goal('jackpot', 'Golden Ticket', '🎟️', 'Catch a jackpot priority request.', s => s.counters.jackpotsCaught, 1),
    { id: 'moved', name: 'Out of the Basement', icon: '🚚', desc: 'Move into either new location.',
      check: s => s.location !== 'basement' },
    { id: 'speed-move', name: 'Eight-Minute Lease', icon: '⏱️', desc: 'Move out within eight minutes of starting this save.',
      check: s => s.runs === 0 && s.location !== 'basement' && s.counters.moveTimeRecorded === 1 && s.counters.timeToMove <= FAST_MOVE_SECONDS },
    goal('rapid-jobs', 'Key Rollover', '🎹', 'Run 50 jobs by hand within 10 seconds.',
      s => s.counters.bestTapBurst, TAP_BURST_COUNT, true),
    { id: 'late-return', name: 'Extended Lunch', icon: '🥪', desc: 'Come back after more than two hours away.', hidden: true,
      check: s => s.counters.longestAbsenceSeconds > LONG_ABSENCE_SECONDS },
    { id: 'fan-fiction', name: 'Fan Fiction', icon: '🌀', desc: 'Own 10 Box Fans while still in the basement.', hidden: true,
      check: s => s.location === 'basement' && s.coolers.fan >= 10 },
  ];
  const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map(a => a.id));
  function newAchievements(state, st = stats(state)) {
    return ACHIEVEMENTS.filter(a => !state.achievements.includes(a.id) && a.check(state, st)).map(a => a.id);
  }

  // ---------------------------------------------------------------------------
  // Saving and loading (the page decides WHERE to store the text; this decides WHAT)
  // ---------------------------------------------------------------------------

  function serialize(state) {
    // Empty fields have the same meaning as their absence in a version-one save.
    const { counters = {}, achievements = [], staff, stars, runs, allTimeEarnings, runStartedAt, records,
      perks, perkChoicePending, runBestIncome, runStartingCash, extraLocation, power, ...saved } = state;
    if (power !== undefined && power !== POWER.normal && powerUnlocked(state)) saved.power = normalizedPower(power);
    // In a first run the original fields already encode these defaults.
    if (stars || runs || allTimeEarnings !== state.lifetime || runStartedAt !== state.startedAt ||
        records?.fastestMoveSeconds != null || records?.bestRunEarnings > state.lifetime) {
      Object.assign(saved, { stars, runs, allTimeEarnings, runStartedAt, records });
    }
    if (staff && (staff.sibling || staff.sysadmin || !staff.sysadminEnabled)) saved.staff = staff;
    if (Object.values(counters).some(value => value !== 0)) saved.counters = counters;
    if (achievements.length) saved.achievements = achievements;
    if (perks && Object.keys(perks).length) saved.perks = perks;
    if (perkChoicePending) saved.perkChoicePending = true;
    if (runStartingCash) saved.runStartingCash = runStartingCash;
    if (runs && runBestIncome) saved.runBestIncome = runBestIncome;
    if (extraLocation || (state.location !== 'basement' && perkEffect(state, 'franchise')?.bothLocations)) {
      saved.extraLocation = extraLocation ?? null;
    }
    return JSON.stringify(saved);
  }

  const nonNegative = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const count = (v) => Math.floor(nonNegative(v));
  const integerCounters = new Set(['goalsClaimed', 'machinesBought', 'coolersBought', 'incidentsAccepted', 'incidentsDeclined',
    'heatWavesSurvived', 'bonusesCaught', 'bonusesMissed', 'jackpotsCaught', 'bestTapBurst', 'sysadminPurchases']);

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
    s.lifetime = nonNegative(raw.lifetime);
    s.allTimeEarnings = Math.max(s.lifetime, nonNegative(raw.allTimeEarnings));
    if (Number.isSafeInteger(raw.stars) && raw.stars >= 0) {
      s.stars = Math.min(raw.stars, starsForEarnings(s.allTimeEarnings));
    }
    if (Number.isSafeInteger(raw.runs) && raw.runs >= 0) s.runs = Math.min(s.stars, raw.runs);
    if (s.runs > 0 && raw.perks && typeof raw.perks === 'object' && !Array.isArray(raw.perks)) {
      for (const tier of PERK_TIERS) {
        const id = raw.perks[tier.stars];
        if (s.stars >= tier.stars && tier.options.some(option => option.id === id)) s.perks[tier.stars] = id;
      }
    }
    if ((perkEffect(s, 'seedFunding') || perkEffect(s, 'starterKit')) && Number.isSafeInteger(raw.runStartingCash)) {
      s.runStartingCash = nonNegative(raw.runStartingCash);
    }
    // With a cash grant, balance and earnings accumulate from different starting points.
    // Keep the actual earnings ledger rather than reconstructing it from rounded floating-point balances.
    if (!s.runStartingCash || !Number.isFinite(raw.lifetime) || raw.lifetime < 0) {
      s.lifetime = Math.max(s.lifetime, s.money - s.runStartingCash);
    }
    s.allTimeEarnings = Math.max(s.lifetime, s.allTimeEarnings);
    s.records.bestRunEarnings = Math.max(s.lifetime, Math.min(s.allTimeEarnings, nonNegative(raw.records?.bestRunEarnings)));
    s.clicks = count(raw.clicks);
    if (raw.counters && typeof raw.counters === 'object' && !Array.isArray(raw.counters)) {
      for (const key of Object.keys(s.counters)) {
        const value = raw.counters[key];
        if (integerCounters.has(key) && !Number.isSafeInteger(value)) continue;
        s.counters[key] = nonNegative(value);
      }
    }
    if (Array.isArray(raw.achievements)) {
      s.achievements = [...new Set(raw.achievements.filter(id => ACHIEVEMENT_IDS.has(id)))];
    }
    const machines = raw.machines && typeof raw.machines === 'object' ? raw.machines : {};
    const coolers = raw.coolers && typeof raw.coolers === 'object' ? raw.coolers : {};
    for (const m of MACHINES) s.machines[m.id] = count(machines[m.id]);
    for (const c of COOLERS) s.coolers[c.id] = count(coolers[c.id]);
    if (raw.staff && typeof raw.staff === 'object' && !Array.isArray(raw.staff)) {
      for (const def of STAFF) {
        const level = raw.staff[def.id];
        if (Number.isInteger(level) && level >= 0 && level <= def.prices.length) s.staff[def.id] = level;
      }
      if (s.staff.sysadmin && typeof raw.staff.sysadminEnabled === 'boolean') {
        s.staff.sysadminEnabled = raw.staff.sysadminEnabled;
      }
    }
    if (Array.isArray(raw.upgrades)) {
      s.upgrades = [...new Set(raw.upgrades.filter(id => typeof id === 'string' && Object.hasOwn(UPGRADE_BY_ID, id)))];
      s.upgrades = s.upgrades.filter(id => !UPGRADE_BY_ID[id].requiresUpgrade || s.upgrades.includes(UPGRADE_BY_ID[id].requiresUpgrade));
    }
    if (moveDestinations(s).includes(raw.location)) {
      s.location = raw.location;
    }
    const choices = franchiseChoices(s, s.location);
    if (choices.includes(raw.extraLocation)) {
      s.extraLocation = raw.extraLocation;
    } else if (!Object.hasOwn(raw, 'extraLocation') && choices.length && ['warehouse', 'office'].includes(s.location)) {
      // In a pre-Mall Franchise save these two effects were automatically active together.
      s.extraLocation = s.location === 'warehouse' ? 'office' : 'warehouse';
    }
    if (!meetsRequirements(s, MACHINE_BY_ID.cluster)) s.machines.cluster = 0;
    if (!s.machines.cluster) s.upgrades = s.upgrades.filter(id => id !== 'distillation');
    if (raw.flags && typeof raw.flags === 'object') {
      for (const key of Object.keys(raw.flags)) {
        if (key !== 'firstPriorityRequestSeen' && raw.flags[key]) s.flags[key] = true;
      }
    }
    if (!s.runs || raw.flags?.movedToMall !== true) delete s.flags.movedToMall;
    if (s.location === 'mall') s.flags.movedToMall = true;
    // Before the appearance flag existed, catches and misses were saved at resolution.
    const c = s.counters;
    if (raw.flags?.firstPriorityRequestSeen === true || c.bonusesCaught || c.bonusesMissed ||
        c.jackpotsCaught || c.bonusCashEarned || s.achievements.some(id => id.startsWith('bonus-') || id === 'jackpot')) {
      markBonusAppeared(s);
    }
    if (raw.priorityWasFlying === true && s.flags.firstPriorityRequestSeen && machineCount(s)) s.priorityWasFlying = true;
    const maxWait = nextBonusGap(s, () => 1);
    if (Number.isFinite(raw.priorityWaitSeconds) && raw.priorityWaitSeconds >= 0 &&
        raw.priorityWaitSeconds <= maxWait && machineCount(s) > 0) {
      s.priorityWaitSeconds = raw.priorityWaitSeconds;
    }
    // A legacy location proves the player moved, but cannot establish how quickly they did it.
    s.counters.everOverheated = Number(raw.counters?.everOverheated === 1);
    if ((s.runs === 0 && s.location === 'basement') || raw.counters?.moveTimeRecorded !== 1 ||
        !Number.isFinite(raw.counters?.timeToMove) || raw.counters.timeToMove < 0) {
      s.counters.moveTimeRecorded = 0;
      s.counters.timeToMove = 0;
    }
    if (Number.isFinite(raw.nextEventIn) && raw.nextEventIn >= 0) {
      s.nextEventIn = Math.min(raw.nextEventIn, CONFIG.eventGapMaxSeconds);
    }
    if (Number.isFinite(raw.startedAt) && raw.startedAt >= 0) s.startedAt = raw.startedAt;
    const runStart = raw.runStartedAt === undefined && s.runs === 0 ? raw.startedAt : raw.runStartedAt;
    // A populated save with no usable start timestamp cannot prove a timed move.
    if (Number.isFinite(runStart) && runStart >= 0) {
      s.runStartedAt = runStart;
    } else if (s.runs > 0 || s.lifetime > 0 || raw.runStartedAt !== undefined) {
      s.runStartedAt = null;
    }
    const fastest = raw.records?.fastestMoveSeconds;
    if ((s.runs > 0 || s.location !== 'basement') && Number.isFinite(fastest) && fastest >= 0) {
      s.records.fastestMoveSeconds = fastest;
    }
    if (s.counters.moveTimeRecorded) {
      s.records.fastestMoveSeconds = Math.min(s.records.fastestMoveSeconds ?? Infinity, s.counters.timeToMove);
    }
    if (Number.isFinite(raw.lastTick) && raw.lastTick >= 0) {
      s.lastTick = raw.lastTick;
      // Restore timers as of lastTick. Startup catch-up then credits any effect through its expiry.
      s.active = restoreIncident(raw.active, false, s);
      if (!s.active) s.event = restoreIncident(raw.event, true, s);
    }
    if (raw.perkChoicePending === true && s.runs > 0 && s.location === 'basement' &&
        s.lifetime === 0 && s.money === 0 && machineCount(s) === 0 && !s.upgrades.length &&
        !s.staff.sibling && !s.staff.sysadmin && !Object.values(s.coolers).some(Boolean)) {
      s.perkChoicePending = true;
      s.perkChoicePending = nextPerkOffer(s) !== null;
    }
    const previousPeak = s.runs ? nonNegative(raw.runBestIncome) : s.counters.highestIncome;
    s.runBestIncome = s.perkChoicePending ? 0 : previousPeak;
    // An old board still above capacity can use the control immediately. Its
    // existing counters stay untouched until a real tick or slider input observes it.
    s.power = hasPowerHistory(s) && !s.perkChoicePending ? normalizedPower(raw.power) : POWER.normal;
    s.counters.longestMaxPowerSeconds = hasPowerHistory(s) ? Math.min(POWER.achievementSeconds, s.counters.longestMaxPowerSeconds) : 0;
    restoreGoals(s, raw.goals, now);
    return s;
  }

  // ---------------------------------------------------------------------------
  // News and first-time guidance. The screen supplies the local hour, drawing
  // of the random number, and whether a transient UI element is actually shown.
  // ---------------------------------------------------------------------------

  const NEWS = { historySize: 10, matchingWeight: 4, reducedMs: 8000, pauseMs: 10000,
    pixelsPerSecond: 26, holdMs: 1500, recentEventMs: 60000 };
  const HEADLINES = Object.entries({
    general: [
      'Help desk hours extended until dinner',
      'Founder paid entirely in leftover pizza',
      'New cable drawer immediately full',
      'Business cards printed on old homework',
      'Board meeting moved to breakfast',
      'Mystery screw gets its own parking spot',
      'First investor asks about bedtime',
      'Keyboard crumbs listed as fixed assets',
      'Cloud turns out to have a street address',
      'Cable labels survive first spelling test',
      'Forecast calls for scattered updates',
      'Support ticket closed by plugging it in',
      'Server names now outnumber pets',
      'Printer declines to join the startup',
      'One blinking light promoted to manager',
      'Family calendar gains a reboot window',
      'Backup plan written on a cereal box',
      'Cat signs off on keyboard inspection',
      'Founder adds uptime to school résumé',
      'Cable tie elected employee of the month',
      'Spare parts box contains another box',
      'Snack budget awaits board approval',
    ],
    basement: [
      'Laundry day doubles as a vibration test',
      'Dryer claims seniority over servers',
      'Basement door gets a business address',
      'Lost sock found behind the help desk',
    ],
    warehouse: [
      'Cold aisle earns its name this morning',
      'Server tour now includes a scarf',
      'Frost makes a map of the network',
      'Pallet jack gets a visitor badge',
    ],
    office: [
      'Downtown view wins a window-seat raffle',
      'Elevator music enters the hold queue',
      'Client meeting uses every nice mug',
      'Desk plant gets its own network name',
    ],
    mall: [
      'Food court adds a byte-size special',
      'Old shoe shop measures feet of cable',
      'Mall map still points to the arcade',
      'Security guard hears the cloud humming',
      'Escalator enjoys its longest break yet',
    ],
    heat: [
      'Hot aisle enters the toast business',
      'Thermometer asks for a desk fan',
      'Warmest seat in town suddenly vacant',
      'Fans file for a longer lunch break',
    ],
    sibling: [
      'Little Sibling submits invoice in candy',
      'New hire brings a lucky lunchbox',
      'Sibling requests a taller office chair',
      'Payroll now accepts fruit snacks',
    ],
    milestone: [
      'Odometer on the rack rolls over',
      'Another batch earns its gold sticker',
      'Production chart needs taller paper',
    ],
    sale: [
      'Former CEO back on dish duty',
      'Family briefly regains the basement',
      'Founder updates résumé during lunch',
    ],
    cluster: [
      'Training Cluster learns the lunch bell',
      'Model predicts one more power strip',
      'Cluster graduates from counting socks',
    ],
    powerHigh: ['Electric meter blames the new power dial'],
    powerLow: ['Server dial finds its indoor voice'],
    night: [
      'Porch light clocks out before servers',
      'Late shift hears the fridge solo',
      'Midnight backup wakes exactly one cat',
      'Moon gets credit for the night shift',
    ],
  }).flatMap(([condition, texts]) => texts.map((text, i) => ({ id: condition + '-' + i, condition, text })));

  function pickHeadline(state, recent, context, roll) {
    const hour = context.hour;
    const matches = { general: true, [state.location]: true, heat: context.throttled,
      sibling: state.staff.sibling > 0, milestone: context.milestone, sale: state.runs > 0 && context.afterSale,
      cluster: state.machines.cluster > 0, night: hour >= 21 || hour < 6,
      powerHigh: hasPowerHistory(state) && state.power > POWER.normal,
      powerLow: hasPowerHistory(state) && state.power < POWER.normal };
    const excluded = new Set(recent.slice(-NEWS.historySize));
    const eligible = HEADLINES.filter(h => matches[h.condition] && !excluded.has(h.id));
    const weight = h => h.condition === 'general' ? 1 : NEWS.matchingWeight;
    let ticket = roll * eligible.reduce((sum, h) => sum + weight(h), 0);
    for (const headline of eligible) {
      ticket -= weight(headline);
      if (ticket < 0) return headline;
    }
    return eligible.at(-1);
  }

  const TIP_VISIBLE_MS = 8000;
  const TIP_BULK_COUNT = 10;
  const canBuyTen = s => MACHINES.some(m => isRevealed(s, 'machine', m.id) &&
    s.money >= bulkCost(s, 'machine', m.id, TIP_BULK_COUNT));
  const staffRevealed = s => STAFF.some(d => isRevealed(s, 'staff', d.id));
  const TIPS = [
    { id: 'perk', text: 'Your pick carries into every future run.', when: s => s.perkChoicePending,
      seenBefore: s => Object.keys(s.perks).length > 0 },
    { id: 'priority', text: 'Tap the moving bolt for a cash bonus.', when: (s, view) => view.priority,
      seenBefore: s => s.flags.firstPriorityRequestSeen || s.counters.bonusesCaught || s.counters.bonusesMissed },
    { id: 'incident', text: 'Check both choices before the timer ends.', when: s => !!s.event,
      seenBefore: s => s.event || s.active || s.counters.incidentsAccepted || s.counters.incidentsDeclined },
    { id: 'power', text: 'Push Power up to earn more, but heat climbs faster. The best spot is where heat meets your cooling.',
      when: (s, view) => view.powerUnlocked ?? powerUnlocked(s), seenBefore: s => powerUnlocked(s) && s.power !== POWER.normal },
    { id: 'heat', text: 'Open Cooling to restore lost income.', when: (s, view) => view.throttled,
      seenBefore: s => s.flags.firstHot || s.counters.everOverheated },
    { id: 'move', text: 'Compare locations before you move.', when: canMove,
      seenBefore: s => s.flags.canMove || s.location !== 'basement' || s.runs || canMove(s) },
    { id: 'sale', text: 'Review the sale to see what you keep.', when: canSell,
      seenBefore: s => s.runs || canSell(s) },
    { id: 'mall', text: 'Mall prices also apply to cooling.', when: s => s.location === 'mall',
      seenBefore: s => s.location === 'mall' || s.flags.movedToMall },
    { id: 'cluster', text: 'Buy one Cluster to unlock Model Distillation.', when: s => isRevealed(s, 'machine', 'cluster'),
      seenBefore: s => s.machines.cluster || s.runs >= 2 || isRevealed(s, 'machine', 'cluster') },
    { id: 'staff', text: 'Open Staff to price your first hire.', when: staffRevealed,
      seenBefore: s => s.staff.sibling || s.staff.sysadmin || s.runs || staffRevealed(s) },
    { id: 'bulk', text: 'Choose ×10 to buy ten machines at once.', when: canBuyTen,
      seenBefore: s => s.runs || s.lifetime >= bulkCost(newState(0), 'machine', 'laptop', TIP_BULK_COUNT) ||
        MACHINES.some(m => s.machines[m.id] >= TIP_BULK_COUNT) },
    { id: 'best', text: 'The star weighs price, pay and cooling.', when: (s, view) => view.best,
      seenBefore: s => s.clicks || machineCount(s) || s.lifetime || s.runs },
  ];

  function pendingTips(state, view, queued = new Set()) {
    return TIPS.filter(tip => !state.flags['tip:' + tip.id] && !queued.has(tip.id) && tip.when(state, view));
  }

  // Called once when a pre-tips save first opens, before its offline earnings
  // arrive. New discoveries during catch-up still qualify for their own tips.
  function legacyTipFlags(state) {
    const seen = {};
    for (const tip of TIPS) {
      if (tip.seenBefore(state)) seen['tip:' + tip.id] = true;
    }
    if (stats(state).throttle < 1) seen['tip:heat'] = true;
    return seen;
  }

  // Number formatting (kept here so it's tested alongside the math)

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

  function formatPayback(seconds) {
    return Number.isFinite(seconds) && seconds > 0 ? 'Pays back in ' + formatDuration(Math.ceil(seconds)) : '';
  }

  function formatAffordable(seconds) {
    if (seconds === 0) return 'Affordable now';
    return Number.isFinite(seconds) && seconds > 0 ? 'Affordable in ' + formatDuration(Math.ceil(seconds)) : '';
  }

  const api = {
    POWER, powerUnlocked, setPower, powerSweetSpot, bestPower,
    NEWS, HEADLINES, pickHeadline, TIPS, TIP_VISIBLE_MS, pendingTips, legacyTipFlags,
    CONFIG, MILESTONES, MACHINES, COOLERS, UPGRADES, STAFF, LOCATIONS, EVENTS, SAVE_VERSION, BONUS, PRESTIGE, PERK_TIERS, ACHIEVEMENTS,
    lookup, newState, milestoneMult, nextMilestone, modifiers, stats,
    price, cost, ownedCount, meetsRequirements, isRevealed, revealPoint, nextReveal, canBuy, buy,
    bulkCost, maxAffordable, buyMany, cheapestCoolerFor, runSysadmin, bestBuy, purchaseQuote, buyRecommendation, secondsToAfford,
    click, advance, catchUp, nextBonusGap, markBonusAppeared, rollBonusReward, claimBonus, missBonus, newAchievements,
    machineCount, activeOutcome, startEvent, respondToEvent, tickEvents, clearIncidents,
    moveProgress, canMove, moveDestinations, franchiseChoices, moveTo, starsForEarnings, pendingStars, nextStarAt, canSell, sellStartup, earn,
    reputationMultiplier, nextPerkOffer, pickPerk, runSummary, runStartCash, goalStrip,
    GOALS, GOAL_TEMPLATES, ensureGoals, goalList, claimGoal, swapGoal,
    serialize, deserialize,
    formatMoney, formatRate, formatNumber, formatDuration, formatPayback, formatAffordable,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Economy = api;
})(typeof window !== 'undefined' ? window : globalThis);
