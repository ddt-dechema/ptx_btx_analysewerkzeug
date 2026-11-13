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
      locateFile: file => new URL(file, SQL_CDN).href
    });
  }
  const DB_URL = new URL('./data/prototype_v2_original.sqlite', document.baseURI);
  const $ = selector => document.querySelector(selector);
  const dbStatus = $('#dbStatus');
  const dbFile = $('#dbFile');
  const routeStatus = $('#routeStatus');


  const lcaResults = $('#lcaResults');
  const lcaFuAmount = $('#lcaFuAmount');


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


  // Feste Caps aus der SQL-Abfrage; die Skala wird nicht aus Routendaten abgeleitet.
  const DISPLAY_CAPS = Object.freeze({
    ADP: 0.00012,
    ENERGY: 4.2,
    LAND: 4.8,
    RMC_MF: 3.9,
    WATER_USE: 0.16,
    TMR: 7.99,
    GWP: 4.5
  });


  function getDisplayCaps(indicators) {
    const caps = Object.create(null);


    for (const indicator of indicators) {
      const id = indicator.indicator_id;
      const cap = DISPLAY_CAPS[id];


      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
        throw new Error(`Kein fixer Anzeige-Cap für ${indicator.name} (${id}) hinterlegt.`);
      }
      caps[id] = cap;
    }


    return caps;
  }


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
    const required = ['stream','module_group','module','module_port','route','route_step','route_connection',
      'resource_indicator','module_resource_contribution'];
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
              module_port.quantity_coefficient, module_port.quantity_unit,
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


    // module.ports = query(`
    //   SELECT module_port.direction, module_port.is_required,
    //         module_port.quantity_coefficient, module_port.quantity_unit,
    //         stream.stream_id, stream.name AS stream_name,
    //         stream.stream_role, stream.unit
    //   FROM module_port
    //   JOIN stream ON stream.stream_id = module_port.stream_id
    //   WHERE module_port.module_id = ?
    //   ORDER BY module_port.direction, stream.name
    // `, [module.module_id]);


    return route;
  }


  function keyForStep(step) {
    return step.stage_key === 'primary_conversion' && step.selection_slot
      ? `slot:${step.selection_slot}`
      : `step:${step.route_step_id}`;
  }


  function moduleForStep(step, selectionState = selections) {
    if (!step || !Array.isArray(step.modules)) return null;


    const moduleId = selectionState?.[keyForStep(step)];
    if (!moduleId) return null;


    return step.modules.find(
      candidate => candidate && candidate.module_id === moduleId
    ) || null;
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


  function formatLcaNumber(value) {
    const number = Number(value);
    const useScientific = number !== 0 && Math.abs(number) < 0.001;
    const options = useScientific
      ? { notation: 'scientific', maximumSignificantDigits: 3 }
      : { maximumFractionDigits: 4 };


    return new Intl.NumberFormat('de-DE', options).format(number);
  }


function formatLcaValue(value, unit) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—';
  }
  return `${formatLcaNumber(Number(value))}${unit ? ` ${unit}` : ''}`;
}


function addLcaValues(a, b) {
  return a === null || b === null ? null : a + b;
}


function scaleLcaValue(value, factor) {
  return value === null ? null : value * factor;
}


function moduleResourceProfile(moduleId, indicators) {
  const rows = query(`
    SELECT indicator_id, contribution_type, value, unit
    FROM module_resource_contribution
    WHERE module_id = ?
  `, [moduleId]);


  const profile = Object.create(null);


  for (const indicator of indicators) {
    const values = rows.filter(row =>
      row.indicator_id === indicator.indicator_id &&
      row.value !== null &&
      row.value !== undefined
    );


    if (!values.length) {
      profile[indicator.indicator_id] = null;
      continue;
    }


    for (const row of values) {
      if (!Number.isFinite(Number(row.value))) {
        throw new Error(
          `Ungültiger Zahlenwert für ${indicator.name} im Modul ${moduleId}.`
        );
      }
      if (row.unit && row.unit !== indicator.unit) {
        throw new Error(
          `Einheitenfehler bei ${indicator.name} in Modul ${moduleId}: ` +
          `„${row.unit}“ passt nicht zu „${indicator.unit}“.`
        );
      }
    }


    // direct, upstream und infrastructure werden als Beiträge des aktuellen
    // Moduls addiert. Route-verbundene Vorketten werden separat übertragen.
    profile[indicator.indicator_id] = values.reduce(
      (sum, row) => sum + Number(row.value),
      0
    );
  }


  return profile;
}


function calculateRouteLca(route, indicators, fuAmount) {
  const entries = route.steps.map(step => ({
    step,
    module: moduleForStep(step)
  }));


  const missingRequired = entries.find(entry =>
    Number(entry.step.is_required) === 1 && !entry.module
  );
  if (missingRequired) {
    throw new Error(`Bitte das erforderliche Modul „${missingRequired.step.display_label}“ wählen.`);
  }


  for (const entry of entries) {
    if (!entry.module) continue;


    const outputs = entry.module.ports.filter(port => port.direction === 'output');


    // Diese einfache Implementierung verlangt Single-Output-Module.
    // Für mehrere relevante Outputs ist eine fachliche Zuordnung erforderlich.
    if (outputs.length !== 1) {
      throw new Error(
        `${entry.module.name}: erwartet wird genau ein Output-Port. ` +
        `Mehrere Outputs benötigen Subdivision oder eine dokumentierte Allokation.`
      );
    }


    entry.outputPort = outputs[0];
  }


  const targetEntries = entries.filter(entry =>
    entry.module &&
    entry.outputPort.stream_id === route.target_stream_id
  );


  if (targetEntries.length !== 1) {
    throw new Error(
      `Der Zielstream „${route.target_name}“ muss genau einem ausgewählten Modul-Output entsprechen.`
    );
  }


  const targetEntry = targetEntries[0];
  const outputDemand = new Map([
    [targetEntry.step.route_step_id, fuAmount]
  ]);
  const inputsByStep = new Map();


  // Rückwärts durch die Route: erforderliche Mengen der vorgelagerten Module
  // aus den Inputkoeffizienten des jeweils nachgelagerten Moduls ableiten.
  const reverseEntries = [...entries].sort(
    (a, b) => Number(b.step.position) - Number(a.step.position)
  );


  for (const entry of reverseEntries) {
    if (!entry.module) continue;


    const stepId = entry.step.route_step_id;
    const requiredOutput = outputDemand.get(stepId) || 0;
    if (requiredOutput <= 0) continue;


    const stepInputs = [];


    for (const port of entry.module.ports.filter(item => item.direction === 'input')) {
      const connection = route.connections.find(item =>
        item.to_route_step_id === stepId &&
        item.stream_id === port.stream_id
      );


      const rawCoefficient = port.quantity_coefficient;
      if (rawCoefficient === null || rawCoefficient === undefined || rawCoefficient === '') {
        if (Number(port.is_required) === 1 || connection) {
          throw new Error(
            `Mengenkoeffizient fehlt: ${entry.module.name} / ${port.stream_name}.`
          );
        }
        continue;
      }


      const coefficient = Number(rawCoefficient);
      if (!Number.isFinite(coefficient) || coefficient < 0) {
        throw new Error(
          `Ungültiger Mengenkoeffizient: ${entry.module.name} / ${port.stream_name}.`
        );
      }


      const inputQuantity = coefficient * requiredOutput;
      let sourceStepId = null;
      let sourceLabel = '';


      if (connection) {
        const sourceEntry = entries.find(item =>
          item.step.route_step_id === connection.from_route_step_id
        );


        if (!sourceEntry || !sourceEntry.module) {
          throw new Error(
            `Vorgelagertes Modul für den Stream „${port.stream_name}“ ist nicht ausgewählt.`
          );
        }


        if (
          !sourceEntry.outputPort ||
          sourceEntry.outputPort.stream_id !== connection.stream_id
        ) {
          throw new Error(
            `Der Output von „${sourceEntry.module.name}“ passt nicht zum verbundenen Stream „${port.stream_name}“.`
          );
        }


        sourceStepId = sourceEntry.step.route_step_id;
        sourceLabel = sourceEntry.step.display_label || sourceEntry.module.name;
        outputDemand.set(
          sourceStepId,
          (outputDemand.get(sourceStepId) || 0) + inputQuantity
        );
      }


      stepInputs.push({
        streamName: port.stream_name,
        unit: port.quantity_unit || port.unit || '',
        quantity: inputQuantity,
        sourceStepId,
        sourceLabel,
        connected: Boolean(connection)
      });
    }


    inputsByStep.set(stepId, stepInputs);
  }


  // Vorwärts durch die Route: je Indikator Modulbeitrag und übertragene
  // Vorkettenbeiträge bilden.
  const computed = new Map();
  const forwardEntries = [...entries].sort(
    (a, b) => Number(a.step.position) - Number(b.step.position)
  );


  for (const entry of forwardEntries) {
    if (!entry.module) continue;


    const stepId = entry.step.route_step_id;
    const requiredOutput = outputDemand.get(stepId) || 0;
    if (requiredOutput <= 0) continue;


    const inherited = Object.create(null);
    for (const indicator of indicators) {
      inherited[indicator.indicator_id] = 0;
    }


    for (const input of inputsByStep.get(stepId) || []) {
      if (!input.sourceStepId || input.quantity === 0) continue;


      const upstream = computed.get(input.sourceStepId);
      if (!upstream) {
        throw new Error(
          `Vorkettenprofil für „${input.streamName}“ konnte nicht berechnet werden.`
        );
      }


      for (const indicator of indicators) {
        const id = indicator.indicator_id;
        const upstreamPerUnit = upstream.total[id] === null
          ? null
          : upstream.total[id] / upstream.outputAmount;
        const contribution = upstreamPerUnit === null
          ? null
          : upstreamPerUnit * input.quantity;


        inherited[id] = addLcaValues(inherited[id], contribution);
      }
    }


    const perUnit = moduleResourceProfile(entry.module.module_id, indicators);
    const modulePart = Object.create(null);
    const total = Object.create(null);


    for (const indicator of indicators) {
      const id = indicator.indicator_id;
      modulePart[id] = scaleLcaValue(perUnit[id], requiredOutput);
      total[id] = addLcaValues(inherited[id], modulePart[id]);
    }


    computed.set(stepId, {
      outputAmount: requiredOutput,
      inherited,
      modulePart,
      total
    });
  }


  const resultSteps = entries
    .filter(entry => computed.has(entry.step.route_step_id))
    .sort((a, b) => Number(a.step.position) - Number(b.step.position))
    .map(entry => ({
      ...computed.get(entry.step.route_step_id),
      step: entry.step,
      module: entry.module,
      outputPort: entry.outputPort,
      inputs: inputsByStep.get(entry.step.route_step_id) || []
    }));


  return {
    targetUnit: targetEntry.outputPort.unit || '',
    steps: resultSteps
  };
}


function demoSensitivity(moduleId, indicatorId) {
  // Stabile Fantasiewerte: ändern sich nicht bei jedem Neurendern.
  const key = `${moduleId}:${indicatorId}`;
  let hash = 2166136261;


  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  }


  const value = hash >>> 0;


  return {
    minus: 4 + (value % 13),          // 4 bis 16 Prozent
    plus: 5 + ((value >>> 8) % 17)    // 5 bis 21 Prozent
  };
}


function renderSensitivityPanel(calc, indicators) {
  const panel = el('section', 'lca-sensitivity');


  panel.append(
    el('h5', '', 'Sensitivität je Wirkungsindikator'),
    el(
      'p',
      'lca-sensitivity-note',
      'Demo-Fantasiewerte – keine fachlich berechnete Sensitivität.'
    )
  );


  const list = el('div', 'lca-sensitivity-list');


  for (const indicator of indicators) {
    const id = indicator.indicator_id;
    const { minus, plus } = demoSensitivity(calc.module.module_id, id);
    const reference = calc.total[id];


    const lowValue = reference === null
      ? null
      : reference * (1 - minus / 100);


    const highValue = reference === null
      ? null
      : reference * (1 + plus / 100);


    const row = el('div', 'lca-sensitivity-row');


    const name = el('span', 'lca-sensitivity-name');
    name.append(document.createTextNode(indicator.name));


    if (Number(indicator.is_optional) === 1) {
      name.append(
        document.createElement('br'),
        el('span', 'lca-optional', 'optional')
      );
    }


    const left = el('span', 'lca-sensitivity-low', `−${minus}%`);
    const right = el('span', 'lca-sensitivity-high', `+${plus}%`);


    const trackWrap = el('div', 'lca-sensitivity-track-wrap');
    const track = el('div', 'lca-sensitivity-track');


    track.setAttribute('role', 'img');
    track.setAttribute(
      'aria-label',
      `${indicator.name}: Demo-Bereich minus ${minus} Prozent bis plus ${plus} Prozent`
    );


    const band = el('span', 'lca-sensitivity-band');


    // Die Mittelmarke steht für den Referenzwert.
    // Die dargestellte Skala reicht von minus 25 bis plus 25 Prozent.
    band.style.left = `${50 - minus * 2}%`;
    band.style.width = `${(minus + plus) * 2}%`;


    const center = el('span', 'lca-sensitivity-center');
    track.append(band, center);


    trackWrap.append(
      track,
      el(
        'small',
        'lca-sensitivity-reference',
        `Referenz: ${formatLcaValue(reference, indicator.unit)} · ` +
        `Demo-Bereich: ${formatLcaValue(lowValue, indicator.unit)} bis ` +
        `${formatLcaValue(highValue, indicator.unit)}`
      )
    );


    row.append(name, left, trackWrap, right);
    list.append(row);
  }


  panel.append(list);
  return panel;
}


function renderLcaRoute(route, result, indicators, fuAmount, displayCaps) {
  const routeNode = el('section', 'lca-route');
  const routeHeading = el('div', 'lca-route-heading');
  routeHeading.append(
    el('h3', '', route.name),
    el(
      'p',
      '',
      `Routen-FU: ${formatLcaNumber(fuAmount)} ${result.targetUnit} ${route.target_name}`
    )
  );
  routeNode.append(routeHeading);


  const barWidth = (value, cap) => {
    const number = Number(value);


    if (
      value === null ||
      !Number.isFinite(number) ||
      number <= 0 ||
      cap <= 0
    ) {
      return '0%';
    }


    return `${Math.min(100, (number / cap) * 100)}%`;
  };


  const setSegmentWidth = (node, value, cap) => {
    const width = barWidth(value, cap);
    node.style.width = width;
    node.style.flexBasis = width;
  };


  for (const calc of result.steps) {
    const stepNode = el('article', 'lca-step');
    const outputUnit = calc.outputPort.unit || '';
    const title = el('div', 'lca-step-title');
    title.append(
      el('h4', '', `${calc.step.display_label} · ${calc.module.name}`),
      el(
        'p',
        '',
        `Benötigter Output für die Routen-FU: ` +
        formatLcaValue(calc.outputAmount, outputUnit)
      )
    );
    stepNode.append(title);


    const grid = el('div', 'lca-step-grid');


    const inputsPane = el('section', 'lca-inputs');
    inputsPane.append(el('h5', '', 'Benötigte Inputs'));


    const inputList = el('div', 'lca-input-list');
    if (!calc.inputs.length) {
      inputList.append(el('p', 'lca-empty', 'Für dieses Modul sind keine Inputs hinterlegt.'));
    } else {
      for (const input of calc.inputs) {
        const row = el('div', 'lca-input-row');
        row.append(
          el('span', 'lca-input-name', input.streamName),
          el('strong', 'lca-input-qty', formatLcaValue(input.quantity, input.unit)),
          el(
            'small',
            'lca-input-source',
            input.connected
              ? `Vorgelagert aus: ${input.sourceLabel}`
              : 'Externer Input'
          )
        );
        inputList.append(row);
      }
    }
    inputsPane.append(inputList);


    const chartPane = el('section', 'lca-chart');
    chartPane.append(el('h5', '', 'Kumuliertes Ressourcenprofil'));
    const chartLegend = el('div', 'lca-legend lca-chart-legend');
    chartLegend.append(
      el('span', 'lca-legend-upstream', 'Dunkelblau: vorgelagert übernommen'),
      el('span', 'lca-legend-module', 'Grün: Beitrag dieses Moduls')
    );
    chartPane.append(chartLegend);
    chartPane.append(
      el(
        'small',
        'lca-scale-note',
        'Skala: feste Maximalwerte je Indikator aus der SQL-Abfrage.'
      )
    );
    const indicatorList = el('div', 'lca-indicators');


    for (const indicator of indicators) {
      const id = indicator.indicator_id;
      const optional = Number(indicator.is_optional) === 1;
      const row = el('div', 'lca-indicator-row');
      const name = el('div', 'lca-indicator-name');
      name.append(document.createTextNode(indicator.name));
      if (optional) {
        name.append(
          document.createElement('br'),
          el('span', 'lca-optional', 'optional')
        );
      }


      const total = calc.total[id];
      const upstream = calc.inherited[id];
      const modulePart = calc.modulePart[id];
      const cap = displayCaps[id] ?? 1;
      const totalNumber = total === null || total === undefined
        ? NaN
        : Number(total);
      const capExceeded =
        Number.isFinite(totalNumber) && totalNumber > cap;


      const barCell = el('div', 'lca-bar-cell');
      const track = el('div', 'lca-bar-track');
      track.setAttribute('role', 'img');
      track.setAttribute(
        'aria-label',
        `${indicator.name}: vorgelagert ${formatLcaValue(upstream, indicator.unit)}, ` +
        `Modulbeitrag ${formatLcaValue(modulePart, indicator.unit)}, ` +
        `kumuliert ${formatLcaValue(total, indicator.unit)}`
      );


      const upstreamBar = el('span', 'lca-segment upstream');
      const moduleBar = el('span', 'lca-segment module');
      setSegmentWidth(upstreamBar, upstream, cap);
      setSegmentWidth(moduleBar, modulePart, cap);


      if (capExceeded) track.classList.add('is-over-cap');
      track.title = capExceeded
        ? `Anzeige-Cap ${formatLcaNumber(cap)} ${indicator.unit} überschritten; Balken ist begrenzt.`
        : `Skala: 0 bis ${formatLcaNumber(cap)} ${indicator.unit}`;


      track.append(upstreamBar, moduleBar);
      barCell.append(
        track,
        ...(capExceeded
          ? [el('small', 'lca-cap-note', 'Anzeige-Cap überschritten; Balken am Cap begrenzt.')]
          : []),
        el(
          'small',
          'lca-breakdown',
          `Vorgelagert: ${formatLcaValue(upstream, indicator.unit)} · ` +
          `Modul: ${formatLcaValue(modulePart, indicator.unit)}`
        )
      );


      row.append(
        name,
        barCell,
        el('strong', 'lca-total', formatLcaValue(total, indicator.unit))
      );
      indicatorList.append(row);
    }


    chartPane.append(indicatorList);
    grid.append(inputsPane, chartPane);
    stepNode.append(grid);
    stepNode.append(renderSensitivityPanel(calc, indicators));
    routeNode.append(stepNode);
  }


  return routeNode;
}


function renderLcaResults() {
  lcaResults.replaceChildren();


  const fuAmount = Number(lcaFuAmount.value);
  if (!Number.isFinite(fuAmount) || fuAmount <= 0) {
    lcaResults.append(
      el('p', 'lca-error', 'Bitte gib eine positive Menge für die funktionale Einheit ein.')
    );
    return;
  }


  const indicators = query(`
    SELECT indicator_id, name, unit, is_optional
    FROM resource_indicator
    ORDER BY is_optional, name
  `);


  if (!indicators.length) {
    lcaResults.append(el('p', 'lca-error', 'Keine Ressourcenindikatoren in der Datenbank gefunden.'));
    return;
  }


  const completeRoutes = viableRoutes().filter(route =>
    route.steps
      .filter(step => Number(step.is_required) === 1)
      .every(step => Boolean(moduleForStep(step)))
  );


  if (!completeRoutes.length) {
    lcaResults.append(
      el('p', 'lca-empty', 'Wähle eine vollständige Route und die erforderlichen Module aus.')
    );
    return;
  }


  const routeList = el('div', 'lca-routes');


  for (const route of completeRoutes) {
    try {
      const result = calculateRouteLca(route, indicators, fuAmount);
      const displayCaps = getDisplayCaps(indicators);


      routeList.append(
        renderLcaRoute(route, result, indicators, fuAmount, displayCaps)
      );


    } catch (error) {
      routeList.append(
        el('p', 'lca-error', `${route.name}: ${error.message}`)
      );
    }
  }


  lcaResults.append(routeList);
}


  function renderBoard() {
    const activeRoutes = viableRoutes();
    renderFeedstocks();
    renderPrimary();
    renderConnections(activeRoutes);
    renderFinal();
    renderTargets();
    checkRoute();
    renderLcaResults();
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
  lcaFuAmount.addEventListener('input', renderLcaResults);


  autoLoadPublishedDb().catch(error => {
    setDbStatus(`Fehler: ${error.message}`);
    setRouteStatus('invalid', 'Start fehlgeschlagen', error.message);
  });
})();

