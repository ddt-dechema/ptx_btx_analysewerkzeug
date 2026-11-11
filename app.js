/* Routenbaukasten v2: reads the normalized SQLite v2 schema via SQL.js. */
(() => {
  'use strict';

  // const SQL_CDN = 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/';
  const SQL_CDN = new URL('./vendor/', document.baseURI);

  async function initializeSql() {
    if (typeof window.initSqlJs !== 'function') {
      throw new Error('SQL.js konnte nicht geladen werden.');
    }

    return window.initSqlJs({
      locateFile: file => new URL(file, SQL_WASM_DIR).href
    });
  }
  const DB_URL = new URL('./data/prototype_v2.sqlite', document.baseURI);
  const $ = selector => document.querySelector(selector);
  const dbStatus = $('#dbStatus');
  const dbFile = $('#dbFile');
  const routeStatus = $('#routeStatus');
  const stages = {
    feedstock: $('#feedstockStage'),
    primary: $('#primaryStage'),
    intermediate: $('#intermediateStage'),
    final: $('#finalStage'),
    target: $('#targetStage')
  };

  let db = null;
  let routes = [];
  let targets = [];
  let selections = Object.create(null);
  let targetFilter = '';

  function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function query(sql, params = []) {
    if (!db) throw new Error('Die SQLite-Datenbank ist nicht geladen.');
    const stmt = db.prepare(sql);
    const rows = [];
    try {
      if (params.length) stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  function setDbStatus(text) {
    dbStatus.textContent = text;
  }

  function setRouteStatus(state, title, text) {
    routeStatus.dataset.state = state;
    routeStatus.replaceChildren(el('strong', '', title), el('span', '', text));
  }

  function checkSchema() {
    const required = ['stream','module_group','module','module_port','route','route_step','route_connection'];
    const present = new Set(query("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
    const missing = required.filter(name => !present.has(name));
    if (missing.length) throw new Error(`Das ist kein v2-Schema. Es fehlen: ${missing.join(', ')}`);
  }

  function getRoutes() {
    return query(`
      SELECT route.route_id, route.name, route.target_stream_id,
             route.route_family, route.description, route.status,
             stream.name AS target_name, stream.stream_role AS target_role
      FROM route
      JOIN stream ON stream.stream_id = route.target_stream_id
      WHERE route.status IN ('demo','active')
      ORDER BY stream.name, route.name
    `);
  }

  function getRouteDetail(routeId) {
    const route = routes.find(item => item.route_id === routeId);
    if (!route) return null;

    route.steps = query(`
      SELECT route_step.route_step_id, route_step.route_id,
             route_step.step_code, route_step.selection_slot,
             route_step.display_label, route_step.stage_key,
             route_step.position, route_step.allowed_module_group_id,
             route_step.is_required, module_group.name AS group_name
      FROM route_step
      JOIN module_group
        ON module_group.module_group_id = route_step.allowed_module_group_id
      WHERE route_step.route_id = ?
      ORDER BY route_step.position, route_step.step_code
    `, [routeId]);

    for (const step of route.steps) {
      step.modules = query(`
        SELECT module_id, module_group_id, name, technology_variant,
               description, status
        FROM module
        WHERE module_group_id = ? AND status IN ('demo','active')
        ORDER BY name COLLATE NOCASE
      `, [step.allowed_module_group_id]);
      for (const module of step.modules) {
        module.ports = query(`
          SELECT module_port.direction, module_port.is_required,
                 stream.stream_id, stream.name AS stream_name,
                 stream.stream_role, stream.unit
          FROM module_port
          JOIN stream ON stream.stream_id = module_port.stream_id
          WHERE module_port.module_id = ?
          ORDER BY module_port.direction, stream.name
        `, [module.module_id]);
      }
    }

    route.connections = query(`
      SELECT route_connection.connection_id,
             route_connection.from_route_step_id,
             route_connection.stream_id,
             stream.name AS stream_name,
             route_connection.to_route_step_id,
             route_connection.is_required,
             source.display_label AS from_label,
             target.display_label AS to_label
      FROM route_connection
      JOIN stream ON stream.stream_id = route_connection.stream_id
      JOIN route_step AS source
        ON source.route_step_id = route_connection.from_route_step_id
      JOIN route_step AS target
        ON target.route_step_id = route_connection.to_route_step_id
      WHERE route_connection.route_id = ?
      ORDER BY source.position, target.position, stream.name
    `, [routeId]);

    return route;
  }

  function keyForStep(step) {
    return step.stage_key === 'primary_conversion' && step.selection_slot
      ? `slot:${step.selection_slot}`
      : `step:${step.route_step_id}`;
  }

  function moduleForStep(step, selectionState = selections) {
    const moduleId = selectionState[keyForStep(step)];
    return step.modules.find(module => module.module_id === moduleId) || null;
  }

  function hasPort(module, streamId, direction) {
    return Boolean(module?.ports.some(port =>
      port.stream_id === streamId && port.direction === direction
    ));
  }

  function routeSupports(route, selectionState = selections) {
    for (const [key, moduleId] of Object.entries(selectionState)) {
      if (!moduleId) continue;
      const candidates = key.startsWith('slot:')
        ? route.steps.filter(step => step.stage_key === 'primary_conversion' && `slot:${step.selection_slot}` === key)
        : route.steps.filter(step => `step:${step.route_step_id}` === key);
      if (!candidates.some(step => step.modules.some(module => module.module_id === moduleId))) {
        return false;
      }
    }

    for (const connection of route.connections) {
      if (!connection.is_required) continue;
      const sourceStep = route.steps.find(step => step.route_step_id === connection.from_route_step_id);
      const targetStep = route.steps.find(step => step.route_step_id === connection.to_route_step_id);
      if (!sourceStep || !targetStep) return false;
      const sourceModule = moduleForStep(sourceStep, selectionState);
      const targetModule = moduleForStep(targetStep, selectionState);
      if (sourceModule && !hasPort(sourceModule, connection.stream_id, 'output')) return false;
      if (targetModule && !hasPort(targetModule, connection.stream_id, 'input')) return false;
    }

    return true;
  }

  function viableRoutes(selectionState = selections, filterId = targetFilter) {
    return routes
      .filter(route => !filterId || route.target_stream_id === filterId)
      .map(route => getRouteDetail(route.route_id))
      .filter(route => route && routeSupports(route, selectionState));
  }

  function optionEnabled(key, moduleId) {
    const trial = { ...selections, [key]: moduleId };
    return viableRoutes(trial).length > 0;
  }

  function collectPrimarySlots() {
    const slots = new Map();
    for (const route of routes) {
      const detail = getRouteDetail(route.route_id);
      for (const step of detail.steps.filter(item => item.stage_key === 'primary_conversion')) {
        const key = keyForStep(step);
        if (!slots.has(key)) {
          slots.set(key, {
            key,
            label: step.display_label,
            position: step.position,
            modules: new Map()
          });
        }
        const slot = slots.get(key);
        slot.position = Math.min(slot.position, step.position);
        for (const module of step.modules) slot.modules.set(module.module_id, module);
      }
    }
    return [...slots.values()].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'de'));
  }

  function getAllSelectedModules() {
    const found = new Map();
    for (const route of routes) {
      const detail = getRouteDetail(route.route_id);
      for (const step of detail.steps) {
        const module = moduleForStep(step);
        if (module) found.set(`${keyForStep(step)}:${module.module_id}`, { step, module });
      }
    }
    return [...found.values()];
  }

  function renderFeedstocks() {
    const container = stages.feedstock;
    container.replaceChildren();
    const seen = new Set();
    for (const { step, module } of getAllSelectedModules()) {
      for (const port of module.ports.filter(item =>
        item.direction === 'input' && ['feedstock','energy','utility'].includes(item.stream_role)
      )) {
        const key = `${keyForStep(step)}:${module.module_id}:${port.stream_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const chip = el('div', 'input-chip');
        chip.append(el('span', '', port.stream_name), el('small', '', module.name));
        container.append(chip);
      }
    }
    if (!container.children.length) {
      container.append(el('div', 'empty-state', 'Edukte und Hilfsinputs erscheinen nach der Modulauswahl.'));
    }
  }

  function renderModuleButton(module, key, className = 'module-option') {
    const selected = selections[key] === module.module_id;
    const button = el('button', className);
    button.type = 'button';
    button.disabled = !optionEnabled(key, module.module_id) && !selected;
    button.setAttribute('aria-pressed', String(selected));
    button.append(el('span', '', module.name));
    if (module.technology_variant) button.append(el('small', 'option-sub', module.technology_variant));
    if (module.description) button.title = module.description;
    button.addEventListener('click', () => {
      selections[key] = selected ? '' : module.module_id;
      renderBoard();
    });
    return button;
  }

  function renderPrimary() {
    const container = stages.primary;
    container.replaceChildren();
    const slots = collectPrimarySlots();
    for (const slot of slots) {
      const card = el('div', 'step-card');
      card.append(el('strong', '', slot.label));
      const list = el('div', 'option-list');
      const modules = [...slot.modules.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
      for (const module of modules) list.append(renderModuleButton(module, slot.key));
      card.append(list);
      const selected = modules.find(module => selections[slot.key] === module.module_id);
      if (selected) {
        const ports = el('div', 'ports');
        for (const port of selected.ports) {
          ports.append(el('span', `port-tag ${port.direction}`, `${port.direction === 'input' ? 'Input' : 'Output'}: ${port.stream_name}`));
        }
        card.append(ports);
      }
      container.append(card);
    }
    if (!container.children.length) container.append(el('div', 'empty-state', 'Keine primären Umwandlungsschritte hinterlegt.'));
  }

  function renderFinal() {
    const container = stages.final;
    container.replaceChildren();
    const choices = [];
    for (const route of routes) {
      const detail = getRouteDetail(route.route_id);
      for (const step of detail.steps.filter(item => item.stage_key === 'final_conversion')) {
        for (const module of step.modules) choices.push({ step, module, key: keyForStep(step) });
      }
    }
    choices.sort((a, b) => a.module.name.localeCompare(b.module.name, 'de'));
    for (const choice of choices) {
      container.append(renderModuleButton(choice.module, choice.key, 'final-option'));
    }
    if (!container.children.length) container.append(el('div', 'empty-state', 'Keine finalen Umwandlungsmodule hinterlegt.'));
  }

  function renderConnections(activeRoutes) {
    const container = stages.intermediate;
    container.replaceChildren();
    const viableIds = new Set(activeRoutes.map(route => route.route_id));
    const byStream = new Map();

    for (const route of routes) {
      const detail = getRouteDetail(route.route_id);
      for (const connection of detail.connections) {
        if (!byStream.has(connection.stream_id)) {
          byStream.set(connection.stream_id, {
            streamId: connection.stream_id,
            streamName: connection.stream_name,
            links: []
          });
        }
        byStream.get(connection.stream_id).links.push({
          routeId: route.route_id,
          routeName: route.name,
          fromLabel: connection.from_label,
          toLabel: connection.to_label
        });
      }
    }

    for (const stream of byStream.values()) {
      const activeLinks = stream.links.filter(link => viableIds.has(link.routeId));
      const visibleLinks = activeLinks.length ? activeLinks : stream.links;
      const isDisabled = activeLinks.length === 0;
      const linkLabels = [...new Set(visibleLinks.map(link => `${link.fromLabel} → ${link.toLabel}`))];
      const routeNames = [...new Set(visibleLinks.map(link => link.routeName))];
      const summary = linkLabels.join('; ') + (routeNames.length > 1 ? ` · ${routeNames.length} Routen` : '');
      const chip = el('div', `stream-chip${isDisabled ? ' is-disabled' : ''}`);
      chip.append(
        el('span', '', stream.streamName),
        el('small', '', summary || 'In einer Routenvorlage verbunden')
      );
      if (isDisabled) chip.setAttribute('aria-disabled', 'true');
      container.append(chip);
    }

    if (!byStream.size) {
      container.append(el('div', 'empty-state', 'Noch keine Route-Verbindungen hinterlegt.'));
    }
  }

  function renderTargets() {
    const container = stages.target;
    container.replaceChildren();
    const list = el('div', 'product-list');
    const routeByTarget = new Map();
    for (const route of routes) {
      if (!routeByTarget.has(route.target_stream_id)) routeByTarget.set(route.target_stream_id, route.target_name);
    }
    for (const [streamId, name] of [...routeByTarget.entries()].sort((a,b)=>a[1].localeCompare(b[1],'de'))) {
      const button = el('button', 'target-option');
      button.type = 'button';
      button.disabled = !routes.some(route => route.target_stream_id === streamId);
      button.setAttribute('aria-pressed', String(targetFilter === streamId));
      button.append(el('strong', '', name), el('small', '', targetFilter === streamId ? 'Ausgewählt · anklicken zum Aufheben' : 'Zielprodukt filtern'));
      button.addEventListener('click', () => {
        targetFilter = targetFilter === streamId ? '' : streamId;
        selections = Object.create(null);
        renderBoard();
      });
      list.append(button);
    }
    if (!list.children.length) list.append(el('div', 'empty-state', 'Keine Zielstreams in aktiven oder Demo-Routen.'));
    container.append(list);
  }

  function checkRoute() {
    const viable = viableRoutes();
    if (!viable.length) {
      setRouteStatus('invalid', 'Keine passende Route', 'Mit diesen Auswahlen bleibt keine gespeicherte Routenvorlage übrig. Entferne eine Auswahl oder ändere das Zielprodukt.');
      return;
    }

    const complete = viable.filter(route => route.steps
      .filter(step => Number(step.is_required) === 1)
      .every(step => Boolean(selections[keyForStep(step)]))
    );

    if (complete.length) {
      setRouteStatus('valid', 'Route plausibel', `${complete.length} vollständige Route(n) passen: ${complete.map(route => route.name).join('; ')}`);
    } else {
      setRouteStatus('open', 'Auswahl noch offen', `${viable.length} Routenvorlage(n) passen noch. Wähle die erforderlichen Bereitstellungs- und Umwandlungsmodule.`);
    }
  }

  function renderBoard() {
    const activeRoutes = viableRoutes();
    renderFeedstocks();
    renderPrimary();
    renderConnections(activeRoutes);
    renderFinal();
    renderTargets();
    checkRoute();
  }

  async function initializeSql() {
    if (typeof window.initSqlJs !== 'function') throw new Error('SQL.js konnte nicht geladen werden. Prüfe den CDN-Zugriff.');
    return window.initSqlJs({ locateFile: file => `${SQL_CDN}${file}` });
  }

  async function loadDatabaseBytes(bytes, label) {
    setDbStatus(`Lade ${label} …`);
    const SQL = await initializeSql();
    const nextDb = new SQL.Database(bytes);
    const oldDb = db;
    db = nextDb;
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      checkSchema();
      routes = getRoutes().map(route => ({ ...route, steps: [], connections: [] }));
      if (!routes.length) throw new Error('Die Datenbank enthält keine demo- oder active-Routen.');
      targets = routes.map(route => route.target_stream_id);
      selections = Object.create(null);
      targetFilter = '';
      renderBoard();
      if (oldDb) oldDb.close();
      setDbStatus(`${label} geladen · ${routes.length} kuratierte Route(n) · Auswahl und Prüfung laufen lokal im Browser.`);
    } catch (error) {
      db = oldDb;
      nextDb.close();
      throw error;
    }
  }

  async function openPickedFile(file) {
    if (!file) return;
    document.body.classList.add('loading');
    try {
      await loadDatabaseBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (error) {
      setDbStatus(`Fehler: ${error.message}`);
      setRouteStatus('invalid', 'Datenbank konnte nicht geladen werden', error.message);
    } finally {
      document.body.classList.remove('loading');
    }
  }

  async function autoLoadPublishedDb() {
    if (location.protocol === 'file:') {
      setDbStatus('Lokaler Dateizugriff: Nutze „SQLite-Datei öffnen“ und wähle prototype_v2.sqlite.');
      setRouteStatus('open', 'SQLite-Datei öffnen', 'Wähle die v2-Datenbank aus, um die fünf Phasen zu laden.');
      return;
    }
    try {
      const response = await fetch(DB_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await loadDatabaseBytes(new Uint8Array(await response.arrayBuffer()), 'prototype_v2.sqlite');
    } catch (error) {
      setDbStatus(`Demo-Datenbank nicht automatisch geladen (${error.message}). Öffne prototype_v2.sqlite über die Dateiauswahl.`);
      setRouteStatus('open', 'SQLite-Datei öffnen', 'Wähle die v2-Datenbank aus oder prüfe, ob sie unter data/prototype_v2.sqlite liegt.');
    }
  }

  dbFile.addEventListener('change', event => openPickedFile(event.target.files?.[0]));
  autoLoadPublishedDb().catch(error => {
    setDbStatus(`Fehler: ${error.message}`);
    setRouteStatus('invalid', 'Start fehlgeschlagen', error.message);
  });
})();
