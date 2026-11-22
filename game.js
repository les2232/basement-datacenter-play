/*
 * Basement Datacenter: the page.
 *
 * economy.js decides the rules; this file shows them on screen, reacts to clicks,
 * tells the story, and saves to the browser's localStorage.
 */
(function () {
  'use strict';

  const E = window.Economy;
  const { MACHINES, COOLERS, UPGRADES, LOCATIONS, CONFIG } = E;
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
  const ROOM_MAX_ICONS = 15;       // per machine type, before showing "+N"

  const $ = (id) => document.getElementById(id);
  const el = {
    money: $('money'), income: $('income'), throttle: $('throttle'),
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
  let installedKey = '';
  let lastSavedAt = 0;
  let storageOk = true;
  let away = null;              // accumulated "while you were gone" report shown in the modal
  let suspended = false;        // hidden tabs settle elapsed time once, on return
  const incidentTypes = new Map(E.EVENTS.map(def => [def.id, def]));

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

  function floatText(text, x, y, minus) {
    const span = document.createElement('span');
    span.className = 'float' + (minus ? ' minus' : '');
    span.textContent = text;
    span.style.left = x + 'px';
    span.style.top = y + 'px';
    document.body.appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  function centerOf(node) {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function restartAnimation(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // force reflow so the animation plays again
    node.classList.add(cls);
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
    const groups = [['machine', MACHINES], ['cooler', COOLERS], ['upgrade', UPGRADES]];
    for (const [kind, list] of groups) {
      const container = $('shop-' + kind);
      container.textContent = '';
      for (const def of list) {
        const button = make('button', 'card');
        button.type = 'button';
        const icon = make('span', 'card-icon', def.icon);
        const main = make('span', 'card-main');
        const title = make('span', 'card-title');
        const name = make('span', null, def.name);
        const owned = make('span', 'card-owned');
        title.append(name, owned);
        const desc = make('span', 'card-desc');
        const blurb = make('span', 'card-blurb', def.blurb || '');
        main.append(title, desc, blurb);
        const price = make('span', 'card-price');
        const costEl = make('span', 'card-cost');
        const shortfall = make('small', 'card-shortfall');
        price.append(costEl, shortfall);
        button.append(icon, main, price);
        container.appendChild(button);

        const card = { kind, def, el: button, icon, name, owned, desc, blurb, cost: costEl, shortfall };
        if (kind === 'machine') {
          const label = make('span', 'card-milestone-label');
          const track = make('span', 'card-milestone-track');
          const fill = make('span', 'card-milestone-fill');
          track.setAttribute('aria-hidden', 'true');
          track.appendChild(fill);
          main.append(label, track);
          card.milestone = { label, track, fill, lastOwned: null };
        }
        button.addEventListener('click', (ev) => onBuy(card, ev));
        cards.push(card);
      }
    }
  }

  // Between two consecutive Max totals the affordable count cannot change. Reuse
  // that quote while money ticks up, or until a purchase changes the owned count.
  function quoteFor(card) {
    const { kind, def } = card;
    const mode = kind === 'upgrade' ? '1' : quantity;
    const owned = E.ownedCount(state, kind, def.id);
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

  function onBuy(card, ev) {
    if (card.el.hidden || el.modal.open || !settleBeforePurchaseOrMove()) return;
    const { count } = quoteFor(card);
    if (!count) return;
    const result = E.buyMany(state, card.kind, card.def.id, count);
    if (!result.ok) return;
    const p = ev.clientX || ev.clientY ? { x: ev.clientX, y: ev.clientY } : centerOf(card.cost);
    const spent = wholeDollars.format(result.cost);
    floatText('−' + spent, p.x, p.y - 10, true);
    restartAnimation(card.el, 'bought');
    restartAnimation(el.money, 'spend');
    if (card.kind === 'upgrade') {
      log(`${card.def.icon} Installed ${card.def.name}: ${card.def.desc}`, 'good');
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
    let latestBonus = '';
    for (const tier of E.MILESTONES) {
      if (owned < tier.count) break;
      const flag = `milestone:${id}:${tier.count}`;
      if (state.flags[flag]) continue;
      state.flags[flag] = true;
      if (progress.lastOwned === null) continue;
      latestBonus = E.milestoneMult(tier.count).toLocaleString('en-US') + '×';
      log(`📈 ${tier.count} ${name}s! Milestone income bonus: ${latestBonus}.`, 'big');
    }
    progress.lastOwned = owned;
    if (latestBonus) {
      // A bulk purchase can earn several tiers. Show each in the log and float the total once.
      restartAnimation(card.el, 'milestone-hit');
      const point = centerOf(progress.label);
      floatText(latestBonus + ' income', point.x, point.y);
    }
  }

  // Start with what this save already knows. Offline income can then reveal new items
  // on the very first frame without replaying unlock messages for the whole shop.
  function rememberRevealedItems() {
    for (const card of cards) card.wasRevealed = E.isRevealed(state, card.kind, card.def.id);
  }

  let displayedUnlock = null;
  function renderUnlockTeaser() {
    const next = E.nextReveal(state);
    if (!next) {
      if (!el.unlockTeaser.hidden) el.unlockTeaser.hidden = true;
      displayedUnlock = null;
      return;
    }
    if (!displayedUnlock || displayedUnlock.kind !== next.kind || displayedUnlock.at !== next.at) {
      const target = next.at.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(next.at) ? 0 : 2 });
      setText(el.unlockText, `❓ New ${next.kind} at $${target} lifetime earnings`);
      displayedUnlock = next;
    }
    const percent = Math.min(100, Math.floor(state.lifetime / next.at * 100));
    if (el.unlockProgress.value !== percent) el.unlockProgress.value = percent;
    if (el.unlockTeaser.hidden) el.unlockTeaser.hidden = false;
  }

  function renderShop(st) {
    let anyUpgradeShown = false;

    for (const card of cards) {
      const { kind, def } = card;
      const isUpgrade = kind === 'upgrade';
      const bought = isUpgrade && state.upgrades.includes(def.id);
      const revealed = E.isRevealed(state, kind, def.id);
      if (revealed && !card.wasRevealed) log(`🔓 Unlocked: ${def.icon} ${def.name}`, 'good');
      card.wasRevealed = revealed;
      card.el.hidden = bought || !revealed;
      if (card.el.hidden) continue;
      if (isUpgrade) anyUpgradeShown = true;

      const quote = quoteFor(card);
      const affordable = quote.count > 0 && state.money >= quote.total && E.meetsRequirements(state, def);
      card.icon.textContent = def.icon;
      card.name.textContent = def.name;
      card.owned.textContent = isUpgrade ? '' : '×' + E.ownedCount(state, kind, def.id);
      card.desc.textContent = describe(card, st);
      if (kind === 'machine') renderMachineMilestone(card);
      card.blurb.hidden = !def.blurb;
      if (card.cost.textContent !== quote.label) card.cost.textContent = quote.label;
      card.el.disabled = !affordable;
      card.el.classList.toggle('affordable', affordable);
      const needed = quote.count ? quote.total : quote.nextTotal;
      card.shortfall.hidden = affordable;
      if (!affordable) setText(card.shortfall, `Need ${wholeDollars.format(Math.ceil(needed - state.money))} more`);
    }

    el.upgradeEmpty.hidden = anyUpgradeShown;
    renderUnlockTeaser();

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

  // ---------------------------------------------------------------------------
  // The room: a picture of everything you own
  // ---------------------------------------------------------------------------

  function renderRoom(st) {
    el.room.style.setProperty('--heat', Math.max(0, Math.min(1, (st.load - 0.8) / 0.7)).toFixed(2));

    const key = JSON.stringify([state.machines, state.coolers]);
    if (key === roomKey) return;
    const previous = roomKey ? JSON.parse(roomKey) : null;
    roomKey = key;

    el.room.textContent = '';
    let any = false;
    const groups = [['machines', MACHINES, 'hum'], ['coolers', COOLERS, null]];
    for (const [bucket, list, motion] of groups) {
      for (const def of list) {
        const n = state[bucket][def.id];
        if (!n) continue;
        any = true;
        const oldN = previous ? previous[bucket === 'machines' ? 0 : 1][def.id] : n;
        const group = make('div', 'room-group');
        const label = make('span', 'room-label', `${def.name} ×${n}`);
        const tokens = make('span', 'room-tokens');
        tokens.setAttribute('aria-hidden', 'true');
        group.append(label, tokens);
        const shown = Math.min(n, ROOM_MAX_ICONS);
        for (let i = 0; i < shown; i++) {
          const token = make('span', 'token', def.icon);
          if (def.id === 'fan') token.classList.add('spin');
          else if (motion) {
            token.classList.add(motion);
            token.style.animationDelay = `${(i * 0.13) % 0.9}s`;
          }
          if (i >= oldN && i < n) token.classList.add('fresh');
          tokens.appendChild(token);
        }
        if (n > shown) tokens.appendChild(make('span', 'more', `+${n - shown}`));
        el.room.appendChild(group);
      }
    }
    if (!any) el.room.appendChild(make('p', 'room-empty', 'Just a dusty floor and one outlet.'));
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  function render() {
    const st = E.stats(state);
    const loc = LOCATIONS[state.location];

    el.money.textContent = money(state.money);
    el.income.textContent = rate(st.income);
    el.jobValue.textContent = '+' + money(st.clickValue);

    if (st.throttle < 1) {
      el.throttle.hidden = false;
      el.throttle.textContent =
        `🔥 Overheating! Machines running at ${Math.floor(st.throttle * 100)}% speed ` +
        `(losing ${rate(st.rawIncome - st.income)}). Buy cooling.`;
    } else {
      el.throttle.hidden = true;
    }

    const pct = Math.round(st.load * 100);
    el.heatText.textContent = `${E.formatNumber(round1(st.heat))} heat / ${E.formatNumber(round1(st.cooling))} cooling (${pct}%)`;
    el.heatFill.style.width = Math.min(100, st.load * 100) + '%';
    el.heatFill.classList.toggle('warm', st.load > 0.8 && st.load <= 1);
    el.heatFill.classList.toggle('hot', st.load > 1);

    if (state.location === 'basement') {
      el.milestone.hidden = false;
      const earned = Math.floor(Math.min(state.lifetime, CONFIG.moveGoal));
      setText(el.milestoneText, `${wholeDollars.format(earned)} / ${moveGoalText}`);
      el.milestoneFill.style.width = E.moveProgress(state) * 100 + '%';
      el.moveBtn.hidden = !E.canMove(state);
    } else {
      el.milestone.hidden = true;
      el.moveBtn.hidden = true;
    }
    el.location.textContent = `📍 ${loc.name}`;
    el.roomTitle.textContent = loc.room;

    renderShop(st);
    renderRoom(st);
    renderIncident();
    renderSaveStatus();
    return st;
  }

  const round1 = (n) => Math.round(n * 10) / 10;

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function renderIncident() {
    const pending = state.event;
    const incident = pending || state.active;
    el.incident.hidden = !incident;
    if (!incident) return;

    const def = incidentTypes.get(incident.id);
    el.incident.classList.toggle('warning', def.id === 'heatwave');
    setText(el.incidentTitle, def.icon + ' ' + (def.id === 'heatwave' && !pending ? 'Heat wave' : def.title));
    setText(el.incidentTime, Math.ceil(incident.remaining) + 's remaining');
    el.incidentActions.hidden = !pending;

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
    if (state.event === offer && !el.modal.open) {
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
      el.saveStatus.textContent = "⚠️ This browser won't let the game save. Progress will be lost when you close the tab.";
      return;
    }
    if (!lastSavedAt) return;
    const ago = Math.floor((Date.now() - lastSavedAt) / 1000);
    el.saveStatus.textContent = ago < 2 ? '💾 Saved just now' : `💾 Saved ${ago}s ago`;
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
    if (!away) away = { seconds: 0, credited: 0, earned: 0, capped: false, throttleSeconds: 0, resolutions: [] };
    away.seconds += report.seconds;
    away.credited += report.credited;
    away.earned += report.earned;
    away.capped = away.capped || report.capped;
    away.throttleSeconds += report.throttle * report.credited;
    for (const notice of report.notices) {
      if (notice.away) away.resolutions.push(resolutionText(notice));
    }

    const body = [
      para(`You were away for ${E.formatDuration(away.seconds)}. Your machines kept humming and earned:`),
      para(money(away.earned), 'big-number'),
    ];
    if (away.capped) {
      body.push(para(`Offline earnings only count the first ${E.formatDuration(CONFIG.offlineCapSeconds)}, so you got ${E.formatDuration(away.credited)} worth.`, 'muted'));
    }
    const averageSpeed = away.credited > 0 ? away.throttleSeconds / away.credited : 1;
    if (averageSpeed < 1) {
      body.push(para(`With overheating, machines averaged ${(averageSpeed * 100).toFixed(1)}% speed during credited time.`, 'muted'));
    }
    for (const line of away.resolutions) body.push(para(line));
    if (away.earned > 0) log(`💤 While you were away (${E.formatDuration(report.seconds)}), your machines earned ${money(report.earned)}.`, 'good');
    openModal('Welcome back!', body, [{ label: 'Nice', style: 'primary' }], () => {
      away = null;
      state.nextEventIn = Math.max(state.nextEventIn, CONFIG.eventReturnGraceSeconds);
    });
  }

  function showMoveChoice() {
    if (!E.canMove(state)) return;
    const list = make('div', 'choice-list');
    for (const id of ['warehouse', 'office']) {
      const loc = LOCATIONS[id];
      const b = make('button', 'choice');
      b.type = 'button';
      b.append(make('strong', null, `${loc.icon} ${loc.name}`), make('span', null, loc.desc));
      b.addEventListener('click', () => {
        if (!settleBeforePurchaseOrMove()) return;
        el.modal.close();
        if (E.moveTo(state, id).ok) {
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
    state = E.newState(Date.now());
    rememberRevealedItems();
    el.log.textContent = '';
    roomKey = '';
    installedKey = '';
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
    const value = E.click(state);
    const p = ev.detail || ev.pointerType ? { x: ev.clientX, y: ev.clientY } : centerOf(el.jobBtn);
    floatText('+' + money(value), p.x, p.y);
    el.money.classList.add('bump');
    setTimeout(() => el.money.classList.remove('bump'), 90);
    render();
  });
  el.jobBtn.addEventListener('contextmenu', ev => ev.preventDefault());
  el.moveBtn.addEventListener('click', showMoveChoice);
  el.resetBtn.addEventListener('click', confirmReset);
  el.accept.addEventListener('click', () => answerIncident('accept'));
  el.decline.addEventListener('click', () => answerIncident('decline'));

  // A hidden page can keep receiving throttled intervals. Leave its saved clock anchored
  // at departure so the whole absence gets one offline cap and one welcome-back summary.
  function suspend() {
    if (suspended) return;
    suspended = true;
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
    if (document.visibilityState === 'hidden') suspend();
    else resume();
  });
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  document.addEventListener('freeze', save);

  // ---------------------------------------------------------------------------
  // Game loop
  // ---------------------------------------------------------------------------

  function updateClock(now, foreground, allowSpawn = true) {
    const gap = (now - state.lastTick) / 1000;
    const live = foreground && document.visibilityState === 'visible' && gap >= 0 && gap <= CONFIG.eventLiveGapSeconds;
    const report = E.catchUp(state, now, { live, allowSpawn: allowSpawn && !el.modal.open });
    handleNotices(report.notices);
    if (report.seconds >= AWAY_NOTICE_SECONDS) showAway(report);
  }

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
      save, reset: resetGame,
    };
  }

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
