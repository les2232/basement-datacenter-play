/*
 * Basement Datacenter: the page.
 *
 * economy.js decides the rules; this file shows them on screen, reacts to clicks,
 * tells the story, and saves to the browser's localStorage.
 */
(function () {
  'use strict';

  const E = window.Economy;
  const { MACHINES, COOLERS, UPGRADES, STAFF, LOCATIONS, CONFIG } = E;
  const money = E.formatMoney;
  const rate = E.formatRate;
  const wholeDollars = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
  const moveGoalText = wholeDollars.format(CONFIG.moveGoal);

  const SAVE_KEY = 'basement-datacenter-save';
  const PERSIST_REQUESTED_KEY = 'basement-datacenter-persistence-requested';
  const SAVE_EVERY_MS = 5000;
  const FRAME_MS = 100;
  const AWAY_NOTICE_SECONDS = 120; // gaps longer than this get a "while you were gone" summary
  const ROOM_MAX_ICONS = 6;        // bound the number of animated LEDs and fans per type
  const ROOM_DROP_LIMIT = 6;       // stagger up to six new icons for one purchase

  const $ = (id) => document.getElementById(id);
  const el = {
    income: $('income'), throttle: $('throttle'), reserve: $('cooling-reserve'),
    incomeSource: $('income-source'), staffHeading: $('staff-heading'), sysadminReceipt: $('sysadmin-receipt'),
    heatText: $('heat-text'), heatFill: $('heat-fill'),
    incident: $('incident-banner'), incidentTitle: $('incident-title'), incidentTime: $('incident-time'),
    incidentDetail: $('incident-detail'), incidentActions: $('incident-actions'),
    accept: $('incident-accept'), decline: $('incident-decline'),
    milestone: $('milestone'), milestoneText: $('milestone-text'), milestoneFill: $('milestone-fill'),
    moveBtn: $('move-btn'), location: $('location'),
    jobBtn: $('job-btn'), jobValue: $('job-value'),
    room: $('room'), roomTitle: $('room-title'), log: $('log'),
    upgradeEmpty: $('upgrade-empty'), installed: $('installed'),
    unlockTeaser: $('unlock-teaser'), unlockText: $('unlock-text'), unlockProgress: $('unlock-progress'),
    saveStatus: $('save-status'), resetBtn: $('reset-btn'),
    modal: $('modal'), modalTitle: $('modal-title'), modalBody: $('modal-body'), modalActions: $('modal-actions'),
  };

  let state;
  let cards = [];               // { kind, def, el, parts... }
  let roomKey = '';
  let installedKey = null;
  let lastSavedAt = 0;
  let storageOk = true;
  let away = null;              // accumulated "while you were gone" report shown in the modal
  let suspended = false;        // hidden tabs settle elapsed time once, on return
  const incidentTypes = new Map(E.EVENTS.map(def => [def.id, def]));
  const incidentRemaining = $('incident-remaining');
  let previousOffer = null;
  let previousMoveReady = false;
  let lastStats;
  let purchaseUiFrame = 0;

  // ---------------------------------------------------------------------------
  // Story: one-time messages, each shown once per save (remembered in state.flags)
  // ---------------------------------------------------------------------------

  const STORY = [
    { id: 'intro', when: () => true,
      text: "Your parents finally gave you the basement. You have one outlet and one idea: rent out computer time." },
    { id: 'firstLaptop', when: (s) => s.machines.laptop >= 1,
      text: "💻 The laptop whirs to life. Somewhere, a stranger's spreadsheet is being calculated. You get paid every second." },
    { id: 'firstHot', when: (s, st) => st.throttle < 1, cls: 'warn',
      text: "🔥 It's getting hot down here! When heat goes over your cooling, every machine slows down. A Box Fan will help." },
    { id: 'firstFan', when: (s) => s.coolers.fan >= 1,
      text: '🌀 The fan rattles to life. Machines run full speed as long as heat stays under cooling.' },
    { id: 'firstTower', when: (s) => s.machines.tower >= 1,
      text: '🖥️ Mom asks why the dryer is warm when nobody has used it.' },
    { id: 'thousand', when: (s) => s.lifetime >= 1000, cls: 'good',
      text: 'First $1,000 earned. You celebrate with a second extension cord.' },
    { id: 'firstRack', when: (s) => s.machines.rack >= 1,
      text: '🗄️ The rack server boots. Every light in the house dims for a second.' },
    { id: 'overclock', when: (s) => s.upgrades.includes('overclock'), cls: 'warn',
      text: '⚡ You flip every switch to MAX. The basement smells like hot dust. Watch that heat bar.' },
    { id: 'halfway', when: (s) => s.location === 'basement' && s.lifetime >= CONFIG.moveGoal / 2,
      text: "A neighbor asks if you're \"mining crypto down there.\" You say \"sort of.\" Halfway to moving out." },
    { id: 'canMove', when: (s) => E.canMove(s), cls: 'big',
      text: `🚚 You've earned ${moveGoalText} and outgrown the basement. Press the move button to choose your new home.` },
    { id: 'movedWarehouse', when: (s) => s.location === 'warehouse', cls: 'big',
      text: '🧊 Welcome to the Arctic Warehouse. Your breath fogs. Your machines have never been happier. GPU Rigs unlocked!' },
    { id: 'movedOffice', when: (s) => s.location === 'office', cls: 'big',
      text: '🏙️ Welcome to the Downtown Office. Clients pay more for the fancy address. GPU Rigs unlocked!' },
    { id: 'firstGpu', when: (s) => s.machines.gpu >= 1,
      text: '🎮 The GPU rig spins up. It sounds like a hair dryer having an argument.' },
    { id: 'endOfPrototype', when: (s) => s.machines.gpu >= 5, cls: 'good',
      text: "That's the end of the first prototype! Keep building, or reset and try the other location." },
  ];

  function checkStory(st) {
    for (const beat of STORY) {
      if (!state.flags[beat.id] && beat.when(state, st)) {
        state.flags[beat.id] = true;
        log(beat.text, beat.cls);
      }
    }
  }

  function log(text, cls) {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    el.log.prepend(li);
    while (el.log.children.length > 40) el.log.lastChild.remove();
  }

  // ---------------------------------------------------------------------------
  // Saving (localStorage; everything stays in this browser)
  // ---------------------------------------------------------------------------

  function readSave() {
    try {
      return localStorage.getItem(SAVE_KEY);
    } catch (e) {
      storageOk = false;
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, E.serialize(state));
      storageOk = true;
      lastSavedAt = Date.now();
    } catch (e) {
      storageOk = false;
    }
  }

  function wipeSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* nothing to wipe */ }
  }

  async function requestPersistentStorage() {
    try {
      if (!navigator.storage?.persist) return;
      try {
        if (localStorage.getItem(PERSIST_REQUESTED_KEY)) return;
        localStorage.setItem(PERSIST_REQUESTED_KEY, '1');
      } catch { /* Storage may be unavailable; try once for this visit. */ }
      await navigator.storage.persist();
    } catch { /* Normal browser saving still works if persistence is denied. */ }
  }

  // ---------------------------------------------------------------------------
  // Feedback helpers
  // ---------------------------------------------------------------------------

  function centerOf(node) {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // ---------------------------------------------------------------------------
  // Shop
  // ---------------------------------------------------------------------------

  const QUANTITY_KEY = 'basement-datacenter-shop-quantity';
  const quantityControl = $('shop-quantity');
  let quantity = '1';

  function initQuantity() {
    const radios = Array.from(quantityControl.querySelectorAll('input'));
    try {
      const saved = localStorage.getItem(QUANTITY_KEY);
      if (radios.some((radio) => radio.value === saved)) quantity = saved;
    } catch { /* The selector still works in memory. */ }
    for (const radio of radios) radio.checked = radio.value === quantity;
    quantityControl.addEventListener('change', (event) => {
      quantity = event.target.value;
      try { localStorage.setItem(QUANTITY_KEY, quantity); } catch { /* Keep the session preference. */ }
      renderShop(E.stats(state));
    });
  }

  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildShop() {
    initQuantity();
    cards = [];
    const groups = [['machine', MACHINES], ['cooler', COOLERS], ['upgrade', UPGRADES], ['staff', STAFF]];
    for (const [kind, list] of groups) {
      const container = $('shop-' + kind);
      container.textContent = '';
      for (const def of list) {
        const button = make('button', 'card');
        button.type = 'button';
        if (kind === 'staff') button.id = 'staff-' + def.id;
        const icon = make('span', 'card-icon', def.icon);
        const main = make('span', 'card-main');
        const title = make('span', 'card-title');
        const name = make('span', null, def.name);
        const owned = make('span', 'card-owned');
        title.append(name, owned);
        const desc = make('span', 'card-desc');
        const blurb = make('span', 'card-blurb', def.blurb || '');
        blurb.hidden = !def.blurb;
        main.append(title, desc, blurb);
        const price = make('span', 'card-price');
        const costEl = make('span', 'card-cost');
        const shortfall = make('small', 'card-shortfall');
        price.append(costEl, shortfall);
        const symbol = make('span', 'card-symbol');
        const badge = make('span', 'card-new', 'NEW');
        badge.hidden = true;
        symbol.append(icon, badge);
        const funds = make('span', 'card-funds');
        funds.setAttribute('aria-hidden', 'true');
        const fill = make('span', 'card-funds-fill');
        funds.appendChild(fill);
        button.append(symbol, main, price, funds);
        const row = make('div', 'card-row');
        const acknowledge = make('button', 'ack-item');
        acknowledge.type = 'button';
        acknowledge.hidden = true;
        acknowledge.setAttribute('aria-label', `Mark ${def.name} as seen`);
        row.append(button, acknowledge);
        container.appendChild(row);

        const card = { kind, def, el: button, row, owned, desc, cost: costEl, shortfall,
          badge, acknowledge, funds, fill, newFlag: `shop-new:${kind}:${def.id}` };
        if (kind === 'machine') {
          const label = make('span', 'card-milestone-label');
          const track = make('span', 'card-milestone-track');
          const fill = make('span', 'card-milestone-fill');
          track.setAttribute('aria-hidden', 'true');
          track.appendChild(fill);
          main.append(label, track);
          card.milestone = { label, track, fill, lastOwned: null };
        }
        button.addEventListener('click', () => onBuy(card));
        // The purchase stays natively disabled. This second, keyboard-accessible hit area
        // lets someone dismiss NEW without ever buying an item they cannot afford.
        acknowledge.addEventListener('click', () => {
          delete state.flags[card.newFlag];
          card.badge.hidden = card.acknowledge.hidden = true;
          save();
        });
        cards.push(card);
      }
    }
  }

  // Between two consecutive Max totals the affordable count cannot change. Reuse
  // that quote while money ticks up, or until a purchase changes the owned count.
  function quoteFor(card, owned = E.ownedCount(state, card.kind, card.def.id)) {
    const { kind, def } = card;
    const mode = kind === 'machine' || kind === 'cooler' ? quantity : '1';
    const cached = card.quote;
    if (cached && cached.owned === owned && cached.mode === mode &&
        (mode !== 'max' || (state.money >= cached.total && state.money < cached.nextTotal))) return cached;

    const count = mode === 'max' ? E.maxAffordable(state, kind, def.id) : Number(mode);
    const total = E.bulkCost(state, kind, def.id, count);
    const nextTotal = mode === 'max' && count < CONFIG.maxBulkBuy
      ? total + E.price(def, owned + count) : Infinity;
    const formatted = wholeDollars.format(total);
    const label = mode === 'max' ? `Max (${count}) · ${formatted}` : formatted;
    card.quote = { mode, owned, count, total, nextTotal, label };
    return card.quote;
  }

  function onBuy(card) {
    if (card.el.hidden || modalOpen() || suspended || document.hidden) return;
    if (card.kind === 'staff' && card.def.id === 'sysadmin' && state.staff.sysadmin) {
      state.staff.sysadminEnabled = !state.staff.sysadminEnabled;
      render();
      save();
      return;
    }
    if (!settleBeforePurchaseOrMove()) return;
    const { count } = quoteFor(card);
    if (!count) return;
    const result = E.buyMany(state, card.kind, card.def.id, count);
    if (!result.ok) return;
    delete state.flags[card.newFlag];
    feel.spend(card.el, result.cost, card.kind === 'upgrade');
    feel.purchase(result.count);
    const spent = wholeDollars.format(result.cost);
    if (card.kind === 'upgrade') {
      log(`${card.def.icon} Installed ${card.def.name}: ${card.def.desc}`, 'good');
    } else if (card.kind === 'staff') {
      const level = state.staff[card.def.id];
      log(level === 1 ? `${card.def.icon} Hired ${card.def.name} for ${spent}.` :
        `${card.def.icon} ${card.def.name} reached level ${level} for ${spent}.`, 'good');
    } else {
      const name = result.count === 1 ? card.def.name : card.def.name + 's';
      log(`Bought ${result.count} ${name} for ${spent}.`);
    }
    render();
    save();
  }

  // Text for a card's middle line, using the CURRENT multipliers so upgrades are reflected.
  function describe(card, st) {
    const id = card.def.id;
    if (card.kind === 'machine') {
      return `+${rate(st.incomePerUnit[id])} each · +${E.formatNumber(st.heatPerUnit[id])} heat`;
    }
    if (card.kind === 'cooler') return `+${E.formatNumber(st.coolingPerUnit[id])} cooling each`;
    if (card.kind === 'staff') {
      if (id === 'sysadmin') return `Buys cooling above 100% load. Spends up to ${CONFIG.sysadminSpendShare * 100}% of cash per purchase.`;
      const next = card.def.jobsPerSecond[state.staff.sibling];
      const current = st.siblingJobsPerSecond ? `${st.siblingJobsPerSecond} ${st.siblingJobsPerSecond === 1 ? 'job' : 'jobs'}/s · ${rate(st.staffIncome)}` : '';
      if (!next) return current;
      const nextPay = rate(next * st.clickValue);
      return current ? `${current} → ${next} jobs/s · ${nextPay}` : `Runs 1 job/s by hand · ${nextPay}`;
    }
    return card.def.desc;
  }

  function renderMachineMilestone(card) {
    const { id, name } = card.def;
    const owned = state.machines[id];
    const progress = card.milestone;
    if (progress.lastOwned === owned) return;

    const next = E.nextMilestone(owned);
    const multiplier = E.milestoneMult(next ? next.count : owned).toLocaleString('en-US');
    progress.label.textContent = next
      ? `Next bonus: ${next.count} owned → ${multiplier}× (${owned}/${next.count})`
      : `Milestones maxed: ${multiplier}×`;
    progress.track.hidden = !next;
    if (next) progress.fill.style.width = (owned / next.count * 100) + '%';

    // On the first render, quietly record thresholds already present in an older save.
    // Purchases and free hardware both trigger this same check when the count changes.
    let latestBonus = 0;
    for (const tier of E.MILESTONES) {
      if (owned < tier.count) break;
      const flag = `milestone:${id}:${tier.count}`;
      if (state.flags[flag]) continue;
      state.flags[flag] = true;
      if (progress.lastOwned === null) continue;
      latestBonus = E.milestoneMult(tier.count);
      log(`📈 ${tier.count} ${name}s! Milestone income bonus: ${latestBonus.toLocaleString('en-US')}×.`, 'big');
    }
    progress.lastOwned = owned;
    if (latestBonus) {
      // A bulk purchase can earn several tiers. Log each tier and celebrate the total once.
      feel.milestone(card.el, name, latestBonus);
    }
  }

  // Start with what this save already knows. Offline income can then reveal new items
  // on the very first frame without replaying unlock messages for the whole shop.
  function rememberRevealedItems() {
    shopStructure = '';
    shopStats = null;
    for (const card of cards) {
      card.wasRevealed = E.isRevealed(state, card.kind, card.def.id);
      card.wasAffordable = null;
      card.el.classList.remove('can-shimmer', 'reveal-flash');
    }
  }

  let displayedUnlock = null;
  function renderUnlockTeaser(next) {
    if (!next) {
      if (!el.unlockTeaser.hidden) el.unlockTeaser.hidden = true;
      displayedUnlock = null;
      return;
    }
    if (!displayedUnlock || displayedUnlock.kind !== next.kind || displayedUnlock.at !== next.at) {
      const target = next.at.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(next.at) ? 0 : 2 });
      setText(el.unlockText, `❓ New ${next.kind === 'staff' ? 'hire' : next.kind} at $${target} lifetime earnings`);
      displayedUnlock = next;
    }
    const percent = Math.min(100, Math.floor(state.lifetime / next.at * 100));
    if (el.unlockProgress.value !== percent) el.unlockProgress.value = percent;
    if (el.unlockTeaser.hidden) el.unlockTeaser.hidden = false;
  }

  let shopStructure = '';
  let shopStats = null;
  let nextUnlock = null;
  let shopMoney, shopQuantity, shopLifetime;
  const visibleCards = [];

  function refreshShopCards(st) {
    let anyUpgradeShown = false;
    let anyStaffShown = false;
    visibleCards.length = 0;
    for (const card of cards) {
      const { kind, def } = card;
      const isUpgrade = kind === 'upgrade';
      const bought = isUpgrade && state.upgrades.includes(def.id);
      const revealed = E.isRevealed(state, kind, def.id);
      if (revealed && !card.wasRevealed) {
        state.flags[card.newFlag] = true;
        if (!feel.reduced()) card.el.classList.add('reveal-flash');
        log(`🔓 Unlocked: ${def.icon} ${def.name}`, 'good');
      }
      card.wasRevealed = revealed;
      setHidden(card.row, bought || !revealed);
      setHidden(card.el, card.row.hidden);
      if (card.el.hidden) continue;
      if (isUpgrade) anyUpgradeShown = true;
      if (kind === 'staff') anyStaffShown = true;

      card.ownedCount = E.ownedCount(state, kind, def.id);
      card.eligible = E.meetsRequirements(state, def);
      let ownedLabel = isUpgrade ? '' : '×' + card.ownedCount;
      if (kind === 'staff') {
        ownedLabel = def.id === 'sibling' ? `Lv ${card.ownedCount}/${def.prices.length}` : (card.ownedCount ? 'Hired' : '');
        if (def.id === 'sysadmin') {
          if (card.ownedCount) card.el.setAttribute('aria-pressed', String(state.staff.sysadminEnabled));
          else card.el.removeAttribute('aria-pressed');
        }
      }
      setText(card.owned, ownedLabel);
      setText(card.desc, describe(card, st));
      if (kind === 'machine') renderMachineMilestone(card);
      setHidden(card.badge, !state.flags[card.newFlag]);
      visibleCards.push(card);
    }
    setHidden(el.upgradeEmpty, anyUpgradeShown);
    setHidden(el.staffHeading, !anyStaffShown);
    nextUnlock = E.nextReveal(state);

    const key = state.upgrades.join(',');
    if (key !== installedKey) {
      installedKey = key;
      el.installed.textContent = '';
      for (const id of state.upgrades) {
        const u = E.lookup('upgrade', id);
        const chip = make('span', 'chip', `${u.icon} ${u.name} · ${u.desc}`);
        el.installed.appendChild(chip);
      }
      el.installed.hidden = state.upgrades.length === 0;
    }
  }

  function renderShop(st) {
    // Taps reuse the last production snapshot. On timer ticks, inventory, location
    // and incident changes can also alter requirements or the per-unit description.
    let refresh = state.lifetime < shopLifetime || (nextUnlock != null && state.lifetime >= nextUnlock.at);
    shopLifetime = state.lifetime;
    if (shopStats !== st) {
      shopStats = st;
      const key = JSON.stringify([state.machines, state.coolers, state.upgrades, state.staff, state.location,
        state.active?.id, state.active?.side]);
      refresh = refresh || key !== shopStructure;
      shopStructure = key;
    }
    if (refresh) refreshShopCards(st);
    renderUnlockTeaser(nextUnlock);
    if (!refresh && shopMoney === state.money && shopQuantity === quantity) return;
    shopMoney = state.money;
    shopQuantity = quantity;

    for (const card of visibleCards) {
      if (card.kind === 'staff' && card.ownedCount === card.def.prices.length) {
        const toggle = card.def.id === 'sysadmin';
        card.el.disabled = !toggle;
        card.el.classList.toggle('affordable', toggle);
        setText(card.cost, toggle ? (state.staff.sysadminEnabled ? 'Auto-cooling on' : 'Auto-cooling off') : 'Max level');
        setHidden(card.shortfall, true);
        setHidden(card.funds, true);
        setHidden(card.acknowledge, true);
        card.displayedQuote = null;
        card.wasAffordable = null;
        continue;
      }
      const quote = quoteFor(card, card.ownedCount);
      if (card.displayedQuote !== quote) {
        card.displayedQuote = quote;
        setText(card.cost, quote.label);
      }
      const affordable = quote.count > 0 && state.money >= quote.total && card.eligible;
      if (affordable !== card.wasAffordable) {
        card.el.disabled = !affordable;
        card.el.classList.toggle('affordable', affordable);
        if (!affordable) card.el.classList.remove('can-shimmer');
        else if (card.wasAffordable === false && !feel.reduced()) card.el.classList.add('can-shimmer');
        setHidden(card.shortfall, affordable);
        setHidden(card.funds, affordable);
        card.wasAffordable = affordable;
      }
      setHidden(card.acknowledge, affordable || card.badge.hidden);
      if (affordable) continue;
      const needed = quote.count ? quote.total : quote.nextTotal;
      const shortfall = Math.ceil(needed - state.money);
      if (card.lastShortfall !== shortfall) {
        card.lastShortfall = shortfall;
        setText(card.shortfall, `Need ${wholeDollars.format(shortfall)} more`);
      }
      const fraction = Math.min(1000, Math.round(state.money / needed * 1000));
      if (card.fraction !== fraction) {
        card.fraction = fraction;
        card.fill.style.transform = `scaleX(${fraction / 1000})`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The room: a picture of everything you own
  // ---------------------------------------------------------------------------

  const roomGroups = new Map();
  let roomHeat, roomIncome;
  function renderRoom(st) {
    const heat = st.throttle < 1 ? 'hot' : st.load >= 0.88 ? 'warm' : 'cool';
    if (roomHeat !== heat) {
      roomHeat = heat;
      el.room.dataset.heat = heat;
      document.documentElement.classList.toggle('room-throttled', heat === 'hot');
    }
    if (roomIncome !== st.income) {
      roomIncome = st.income;
      const fanPeriod = Math.round(1800 / (1 + Math.log10(1 + st.income)));
      el.room.style.setProperty('--fan-period', fanPeriod + 'ms');
    }
    const key = JSON.stringify([state.machines, state.coolers, state.staff.sibling]);
    if (key === roomKey) return;
    const enteredRoom = !roomKey;
    if (enteredRoom) {
      el.room.replaceChildren();
      roomGroups.clear();
    }
    roomKey = key;
    for (const [bucket, list] of [['machines', MACHINES], ['coolers', COOLERS]]) {
      for (const [model, def] of list.entries()) {
        const n = state[bucket][def.id];
        let group = roomGroups.get(def.id);
        if (!n) {
          if (group) {
            group.shell.remove();
            roomGroups.delete(def.id);
          }
          continue;
        }
        if (!group) {
          el.room.querySelector('.room-empty')?.remove();
          const shell = make('div', 'room-group');
          const label = make('span', 'room-label');
          const tokens = make('span', 'room-tokens');
          const more = make('span', 'more');
          tokens.setAttribute('aria-hidden', 'true');
          more.setAttribute('aria-hidden', 'true');
          tokens.appendChild(more);
          shell.append(label, tokens);
          el.room.appendChild(shell);
          group = { shell, label, tokens, more, count: 0, shown: 0 };
          roomGroups.set(def.id, group);
        }
        if (n === group.count) continue;
        group.label.textContent = `${def.name} ×${n}`;
        const added = Math.max(0, Math.min(n - group.count, ROOM_DROP_LIMIT));
        const shown = Math.min(enteredRoom ? n : group.shown + added, n, ROOM_MAX_ICONS);
        // At the display cap, replace only the handful arriving in this purchase.
        // This gives later purchases the same entrance without accumulating layers.
        const arriving = !enteredRoom && !feel.reduced() ? Math.min(added, shown) : 0;
        const retained = Math.min(group.shown, shown - arriving);
        for (let i = retained; i < group.shown; i++) group.more.previousElementSibling.remove();
        for (let i = retained; i < shown; i++) {
          const unit = make('span', 'room-unit');
          const token = make('span', 'token', def.icon);
          if (def.id === 'fan') token.classList.add('spin');
          if (bucket === 'machines') {
            token.classList.add('machine-led');
            token.style.setProperty('--blink-period', (1600 + ((i + model) % 5) * 190) + 'ms');
            token.style.setProperty('--blink-phase', -(i * 241 + model * 157) + 'ms');
          }
          if (arriving) {
            unit.classList.add('arriving');
            unit.style.setProperty('--drop-delay', ((i - retained) * 50) + 'ms');
          }
          unit.appendChild(token);
          group.tokens.insertBefore(unit, group.more);
        }
        group.more.hidden = n === shown;
        if (n > shown) group.more.textContent = '+' + (n - shown);
        group.count = n;
        group.shown = shown;
      }
    }
    let sibling = $('room-sibling');
    if (state.staff.sibling) {
      if (!sibling) {
        el.room.querySelector('.room-empty')?.remove();
        sibling = make('div', 'room-group');
        sibling.id = 'room-sibling';
        const desk = make('span', 'sibling-desk');
        desk.setAttribute('aria-hidden', 'true');
        desk.append(make('span', 'sibling-head', '🧒'), make('span', 'sibling-hands'), make('span', 'sibling-keyboard'));
        sibling.append(make('span', 'room-label'), desk);
        el.room.appendChild(sibling);
      }
      setText(sibling.firstElementChild, `Little Sibling · Lv ${state.staff.sibling}`);
      sibling.style.setProperty('--job-period', (1 / st.siblingJobsPerSecond) + 's');
    } else {
      sibling?.remove();
      if (!roomGroups.size && !el.room.querySelector('.room-empty')) {
        el.room.appendChild(make('p', 'room-empty', 'Just a dusty floor and one outlet.'));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  function render() {
    const st = E.stats(state);
    const previous = lastStats;
    lastStats = st;
    if (purchaseUiFrame) {
      cancelAnimationFrame(purchaseUiFrame);
      purchaseUiFrame = 0;
    }
    const loc = LOCATIONS[state.location];

    feel.updateMoney(state.money, st.income);
    if (previous?.income !== st.income) setText(el.income, rate(st.income));
    if (previous?.staffIncome !== st.staffIncome) {
      setText(el.incomeSource, st.staffIncome ? `including ${rate(st.staffIncome)} from staff` : 'from machines');
    }
    if (previous?.clickValue !== st.clickValue) setText(el.jobValue, '+' + money(st.clickValue));
    if (previous?.throttle !== st.throttle || previous?.rawIncome !== st.rawIncome) {
      feel.heat(st.throttle < 1);
      setHidden(el.throttle, st.throttle >= 1);
      setHidden(el.reserve, st.throttle < 1);
      if (st.throttle < 1) {
        setText(el.throttle, `🔥 ${Math.floor(st.throttle * 100)}% speed · −${rate(st.rawIncome - st.income)} · Buy cooling.`);
      }
    }
    if (previous?.heat !== st.heat || previous?.cooling !== st.cooling) {
      const pct = Math.round(st.load * 100);
      if (st.throttle >= 1) setText(el.reserve, `Full speed · ${E.formatNumber(round1(st.cooling - st.heat))} cooling to spare`);
      setText(el.heatText, `${E.formatNumber(round1(st.heat))} heat / ${E.formatNumber(round1(st.cooling))} cooling (${pct}%)`);
      setFill(el.heatFill, st.load);
      el.heatFill.classList.toggle('warm', st.load >= 0.9 && st.load <= 1);
      el.heatFill.classList.toggle('hot', st.load > 1);
    }

    renderMoveFund();
    setText(el.location, `📍 ${loc.name}`);
    setText(el.roomTitle, loc.room);
    renderShop(st);
    renderRoom(st);
    renderIncident();
    achievementPanel.update(st);
    renderSaveStatus();
    return st;
  }

  function renderMoveFund() {
    if (state.location === 'basement') {
      setHidden(el.milestone, false);
      const earned = Math.floor(Math.min(state.lifetime, CONFIG.moveGoal));
      setText(el.milestoneText, `${wholeDollars.format(earned)} / ${moveGoalText}`);
      setFill(el.milestoneFill, E.moveProgress(state));
      setHidden(el.moveBtn, !E.canMove(state));
      el.moveBtn.classList.toggle('awaiting-tap', !el.moveBtn.hidden && !state.flags.moveChoiceSeen);
    } else {
      setHidden(el.milestone, true);
      setHidden(el.moveBtn, true);
    }
    const moveReady = !el.moveBtn.hidden;
    if (moveReady && !previousMoveReady) feel.move();
    previousMoveReady = moveReady;
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function setHidden(node, hidden) {
    if (node.hidden !== hidden) node.hidden = hidden;
  }

  // Remove finished or cancelled one-shot effects, including when switching motion
  // preferences, so a later toggle cannot replay a room entrance or an old unlock.
  const oneShots = new Map([
    ['rack-drop', 'arriving'], ['shop-shimmer', 'can-shimmer'], ['shop-reveal', 'reveal-flash'],
  ]);
  function finishOneShot(event) {
    const cls = oneShots.get(event.animationName);
    if (cls) event.target.classList.remove(cls);
  }
  document.addEventListener('animationend', finishOneShot);
  document.addEventListener('animationcancel', finishOneShot);

  function setFill(node, fraction) {
    const amount = Math.round(Math.max(0, Math.min(1, fraction)) * 10000) / 10000;
    const transform = 'scaleX(' + amount + ')';
    if (node.style.transform !== transform) node.style.transform = transform;
  }

  function renderIncident() {
    const pending = state.event;
    const incident = pending || state.active;
    if (pending !== previousOffer) {
      previousOffer = pending;
      el.incident.classList.toggle('incident-new', Boolean(pending) && !feel.reduced());
      if (pending) feel.incident();
    }
    setHidden(el.incident, !incident);
    if (!incident) return;

    const def = incidentTypes.get(incident.id);
    el.incident.classList.toggle('warning', def.id === 'heatwave');
    setText(el.incidentTitle, def.icon + ' ' + (def.id === 'heatwave' && !pending ? 'Heat wave' : def.title));
    setText(el.incidentTime, Math.ceil(incident.remaining) + 's remaining');
    const duration = pending ? CONFIG.eventOfferSeconds : def[incident.side].duration;
    setFill(incidentRemaining, incident.remaining / duration);
    setHidden(el.incidentActions, !pending);

    if (!pending) {
      setText(el.incidentDetail, 'In effect: ' + E.activeOutcome(state).summary + '.');
      return;
    }
    setText(el.incidentDetail, def.text);
    let acceptLabel = def.accept.label;
    if (pending.cash != null) acceptLabel += ' · +' + money(pending.cash);
    if (pending.price != null) acceptLabel += ' · ' + money(pending.price, 'ceil');
    if (pending.machineId) acceptLabel += ' · ' + E.lookup('machine', pending.machineId).name;
    setText(el.accept, acceptLabel);
    setText(el.decline, def.decline.label);
    el.accept.disabled = pending.price != null && state.money < pending.price;
  }

  function resolutionText(notice) {
    const def = incidentTypes.get(notice.id);
    if (notice.type === 'expired') return def.title + ' — offer expired.';
    return def.id === 'heatwave' ? 'The heat wave ended. Cooling is back to normal.' :
      'The rush job ended. The temporary income and heat boosts are over.';
  }

  function handleNotices(notices) {
    for (const notice of notices) {
      if (notice.type === 'offer') {
        const def = incidentTypes.get(notice.event.id);
        log(def.icon + ' ' + def.title, def.id === 'heatwave' ? 'warn' : 'big');
      } else if (notice.type === 'ended' || (notice.type === 'expired' && !notice.away && !notice.result?.outcome.duration)) {
        log(resolutionText(notice));
      }
    }
  }

  function answerIncident(choice) {
    const offer = state.event;
    if (!offer || suspended || document.visibilityState !== 'visible') return;
    // Settle to the click so an expired offer cannot be accepted between frames.
    updateClock(Date.now(), true, false);
    if (state.event === offer && !modalOpen()) {
      const result = E.respondToEvent(state, choice);
      if (result.ok && !state.active) {
        const label = result.outcome.label;
        log(result.def.icon + ' ' + result.def.title + ' — ' + label + '.', choice === 'accept' ? 'good' : '');
      }
    }
    render();
    save();
  }

  function renderSaveStatus() {
    if (!storageOk) {
      setText(el.saveStatus, "⚠️ This browser won't let the game save. Progress will be lost when you close the tab.");
      return;
    }
    if (!lastSavedAt) return;
    const ago = Math.floor((Date.now() - lastSavedAt) / 1000);
    setText(el.saveStatus, ago < 2 ? '💾 Saved just now' : `💾 Saved ${ago}s ago`);
  }

  // ---------------------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------------------

  function openModal(title, bodyNodes, actions, onClose) {
    el.modalTitle.textContent = title;
    el.modalBody.textContent = '';
    el.modalBody.append(...bodyNodes);
    el.modalActions.textContent = '';
    for (const a of actions) {
      const b = make('button', 'btn' + (a.style ? ' ' + a.style : ''), a.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        el.modal.close();
        if (a.onClick) a.onClick();
      });
      el.modalActions.appendChild(b);
    }
    el.modal.onclose = onClose || null;
    if (!el.modal.open) el.modal.showModal();
    const primary = el.modalActions.querySelector('.primary') || el.modalActions.lastChild;
    if (primary) primary.focus();
  }

  function para(text, cls) {
    return make('p', cls, text);
  }

  function showAway(report) {
    if (!away) away = { seconds: 0, credited: 0, earned: 0, throttleSeconds: 0, resolutions: [] };
    away.seconds += report.seconds;
    away.credited += report.credited;
    away.earned += report.earned;
    away.throttleSeconds += report.throttle * report.credited;
    for (const notice of report.notices) {
      if (notice.away) away.resolutions.push(resolutionText(notice));
    }

    const body = [
      para(`While you were away for ${E.formatDuration(away.seconds)}, your datacenter earned`),
      para(money(away.earned), 'big-number'),
      para(`Credited ${E.formatDuration(away.credited)} · Offline limit ${report.offlineCapSeconds / 3600}h`, 'muted'),
    ];
    const averageSpeed = away.credited > 0 ? away.throttleSeconds / away.credited : 1;
    if (averageSpeed < 1) {
      body.push(para(`With overheating, machines averaged ${(averageSpeed * 100).toFixed(1)}% speed during credited time.`, 'muted'));
    }
    for (const line of away.resolutions) body.push(para(line));
    if (report.earned > 0) log(`💤 While you were away (${E.formatDuration(report.seconds)}), your datacenter earned ${money(report.earned)}.`, 'good');
    openModal('Welcome back!', body, [{ label: 'Nice', style: 'primary' }], () => {
      away = null;
      state.nextEventIn = Math.max(state.nextEventIn, CONFIG.eventReturnGraceSeconds);
    });
  }

  function showMoveChoice() {
    if (!E.canMove(state)) return;
    state.flags.moveChoiceSeen = true;
    el.moveBtn.classList.remove('awaiting-tap');
    save();
    const list = make('div', 'choice-list');
    for (const id of ['warehouse', 'office']) {
      const loc = LOCATIONS[id];
      const b = make('button', 'choice');
      b.type = 'button';
      b.append(make('strong', null, `${loc.icon} ${loc.name}`), make('span', null, loc.desc));
      b.addEventListener('click', () => {
        if (!settleBeforePurchaseOrMove()) return;
        el.modal.close();
        if (E.moveTo(state, id, Date.now()).ok) {
          roomKey = '';
          render();
          checkStory(E.stats(state));
          save();
        }
      });
      list.appendChild(b);
    }
    openModal('Time to move out', [
      para(`You've reached ${moveGoalText} in lifetime earnings. Pick your new home. Both locations unlock GPU Rigs. This choice is permanent for this save.`),
      list,
    ], [{ label: 'Not yet' }]);
  }

  function confirmReset() {
    openModal('Reset everything?', [
      para('This deletes your save and starts over in the basement with $0. It cannot be undone.'),
    ], [
      { label: 'Cancel', style: 'primary' },
      { label: 'Yes, wipe it', style: 'danger', onClick: resetGame },
    ]);
  }

  function resetGame() {
    wipeSave();
    el.sysadminReceipt.hidden = true;
    priority.reset();
    achievementPanel.reset();
    state = E.newState(Date.now());
    rememberRevealedItems();
    el.log.textContent = '';
    roomKey = '';
    installedKey = null;
    for (const card of cards) {
      if (card.milestone) card.milestone.lastOwned = null;
    }
    log('🧹 Save wiped. Back to the basement.');
    const st = render();
    checkStory(st);
    save();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  el.jobBtn.addEventListener('click', (ev) => {
    const value = E.click(state, Date.now());
    const p = ev.detail || ev.pointerType ? { x: ev.clientX, y: ev.clientY } : centerOf(el.jobBtn);
    feel.tap(p.x, p.y, value);
    // A manual job changes only cash, lifetime earnings and click count. Let input
    // share one shop refresh per frame while income and heat stay on their game timer.
    if (!lastStats) { render(); return; }
    feel.updateMoney(state.money, lastStats.income);
    if (!purchaseUiFrame) purchaseUiFrame = requestAnimationFrame(() => {
      purchaseUiFrame = 0;
      if (suspended) return;
      renderShop(lastStats);
      renderMoveFund();
      achievementPanel.update(lastStats);
      if (state.event?.price != null) el.accept.disabled = state.money < state.event.price;
    });
  });
  el.jobBtn.addEventListener('contextmenu', ev => ev.preventDefault());
  el.moveBtn.addEventListener('click', showMoveChoice);
  el.resetBtn.addEventListener('click', confirmReset);
  el.accept.addEventListener('click', () => answerIncident('accept'));
  el.decline.addEventListener('click', () => answerIncident('decline'));
  for (const type of ['animationend', 'animationcancel']) {
    el.incident.addEventListener(type, event => {
      if (event.animationName === 'incident-attention') el.incident.classList.remove('incident-new');
    });
  }

  // A hidden page can keep receiving throttled intervals. Leave its saved clock anchored
  // at departure so the whole absence gets one offline cap and one welcome-back summary.
  function suspend() {
    if (suspended) return;
    suspended = true;
    achievementPanel.suspend();
    updateClock(Date.now(), false);
    save();
  }

  function resume() {
    if (!suspended || document.visibilityState !== 'visible') return;
    suspended = false;
    frame(false);
    save();
  }

  document.addEventListener('visibilitychange', () => {
    feel.visibility();
    if (document.visibilityState === 'hidden') suspend();
    else resume();
  });
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  document.addEventListener('freeze', save);

  // ---------------------------------------------------------------------------
  // Game loop
  // ---------------------------------------------------------------------------

  let receiptTimer = 0;
  function runLiveSysadmin() {
    const purchases = E.runSysadmin(state);
    if (!purchases.length) return;
    const labels = [];
    for (const { id, count } of purchases) {
      const name = E.lookup('cooler', id).name;
      for (let i = 0; i < count; i++) log(`🧑‍🔧 Sysadmin bought a ${name}.`, 'good');
      labels.push(`+${count} ${name}${count === 1 ? '' : 's'}`);
    }
    setText(el.sysadminReceipt, '🧑‍🔧 ' + labels.join(' · '));
    el.sysadminReceipt.hidden = false;
    for (const animation of el.sysadminReceipt.getAnimations()) animation.currentTime = 0;
    clearTimeout(receiptTimer);
    receiptTimer = setTimeout(() => { el.sysadminReceipt.hidden = true; }, 1800);
    save();
  }

  function updateClock(now, foreground, allowSpawn = true) {
    const gap = (now - state.lastTick) / 1000;
    const live = foreground && liveGap(gap);
    const inGame = !modalOpen();
    const report = E.catchUp(state, now, { live, countLive: live && inGame, allowSpawn: allowSpawn && inGame });
    handleNotices(report.notices);
    if (report.seconds >= AWAY_NOTICE_SECONDS) showAway(report);
    if (live && inGame && gap > 0 && state.staff.sysadmin && state.staff.sysadminEnabled) runLiveSysadmin();
    priority.tick(now, live, gap, allowSpawn);
  }

  function liveGap(seconds) {
    return !suspended && document.visibilityState === 'visible' && seconds >= 0 && seconds <= CONFIG.eventLiveGapSeconds;
  }

  function modalOpen() { return el.modal.open || achievementPanel.isOpen(); }

  // A click can arrive ahead of the first timer after sleep. Pay for elapsed time
  // at the old production rate before a purchase or move changes that rate.
  function settleBeforePurchaseOrMove() {
    if (suspended || document.visibilityState !== 'visible') return false;
    updateClock(Date.now(), true);
    if (!away) return true;
    render();
    save();
    return false;
  }

  function frame(foreground = true) {
    if (suspended || document.visibilityState !== 'visible') return;
    updateClock(Date.now(), foreground);
    const st = render();
    checkStory(st);
    if (Date.now() - lastSavedAt >= SAVE_EVERY_MS) save();
  }

  function start() {
    buildShop();
    requestPersistentStorage();
    const saved = readSave();
    state = saved ? E.deserialize(saved, Date.now()) : E.newState(Date.now());
    previousOffer = state.event;
    previousMoveReady = E.canMove(state);
    rememberRevealedItems();
    if (saved) log('💾 Save loaded. Welcome back.');
    suspended = document.visibilityState !== 'visible';
    frame(false); // opening a save always settles elapsed time as an absence
    setInterval(frame, FRAME_MS);

    // Small hook for debugging and playtesting from the browser console.
    window.game = {
      get state() { return state; },
      give(amount) { state.money += amount; state.lifetime += amount; render(); },
      skip(seconds) { state.lastTick -= seconds * 1000; },  // pretend you were away
      spawnBonus: priority.force,
      save, reset: resetGame,
    };
  }

  function createAchievementPanel({ state, feel, log, save }) {
    const opener = $('achievements-btn');
    const dialog = $('achievements-dialog');
    const count = $('achievement-count');
    const summary = $('trophy-total');
    const tabs = [$('achievements-tab'), $('stats-tab')];
    const views = [$('achievements-view'), $('stats-view')];
    const grid = $('achievement-grid');
    const statsList = $('stats-list');
    const toast = $('achievement-toast');
    const byId = new Map(E.ACHIEVEMENTS.map(def => [def.id, def]));
    const badges = [];
    const statCells = [];
    const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    const cash = value => '$' + whole.format(Math.floor(value));
    const statRows = [
      ['lifetime', 'Lifetime earnings', s => cash(s.lifetime)],
      // Prices are whole dollars. Parallel fractional earnings can leave the
      // subtraction a fraction of a cent below the amount actually spent.
      ['moneySpent', 'Money spent', s => '$' + whole.format(Math.max(0, s.lifetime - s.money))],
      ['clicks', 'Jobs by hand', s => whole.format(s.clicks)],
      ['clickValue', 'Pay per job', (_s, st) => money(st.clickValue)],
      ['siblingJobs', 'Jobs by Little Sibling', s => whole.format(Math.floor(s.counters.siblingJobs))],
      ['staffIncome', 'Little Sibling income/s', (_s, st) => rate(st.staffIncome)],
      ['sysadminPurchases', 'Sysadmin cooling purchases', s => whole.format(s.counters.sysadminPurchases)],
      ['liveSeconds', 'Time played', s => E.formatDuration(s.counters.liveSeconds)],
      ['machinesBought', 'Machines bought', s => whole.format(s.counters.machinesBought)],
      ['coolersBought', 'Coolers bought', s => whole.format(s.counters.coolersBought)],
      ['highestIncome', 'Highest income/s', s => E.formatRate(s.counters.highestIncome)],
      ['incidentsHandled', 'Incidents handled', s => whole.format(s.counters.incidentsAccepted + s.counters.incidentsDeclined)],
      ['bonusesCaught', 'Bonuses caught', s => whole.format(s.counters.bonusesCaught)],
      ['bonusesMissed', 'Bonuses missed', s => whole.format(s.counters.bonusesMissed)],
      ['bonusCashEarned', 'Bonus cash earned', s => cash(s.counters.bonusCashEarned)],
      ['timeToMove', 'Time to move-out', s => {
        if (s.location === 'basement') return 'Not yet';
        return s.counters.moveTimeRecorded
          ? E.formatDuration(s.counters.timeToMove) : 'Not recorded';
      }],
    ];
    let activeTab = 0;
    let displayedCount = -1;
    let nextPaint = 0;
    let toastTimer = 0;

    function showCount(unlocked) {
      if (displayedCount === unlocked) return;
      displayedCount = unlocked;
      const total = byId.size;
      setText(count, unlocked + '/' + total);
      setText(summary, unlocked + ' of ' + total + ' unlocked');
      opener.setAttribute('aria-label', 'Achievements and stats, ' + summary.textContent);
    }

    function buildViews() {
      if (badges.length) return;
      const badgeItems = document.createDocumentFragment();
      for (const def of E.ACHIEVEMENTS) {
        const item = make('li', 'achievement-badge');
        item.dataset.achievement = def.id;
        const icon = make('span', 'badge-icon');
        icon.setAttribute('aria-hidden', 'true');
        const copy = make('div', 'badge-copy');
        const name = make('h3', 'badge-name');
        const desc = make('p', 'badge-desc');
        copy.append(name, desc);
        let bar = null;
        if (def.progress) {
          bar = make('progress', 'badge-progress');
          bar.max = 100;
          copy.appendChild(bar);
        }
        item.append(icon, copy);
        badgeItems.appendChild(item);
        badges.push({ def, item, icon, name, desc, bar });
      }
      grid.appendChild(badgeItems);
      for (const [id, label, read] of statRows) {
        const row = make('div', 'trophy-stat');
        const value = make('dd');
        value.dataset.stat = id;
        row.append(make('dt', null, label), value);
        statsList.appendChild(row);
        statCells.push({ value, read });
      }
    }

    function paintView(s, st) {
      if (activeTab === 1) {
        for (const { value, read } of statCells) setText(value, read(s, st));
        return;
      }
      const earned = new Set(s.achievements);
      for (const badge of badges) {
        const { def, item, name, desc, icon, bar } = badge;
        const unlocked = earned.has(def.id);
        if (badge.unlocked !== unlocked) {
          badge.unlocked = unlocked;
          const secret = def.hidden && !unlocked;
          item.classList.toggle('is-unlocked', unlocked);
          setText(icon, secret ? '?' : def.icon);
          setText(name, secret ? '???' : def.name);
          setText(desc, secret ? 'Hidden achievement' : def.desc);
          name.setAttribute('aria-label', name.textContent + (unlocked ? ', unlocked' : ', locked'));
          if (bar) {
            bar.hidden = unlocked || Boolean(secret);
            if (!bar.hidden) bar.setAttribute('aria-label', def.name + ' progress');
            else bar.removeAttribute('aria-label');
          }
        }
        if (bar && !bar.hidden) {
          const percent = Math.floor(100 * Math.min(1, Math.max(0, def.progress(s, st))));
          if (bar.value !== percent || !bar.hasAttribute('value')) bar.value = percent;
        }
      }
    }

    function selectTab(index, focus) {
      activeTab = index;
      for (let i = 0; i < tabs.length; i++) {
        const selected = i === index;
        tabs[i].setAttribute('aria-selected', String(selected));
        tabs[i].tabIndex = selected ? 0 : -1;
        views[i].hidden = !selected;
      }
      const s = state();
      paintView(s, E.stats(s));
      nextPaint = performance.now() + 500;
      if (focus) tabs[index].focus({ preventScroll: true });
    }

    function positionToast() {
      // A native dialog sits above the page. Keep the same live region visible
      // when a returning player unlocks achievements over the welcome dialog.
      const host = document.activeElement?.closest('dialog[open]') || document.querySelector('dialog[open]') || document.body;
      if (toast.parentNode !== host) host.appendChild(toast);
    }

    function hideToast() {
      clearTimeout(toastTimer);
      toastTimer = 0;
      toast.classList.remove('is-visible');
      setText($('achievement-toast-text'), '');
      setText($('achievement-toast-icon'), '');
    }

    function notify(ids) {
      const defs = ids.map(id => byId.get(id));
      const single = defs.length === 1;
      const title = single ? 'Achievement unlocked: ' + defs[0].name : defs.length + ' achievements unlocked';
      const icon = single ? defs[0].icon : '🏆';
      const entry = single ? icon + ' ' + title : icon + ' ' + title + ': ' + defs.map(def => def.name).join(', ');
      log(entry, 'good');
      feel.purchase(1);
      positionToast();
      setText($('achievement-toast-icon'), icon);
      setText($('achievement-toast-text'), title);
      toast.classList.add('is-visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 3600);
    }

    function update(st) {
      const s = state();
      const ids = E.newAchievements(s, st);
      if (ids.length) {
        s.achievements.push(...ids);
        save();
        notify(ids);
      }
      showCount(s.achievements.length);
      if (!dialog.open) return;
      const now = performance.now();
      if (ids.length || now >= nextPaint) {
        nextPaint = now + 500;
        paintView(s, st);
      }
    }

    opener.addEventListener('click', () => {
      if (dialog.open) return;
      buildViews();
      dialog.showModal();
      selectTab(0, true);
      if (toastTimer) positionToast();
    });
    $('achievements-close').addEventListener('click', () => dialog.close());
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => selectTab(index, false));
      tab.addEventListener('keydown', event => {
        let target;
        if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = tabs.length - 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = 1 - index;
        else return;
        event.preventDefault();
        selectTab(target, true);
      });
    }
    document.addEventListener('close', event => {
      if (toast.parentNode === event.target) positionToast();
    }, true);

    function reset() {
      hideToast();
      if (dialog.open) dialog.close();
      displayedCount = -1;
      nextPaint = 0;
      for (const view of views) view.scrollTop = 0;
    }
    return { update, isOpen: () => dialog.open, suspend: hideToast, reset };
  }

  // The offer lives only in this page. The room and the economy can update
  // independently while the button crosses its own clipped layer.
  function createPriorityRequest() {
    const { durationSeconds, returnGraceSeconds } = E.BONUS;
    const track = $('priority-track'), button = $('priority-request'), receipt = $('priority-receipt');
    let grace = returnGraceSeconds, endsAt = 0, flight = null, receiptTimer = 0;

    function withdraw() {
      endsAt = 0;
      button.hidden = track.hidden = true;
      button.classList.remove('priority-active');
      flight?.cancel();
      flight = null;
    }
    function spawn(now) {
      if (endsAt || grace > 0 || modalOpen() || E.machineCount(state) === 0) return false;
      endsAt = now + durationSeconds * 1000;
      E.markBonusAppeared(state);
      state.priorityWaitSeconds = E.nextBonusGap(state);
      track.hidden = button.hidden = false;
      button.classList.add('priority-active');
      // The track is one button-width shorter than the room. Percentage transforms
      // remain inside it after a resize. Reduced mode retains the linear travel.
      flight = track.animate([
        { transform: 'translateX(0)', opacity: 1 },
        { transform: 'translateX(94%)', opacity: 1, offset: 0.94 },
        { transform: 'translateX(100%)', opacity: 0 },
      ], { duration: durationSeconds * 1000, easing: 'linear', fill: 'forwards' });
      save(); // Reloading during the flight must not replay the discovery request.
      return true;
    }
    function tick(now, live, gap, allowSpawn) {
      if (!live || modalOpen()) {
        if (endsAt) withdraw();
        if (!live) grace = returnGraceSeconds;
        return;
      }
      grace = Math.max(0, grace - gap);
      if (E.machineCount(state) === 0) return;
      // The first machine starts the clock. Only eligible live seconds use up a gap.
      const remaining = state.priorityWaitSeconds ?? E.nextBonusGap(state);
      state.priorityWaitSeconds = Math.max(0, remaining - gap);
      if (endsAt && now >= endsAt) {
        withdraw();
        E.missBonus(state);
        save();
      }
      if (allowSpawn && state.priorityWaitSeconds === 0) spawn(now);
    }
    function force() {
      const now = Date.now();
      return liveGap((now - state.lastTick) / 1000) && spawn(now);
    }
    function reset() {
      withdraw();
      grace = returnGraceSeconds;
      clearTimeout(receiptTimer);
      receipt.textContent = '';
    }
    button.addEventListener('click', event => {
      if (!endsAt || modalOpen() || suspended || document.visibilityState !== 'visible') return;
      // Settle time at the old rate and let a late input expire before rolling a reward.
      updateClock(Date.now(), true, false);
      if (!endsAt) return;
      const p = event.detail || event.pointerType ? { x: event.clientX, y: event.clientY } : centerOf(button);
      withdraw();
      const reward = E.claimBonus(state);
      const jackpot = reward.tier === 'jackpot';
      const label = '+' + wholeDollars.format(reward.amount) + (jackpot ? ' JACKPOT!' : ' PRIORITY!');
      feel.priorityReward(p, label, jackpot);
      if (feel.reduced()) {
        receipt.classList.toggle('jackpot', jackpot);
        receipt.textContent = label;
        clearTimeout(receiptTimer);
        receiptTimer = setTimeout(() => { receipt.textContent = ''; }, 1500);
      }
      log('⚡ Priority request · ' + label, jackpot ? 'big' : 'good');
      render();
      save();
    });
    return { tick, force, reset };
  }

  // Presentation only. Actions report what happened after the economy has updated.
  function createFeel() {
    const id = (name) => document.getElementById(name);
    const money = id('money');
    const job = id('job-btn');
    const flow = id('income-flow');
    const streakLabel = id('tap-streak');
    const streakMeter = id('streak-meter');
    const banner = id('moment-banner');
    const canvas = id('fx-canvas');
    const ctx = canvas.getContext('2d');
    const effectsButton = id('effects-toggle');
    const soundButton = id('sound-toggle');
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const moneyText = window.Economy.formatMoney;
    const rollMs = 300, pulseGapMs = 250, streakMs = 1500, bannerMs = 1500;
    const particleCap = 150, slowFrameMs = 22, voiceCap = 8, heatToneGapMs = 10000;
    const colors = ['#6be9a8', '#a4efff', '#ffda89', '#eee9ff'];
    const effectsKey = 'basement-datacenter.effects', soundKey = 'basement-datacenter.sound';
    function read(key, fallback) {
      try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    }
    function store(key, value) {
      try { localStorage.setItem(key, value); } catch { /* Preferences still work for this session. */ }
    }
    let motionPreference = read(effectsKey, 'full');
    let sound = read(soundKey, 'on') !== 'off';
    const reduced = () => media.matches || motionPreference === 'reduced';
    const hidden = () => document.visibilityState !== 'visible';

    let audio, master, interacted = false;
    const voices = new Map();
    function openAudio() {
      if (!sound || !interacted || hidden()) return;
      try {
        if (!audio) {
          const Audio = window.AudioContext || window.webkitAudioContext;
          if (!Audio) return;
          audio = new Audio();
          master = audio.createGain();
          master.gain.value = 0.25;
          master.connect(audio.destination);
        }
        if (audio.state === 'suspended') audio.resume().catch(() => {});
      } catch { /* A browser may not grant an audio device. */ }
    }
    function unlockAudio(event) {
      if (!event.isTrusted) return;
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      interacted = true;
      openAudio();
    }
    document.addEventListener('pointerup', unlockAudio, { capture: true, passive: true });
    document.addEventListener('keydown', unlockAudio, { capture: true });
    function silence() {
      for (const [voice, envelope] of voices) {
        voice.onended = null;
        try { voice.stop(); } catch { /* The voice has already ended. */ }
        voice.disconnect(); envelope.disconnect();
      }
      voices.clear();
      if (audio && audio.state === 'running') audio.suspend().catch(() => {});
    }
    // Each oscillator has its own short envelope. Future arpeggio notes also reserve a voice.
    function note(hz, seconds, amplitude, wave = 'sine', delay = 0, endHz = hz) {
      if (!sound || hidden() || !audio || audio.state !== 'running' || voices.size >= voiceCap) return;
      const osc = audio.createOscillator(), envelope = audio.createGain();
      const start = audio.currentTime + delay, end = start + seconds;
      osc.type = wave;
      osc.frequency.setValueAtTime(hz, start);
      osc.frequency.exponentialRampToValueAtTime(endHz, end);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(amplitude, start + Math.min(0.008, seconds / 4));
      envelope.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(envelope); envelope.connect(master);
      voices.set(osc, envelope);
      osc.onended = () => { voices.delete(osc); osc.disconnect(); envelope.disconnect(); };
      osc.start(start); osc.stop(end + 0.005);
    }
    function vibrate(ms) {
      if (sound && interacted && !hidden() && navigator.vibrate && navigator.userActivation?.hasBeenActive !== false) {
        try { navigator.vibrate(ms); } catch { /* Unsupported or denied. */ }
      }
    }

    const motions = new Map();
    function animate(node, frames, options) {
      if (!node || reduced() || hidden() || !node.animate) return;
      motions.get(node)?.cancel();
      const animation = node.animate(frames, options);
      motions.set(node, animation);
      animation.onfinish = () => { if (motions.get(node) === animation) motions.delete(node); };
    }
    function stopMotions() {
      for (const animation of motions.values()) animation.cancel();
      motions.clear();
    }

    const particles = [];
    const tileSize = 16, bitTiles = 12, paperAngles = 8;
    const labels = new Map();
    const patchGrid = 48, patchPadding = 12, slowPaintMs = 1000 / 30;
    let atlas, width = 0, height = 0, originX = 0, originY = 0;
    let viewportWidth = 0, viewportHeight = 0, resizeNeeded = true, patchDirty = true;
    let left = 0, top = 0, right = 0, bottom = 0;
    let frameId = 0, lastFrame = 0, slowScore = 0, nextPaint = 0;
    let from = 0, target = null, changeAt = 0, rolling = false, lastPulse = -Infinity;
    let lastDollar = NaN, lastIncome = NaN;
    let lastTap = -Infinity, streak = 0, lastHeatTone = -Infinity, wasHot = false;
    let bannerTimer = 0, streakTimer = 0;
    streakMeter.style.transformOrigin = 'left center';
    function requestFrame() {
      if (!hidden() && !frameId) frameId = requestAnimationFrame(frame);
    }
    window.addEventListener('resize', () => {
      resizeNeeded = patchDirty = true;
      if (particles.length) { nextPaint = 0; requestFrame(); }
    }, { passive: true });
    function eraseDrawing() {
      if (ctx && right > left && bottom > top) ctx.clearRect(left, top, right - left, bottom - top);
      left = width; top = height; right = bottom = 0;
    }
    function clearCanvas() {
      particles.length = 0;
      eraseDrawing();
      canvas.hidden = true;
      patchDirty = true;
      nextPaint = 0;
    }
    function qualityDivisor() { return slowScore >= 6 ? 4 : slowScore >= 2 ? 2 : 1; }
    function particleRoom() { return Math.floor(particleCap / qualityDivisor()); }

    function addParticle(p) {
      // Save the whole sprite's flight bounds once, including the apex of its arc.
      const endX = p.x + p.vx * p.life;
      const apex = p.gravity ? Math.min(p.life, Math.max(0, -p.vy / p.gravity)) : p.life;
      const yAt = t => p.y + (p.vy + p.gravity * t / 2) * t;
      p.minX = Math.min(p.x, endX) - p.w / 2;
      p.maxX = Math.max(p.x, endX) + p.w / 2;
      p.minY = Math.min(p.y, yAt(apex)) - p.h / 2;
      p.maxY = Math.max(p.y, yAt(p.life)) + p.h / 2;
      particles.push(p);
      patchDirty = true;
    }
    function fitPatch() {
      if (!patchDirty) return;
      patchDirty = false;
      if (resizeNeeded) {
        resizeNeeded = false;
        viewportWidth = document.documentElement.clientWidth;
        viewportHeight = window.innerHeight;
      }
      let x1 = viewportWidth, y1 = viewportHeight, x2 = 0, y2 = 0;
      for (const p of particles) {
        if (p.maxX <= 0 || p.maxY <= 0 || p.minX >= viewportWidth || p.minY >= viewportHeight) continue;
        x1 = Math.min(x1, p.minX); y1 = Math.min(y1, p.minY);
        x2 = Math.max(x2, p.maxX); y2 = Math.max(y2, p.maxY);
      }
      if (x1 >= x2 || y1 >= y2) { canvas.hidden = true; return; }
      const x = Math.max(0, Math.floor((x1 - patchPadding) / patchGrid) * patchGrid);
      const y = Math.max(0, Math.floor((y1 - patchPadding) / patchGrid) * patchGrid);
      const endX = Math.min(viewportWidth, Math.ceil((x2 + patchPadding) / patchGrid) * patchGrid);
      const endY = Math.min(viewportHeight, Math.ceil((y2 + patchPadding) / patchGrid) * patchGrid);
      const w = endX - x, h = endY - y;
      // A little spare space prevents reallocations as fingertips and random trajectories move.
      // Release a large patch once a simultaneous celebration at a different origin ends.
      const fits = originX <= Math.max(0, x1) && originY <= Math.max(0, y1) &&
        originX + width >= Math.min(viewportWidth, x2) && originY + height >= Math.min(viewportHeight, y2);
      const inside = originX + width <= viewportWidth && originY + height <= viewportHeight;
      if (!fits || !inside || width * height > w * h * 2) {
        eraseDrawing();
        originX = x; originY = y;
        if (width !== w) width = canvas.width = w;
        if (height !== h) height = canvas.height = h;
        canvas.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      }
      if (canvas.hidden) canvas.hidden = false;
    }

    // Rasterize the bit glyphs and rotating paper shapes once. Every frame uses integer sprite blits.
    function sprites() {
      if (atlas) return atlas;
      atlas = document.createElement('canvas');
      atlas.width = (bitTiles + colors.length * paperAngles) * tileSize;
      atlas.height = tileSize;
      const g = atlas.getContext('2d');
      g.font = 'bold 12px monospace'; g.textAlign = 'center';
      for (let i = 0; i < bitTiles; i++) {
        g.fillStyle = colors[i % colors.length];
        g.fillText('10$'[i % 3], i * tileSize + tileSize / 2, 12);
      }
      for (let c = 0; c < colors.length; c++) {
        g.fillStyle = colors[c];
        for (let a = 0; a < paperAngles; a++) {
          const tile = bitTiles + c * paperAngles + a;
          g.save();
          g.translate((tile + 0.5) * tileSize, tileSize / 2);
          g.rotate(a * Math.PI / paperAngles);
          g.fillRect(-3, -1.5, 6, 3);
          g.restore();
        }
      }
      return atlas;
    }
    function labelSprite(text, color, size) {
      const key = size + color + text;
      let sprite = labels.get(key);
      if (sprite) return sprite;
      sprite = document.createElement('canvas');
      sprite.width = Math.ceil(text.length * size * 0.67) + 4;
      sprite.height = size + 7;
      const g = sprite.getContext('2d');
      g.font = 'bold ' + size + 'px monospace'; g.textAlign = 'center'; g.fillStyle = color;
      g.fillText(text, sprite.width / 2, size + 1);
      // Tap values recur. Shop prices vary, so bound the retained label images.
      if (labels.size >= 24) labels.delete(labels.keys().next().value);
      labels.set(key, sprite);
      return sprite;
    }
    function burst(x, y, count, confetti = false) {
      if (!ctx || reduced() || hidden()) return;
      const limit = particleRoom();
      const n = Math.min(limit - particles.length, Math.ceil(count / qualityDivisor()));
      const image = sprites();
      const born = performance.now();
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const speed = confetti ? 65 + Math.random() * 230 : 35 + Math.random() * 90;
        addParticle({ x, y, born, vx: Math.cos(a) * speed, vy: -Math.abs(Math.sin(a)) * speed - 30,
          life: confetti ? 0.75 + Math.random() * 0.55 : 0.38 + Math.random() * 0.27,
          image, w: tileSize, h: tileSize, gravity: confetti ? 260 : 80,
          tile: confetti ? bitTiles + (i % colors.length) * paperAngles : i % bitTiles,
          spin: confetti ? 1 + Math.floor(Math.random() * paperAngles) : 0 });
      }
      requestFrame();
    }
    function floatLabel(x, y, text, color, size = 18, life = 0.65) {
      if (!ctx || reduced() || hidden()) return;
      if (particles.length >= particleRoom()) particles.shift();
      const image = labelSprite(text, color, size);
      const half = image.width / 2;
      x = Math.max(half, Math.min(window.innerWidth - half, x));
      addParticle({ x, y, vx: 0, vy: -48, born: performance.now(), life,
        image, w: image.width, h: image.height, gravity: 0, tile: 0, spin: 0 });
      requestFrame();
    }
    function drawParticles(now) {
      if (!ctx || !particles.length) return;
      fitPatch();
      eraseDrawing();
      for (let i = particles.length - 1; i >= 0; --i) {
        const p = particles[i];
        const age = Math.max(0, now - p.born) / 1000;
        if (age >= p.life) { particles.splice(i, 1); patchDirty = true; continue; }
        if (canvas.hidden) continue;
        const x = Math.round(p.x + p.vx * age - originX - p.w / 2);
        const y = Math.round(p.y + (p.vy + p.gravity * age / 2) * age - originY - p.h / 2);
        if (x >= width || y >= height || x + p.w <= 0 || y + p.h <= 0) continue;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x + p.w); bottom = Math.max(bottom, y + p.h);
        ctx.globalAlpha = Math.min(1, (p.life - age) / (p.life * 0.45));
        const tile = p.tile + (p.spin ? (p.spin + Math.floor(age * 15)) % paperAngles : 0);
        ctx.drawImage(p.image, tile * tileSize, 0, p.w, p.h, x, y, p.w, p.h);
      }
      ctx.globalAlpha = 1;
      if (!particles.length) { canvas.hidden = true; nextPaint = 0; }
    }
    function moneyAt(now) {
      const progress = Math.min(1, Math.max(0, (now - changeAt) / rollMs));
      return progress === 1 ? target : target + (from - target) * (1 - progress) ** 3;
    }
    function paintMoney(value) {
      const dollar = Math.floor(value);
      if (lastDollar === dollar) return;
      lastDollar = dollar;
      const text = moneyText(value);
      if (money.textContent !== text) money.textContent = text;
    }
    function frame(now) {
      frameId = 0;
      if (hidden()) return;
      const elapsed = lastFrame ? now - lastFrame : 0;
      if (lastFrame) slowScore = Math.max(0, Math.min(12, slowScore + (elapsed > slowFrameMs ? 2 : -0.25)));
      lastFrame = now;
      if (particles.length > particleRoom()) {
        particles.splice(0, particles.length - particleRoom()); patchDirty = true;
      }
      if (particles.length && (slowScore < 3 || now + 1 >= nextPaint)) {
        // A missed draw never slows down the flight or the balance animation. Keep a stable
        // 30Hz cadence on a busy device; draw on every animation frame when it keeps up.
        nextPaint = slowScore < 3 || !nextPaint || now - nextPaint >= slowPaintMs
          ? now + slowPaintMs : nextPaint + slowPaintMs;
        drawParticles(now);
      }
      if (rolling) {
        paintMoney(moneyAt(now));
        rolling = now - changeAt < rollMs;
      }
      if (particles.length || rolling) requestFrame();
      else lastFrame = 0;
    }
    function updateMoney(value, income) {
      const now = performance.now();
      if (target === null || hidden()) {
        from = target = value; rolling = false; paintMoney(value);
      } else if (target !== value) {
        const previous = target;
        from = rolling ? moneyAt(now) : target;
        target = value; changeAt = now; rolling = true;
        if (value > previous && value - previous >= previous * 0.1 && now - lastPulse >= pulseGapMs) {
          lastPulse = now;
          animate(money, [{ transform: 'scale(1)' }, { transform: 'scale(1.055)', offset: 0.35 },
            { transform: 'scale(1)' }], { duration: 215, easing: 'ease-out' });
        }
        requestFrame();
      }
      if (lastIncome !== income) {
        lastIncome = income;
        const period = (2.4 / (1 + Math.log10(1 + income) * 0.65)).toFixed(2) + 's';
        flow.style.setProperty('--flow-period', period);
        flow.classList.toggle('flowing', income > 0);
      }
    }
    function clearStreak() {
      clearTimeout(streakTimer);
      streak = 0; lastTap = -Infinity;
      job.classList.remove('has-streak');
      streakLabel.textContent = '';
    }
    function tap(x, y, amount = 1) {
      if (hidden()) return;
      const now = performance.now();
      streak = now - lastTap < streakMs ? streak + 1 : 1;
      lastTap = now;
      if (streak > 1) {
        job.classList.add('has-streak');
        streakLabel.textContent = '×' + streak + ' streak!';
        animate(streakMeter, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
          { duration: streakMs, easing: 'linear' });
      }
      clearTimeout(streakTimer);
      streakTimer = setTimeout(clearStreak, streakMs);
      animate(job, [{ transform: 'scale(.978, .956)' }, { transform: 'scale(1.007, 1.018)', offset: 0.55 },
        { transform: 'scale(1)' }], { duration: 190, easing: 'ease-out' });
      floatLabel(x, y - 6, '+' + moneyText(amount), '#c3ffdb');
      burst(x, y, 8);
      const pitch = 580 + Math.min(streak, 20) * 9 + Math.random() * 42;
      note(pitch, 0.045, 0.12, 'triangle', 0, pitch * 0.64);
      requestFrame();
    }
    function center(node) {
      const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function spend(card, amount, willDisappear) {
      if (reduced() || hidden()) return;
      const bounds = card.getBoundingClientRect();
      floatLabel(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2,
        '−' + moneyText(amount, 'ceil'), '#ffb69b');
      // Installing an upgrade removes its real button on this render. Let its image
      // finish the same purchase feedback without holding space or intercepting a tap.
      let surface = card;
      if (willDisappear) {
        surface = card.cloneNode(true);
        surface.classList.add('installed-card-pop');
        surface.inert = true;
        surface.setAttribute('aria-hidden', 'true');
        Object.assign(surface.style, { left: bounds.left + 'px', top: bounds.top + 'px',
          width: bounds.width + 'px', height: bounds.height + 'px' });
        document.body.appendChild(surface);
        setTimeout(() => surface.remove(), 215);
      }
      animate(surface, [{ transform: 'scale(.987)' }, { transform: 'scale(1.012)', offset: 0.45 },
        { transform: 'scale(1)' }], { duration: 215, easing: 'ease-out' });
    }
    function purchase(count) {
      note(659, 0.11, 0.13, 'sine');
      note(count > 1 ? 1046 : 880, count > 1 ? 0.21 : 0.13, 0.095, 'sine', 0.054);
      vibrate(8);
    }
    function priorityReward(point, label, jackpot) {
      burst(point.x, point.y, jackpot ? 72 : 24, jackpot);
      floatLabel(point.x, point.y - 12, label, jackpot ? '#ffdd79' : '#b0ffe2', jackpot ? 23 : 18, 1.35);
      if (jackpot) {
        [523, 659, 784, 1046, 1568].forEach((hz, i) => note(hz, .21, .12, 'triangle', i * .07));
      } else {
        note(784, .12, .12); note(1175, .18, .10, 'sine', .07);
      }
      vibrate(jackpot ? 35 : 16);
    }
    function showMoment(text, bigger) {
      if (hidden()) return;
      clearTimeout(bannerTimer);
      banner.textContent = text;
      banner.classList.toggle('move-moment', bigger);
      banner.classList.add('moment-visible');
      animate(banner, [
        { opacity: 0, transform: 'translate(-50%, calc(-50% + 12px)) scale(.98)' },
        { opacity: 1, transform: 'translate(-50%, -50%)', offset: 0.14 },
        { opacity: 1, transform: 'translate(-50%, -50%)', offset: 0.82 },
        { opacity: 0, transform: 'translate(-50%, calc(-50% - 7px))', offset: 1 },
      ], { duration: bannerMs, easing: 'ease-out' });
      bannerTimer = setTimeout(() => banner.classList.remove('moment-visible'), bannerMs);
    }
    function shake() {
      const layout = document.querySelector('.layout');
      animate(layout, [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' },
        { transform: 'translateY(2px)' }, { transform: 'translateY(-1px)' }, { transform: 'translateY(0)' }],
      { duration: 155, easing: 'ease-out' });
    }
    const machineLabels = { 'Old Laptop': 'LAPTOPS', 'Desktop Tower': 'TOWERS', 'Rack Server': 'RACK SERVERS', 'GPU Rig': 'GPU RIGS' };
    function milestone(card, machineName, multiplier) {
      const p = center(card);
      burst(p.x, p.y, 48, true);
      showMoment('📈 ' + (machineLabels[machineName] || machineName.toUpperCase()) + ' ' + multiplier.toLocaleString('en-US') + '×!', false);
      shake();
      [523, 659, 784, 1046].forEach((hz, i) => note(hz, 0.15, 0.12, 'triangle', i * 0.062));
      vibrate(26);
    }
    function move() {
      burst(window.innerWidth * 0.5, window.innerHeight * 0.55, 88, true);
      showMoment('🚚 Move-out unlocked!', true);
      shake();
      [523, 659, 784, 1046, 1319].forEach((hz, i) => note(hz, 0.21, 0.105, 'triangle', i * 0.073));
    }
    function incident() {
      note(466, 0.085, 0.1, 'sine'); note(622, 0.14, 0.095, 'sine', 0.105);
      vibrate(18);
    }
    function heat(throttled) {
      const now = performance.now();
      if (throttled && !wasHot && now - lastHeatTone >= heatToneGapMs) {
        note(139, 0.20, 0.15, 'triangle', 0, 96);
        lastHeatTone = now;
      }
      wasHot = throttled;
    }
    function syncPrefs() {
      const reducedMotion = reduced();
      document.body.classList.toggle('effects-reduced', reducedMotion);
      effectsButton.textContent = 'Effects: ' + (reducedMotion ? 'Reduced' : 'Full');
      effectsButton.setAttribute('aria-pressed', String(reducedMotion));
      effectsButton.setAttribute('aria-label', media.matches ? 'Reduced effects follow your device motion setting' : 'Reduced visual effects');
      effectsButton.disabled = media.matches;
      soundButton.textContent = sound ? '🔊' : '🔇';
      soundButton.setAttribute('aria-label', 'Sound and haptics');
      soundButton.setAttribute('aria-pressed', String(sound));
      if (reducedMotion) { clearCanvas(); stopMotions(); }
    }
    function toggleEffects() {
      if (media.matches) return;
      motionPreference = reduced() ? 'full' : 'reduced';
      store(effectsKey, motionPreference); syncPrefs();
    }
    function toggleSound() {
      sound = !sound;
      store(soundKey, sound ? 'on' : 'off'); syncPrefs();
      if (sound) openAudio(); else silence();
    }
    function visibility() {
      document.body.classList.toggle('effects-paused', hidden());
      if (hidden()) {
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0; lastFrame = 0; slowScore = 0; rolling = false;
        if (target !== null) paintMoney(target);
        clearStreak(); clearCanvas(); stopMotions(); silence();
        clearTimeout(bannerTimer); banner.classList.remove('moment-visible');
      } else if (audio && sound && interacted) openAudio();
    }
    effectsButton.addEventListener('click', toggleEffects);
    soundButton.addEventListener('click', toggleSound);
    if (media.addEventListener) media.addEventListener('change', syncPrefs);
    else media.addListener(syncPrefs);
    clearCanvas(); syncPrefs(); visibility();
    return { reduced, updateMoney, tap, spend, purchase, priorityReward, milestone, move, incident, heat, visibility, toggleEffects, toggleSound, syncPrefs };
  }

  const feel = createFeel();
  const priority = createPriorityRequest();
  const achievementPanel = createAchievementPanel({ state: () => state, feel, log, save });
  start();
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    // Chrome blocks manifest fetches for file:// copies of the game.
    const manifest = document.querySelector('link[rel="manifest"]');
    manifest.href = manifest.dataset.href;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // The game can still run online if the browser disables offline storage.
      });
    }
  }
})();
