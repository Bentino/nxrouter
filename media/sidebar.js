(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const send = type => vscode.postMessage({ type });
  let current;
  let previousView;
  let searchDraft = '';
  let searchTimer;
  let copyId = 0;
  const copies = new Map();
  const markdownActions = {
    openLink: url => vscode.postMessage({ type: 'link/open', url }),
    copy: text => new Promise((resolve, reject) => {
      const requestId = ++copyId;
      const timer = setTimeout(() => { copies.delete(requestId); reject(); }, 5000);
      copies.set(requestId, ok => { clearTimeout(timer); copies.delete(requestId); ok ? resolve() : reject(); });
      vscode.postMessage({ type: 'clipboard/copy', text, requestId });
    })
  };
  const statusCopy = { running: 'Working…', completed: 'Completed', partial: 'Partially completed', cancelled: 'Cancelled', failed: 'Failed', interrupted: 'Interrupted' };
  const statusIcon = { running: '◌', completed: '✓', partial: '◐', cancelled: '■', failed: '×', interrupted: '◐' };
  function executionLabel(turn) {
    const change = turn.escalation;
    return [turn.providerLabel || turn.providerId, turn.mode === 'manual' ? 'Manual' : change?.completed ? `↑ ${change.from} → ${change.to}` : turn.route,
      turn.modelName || turn.modelId, turn.effort && turn.effort !== 'default' ? turn.effort : '',
      change && !change.completed ? 'Escalation unavailable' : ''].filter(Boolean).join(' · ');
  }
  function activity(turn, row) {
    const key = JSON.stringify([turn.tools, turn.changedFiles]);
    if (key === row.activityKey) return;
    row.activityKey = key;
    // Preserve native details expansion and focused summaries across streaming snapshots.
    const previousOpen = new Set([...row.activity.querySelectorAll('details[open]')].map(item => item.dataset.id));
    const focused = row.activity.contains(document.activeElement) ? document.activeElement.closest('details')?.dataset.id : undefined;
    row.activity.replaceChildren();
    for (const tool of turn.tools || []) {
      const details = element('details', '', row.activity); details.dataset.id = tool.id; details.open = previousOpen.has(tool.id);
      const summary = element('summary', '', details);
      const icons = { running: '◌', success: '✓', failed: '×', cancelled: '■', rejected: '⊘', interrupted: '◐' };
      element('span', `${icons[tool.state]} ${tool.label}${tool.target ? ` ${tool.target}` : ''}`, summary);
      element('span', tool.state === 'success' ? 'Completed' : tool.state === 'running' ? 'Running' : tool.state[0].toUpperCase() + tool.state.slice(1), summary).className = ['success', 'running'].includes(tool.state) ? 'sr-only' : 'tool-outcome';
      const fields = element('dl', '', details);
      for (const [label, value] of [['Target', tool.target], ['Lines', tool.lineRange], ['Command', tool.command],
        ['Duration', Number.isFinite(tool.durationMs) ? `${tool.durationMs} ms` : undefined], ['Result', tool.state === 'success' ? 'Completed' : tool.state === 'running' ? 'In progress' : tool.state]]) {
        if (value) { element('dt', label, fields); element('dd', value, fields); }
      }
    }
    if (turn.changedFiles?.length) {
      const details = element('details', '', row.activity); details.dataset.id = 'files'; details.open = previousOpen.has('files');
      element('summary', `${turn.changedFiles.length} ${turn.changedFiles.length === 1 ? 'file' : 'files'} changed`, details);
      const files = element('ul', '', details); for (const path of turn.changedFiles) element('li', path, files);
    }
    if (focused) [...row.activity.querySelectorAll('details')].find(item => item.dataset.id === focused)?.querySelector('summary')?.focus({ preventScroll: true });
  }
  let draft = '';
  let draftSession;
  let pendingSend;
  let sendId = 0;
  let conversationRoot;
  let stickToBottom = true;
  let composerHeight = 112;
  document.getElementById('settings').addEventListener('click', () => send('settings'));
  function element(tag, text, parent = content) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent.append(node);
    return node;
  }
  function button(label, action, parent = content, disabled = false, key = label) {
    const node = element('button', label, parent);
    node.type = 'button'; node.disabled = disabled; node.dataset.focusKey = key;
    node.addEventListener('click', action);
    return node;
  }
  function responseCopyIcon(node, state = 'idle') {
    const paths = {
      idle: 'M6 5V2h12v12h-3M3 5h12v15H3Z',
      copied: 'm4 11 5 5L20 5',
      failed: 'm6 6 12 12M18 6 6 18'
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' })) {
      svg.setAttribute(name, value);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [name, value] of Object.entries({ d: paths[state], fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      path.setAttribute(name, value);
    }
    svg.append(path);
    node.replaceChildren(svg);
    node.dataset.copyState = state;
    node.title = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — retry' : 'Copy the full response as Markdown';
    node.setAttribute('aria-label', state === 'idle' ? 'Copy response' : `${node.title}. Copy response`);
  }
  function hasProvider(state) { return state.linkedProviders ? state.linkedProviders.some(provider => provider.selectable) : !!state.activeProviderId; }
  function render(state) {
    const viewChanged = previousView !== state.view; previousView = state.view;
    current = state;
    if (state.view === 'conversation' && state.chat) { renderChat(state); return; }
    conversationRoot?.dispose();
    conversationRoot = undefined;
    document.getElementById('navigation').replaceChildren();
    document.body.classList.remove('conversation');
    const focusKey = document.activeElement?.dataset?.focusKey;
    const selection = document.activeElement?.id === 'chat-search' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : undefined;
    content.replaceChildren();
    content.setAttribute('aria-busy', String(state.busy || state.view === 'loading'));
    document.getElementById('settings').disabled = state.busy;
    const workspace = document.getElementById('workspace');
    workspace.textContent = `Workspace: ${state.workspaceLabel}`;
    if (state.view !== 'sessions') clearTimeout(searchTimer);
    if (state.notice) element('p', state.notice).setAttribute('role', 'alert');
    if (state.view === 'loading') { element('p', 'Checking provider…').setAttribute('role', 'status'); return; }
    if (state.view === 'sessions' && state.history) {
      renderHistory(state, viewChanged, focusKey, selection); return;
    }
    if (state.view === 'firstRun') {
      element('h2', 'Connect an AI provider');
      element('p', 'Connect OpenAI to start using NX Router.');
    } else if (state.view === 'conversation') {
      button('Back to home', () => send('home'), content, state.busy);
      element('h2', 'New Chat');
      element('p', 'Start a New Chat to begin.');
    }
    {
      const navigation = element('nav', '', document.getElementById('navigation')); navigation.className = 'home-navigation'; navigation.setAttribute('aria-label', 'Chat');
      if (state.chat) button(state.chat.running ? 'Return to chat · Working…' : 'Return to chat', () => send('navigation/conversation'), navigation).className = 'primary';
      button('New Chat', () => send('newChat'), navigation, state.busy || !hasProvider(state));
    }
    const recent = element('section'); recent.className = 'recent-chats'; recent.setAttribute('aria-label', 'Recent chats');
    element('h2', 'Recent chats', recent);
    element('p', state.historyAvailable === false ? 'Open a trusted local single-folder workspace to save chats.' : 'Chats are saved locally for this workspace.', recent).className = 'muted';
    sessionRows(state.recentSessions || [], recent, state, false);
    button('View all', () => send('sessions/viewAll'), recent, state.busy, 'view-all');
    for (const provider of state.providers) {
      const section = element('section');
      section.setAttribute('aria-label', `${provider.label} provider`);
      if (state.view !== 'firstRun') {
        const status = element('p', `${provider.label} · ${provider.statusText}`, section); status.setAttribute('role', 'status');
        if (provider.description) element('p', provider.description, section);
      }
      if (provider.connection === 'connected') {
        element('p', provider.autoAvailable ? 'Auto Ready' : 'Auto routing unavailable', section).setAttribute('role', 'status');
        const mappingDetails = element('details', '', section); element('summary', 'Model mappings', mappingDetails);
        const mappings = element('dl', '', mappingDetails);
        for (const mapping of provider.mappings) {
          element('dt', mapping.role, mappings);
          element('dd', `${mapping.modelId || 'Not configured'}${mapping.validity === 'unavailable' ? ' · Unavailable' : ''}`, mappings);
        }
      }
      const actions = element('div', '', section); actions.className = 'actions';
      for (const action of provider.actions) {
        const labels = { connect: provider.connection === 'not_connected' ? `Continue with ${provider.label}` : 'Reconnect',
          configureModels: 'Configure models', status: 'Connection status', retry: 'Retry' };
        const control = button(labels[action], () => vscode.postMessage({ type: 'provider', providerId: provider.id, action }), actions, state.busy, `${provider.id}:${action}`);
        if ((action === 'connect' && provider.connection !== 'connected') || (action === 'configureModels' && !provider.autoAvailable) || action === 'retry') control.className = 'primary';
      }
    }
    const telemetry = element('p', `Local telemetry: ${state.telemetryEnabled ? 'enabled' : 'disabled'}`);
    telemetry.className = 'muted';
    button('Telemetry status', () => send('telemetry'), content, state.busy).className = 'secondary';
    const restoredFocus = [...document.querySelectorAll('button')].find(node => node.dataset.focusKey === focusKey && !node.disabled);
    if (restoredFocus) restoredFocus.focus();
    else if (viewChanged && !state.busy) (document.querySelector('#navigation button:enabled') || document.querySelector('.session-open') || document.querySelector('main button:enabled'))?.focus();
  }
  function sessionDate(iso) {
    const date = new Date(iso), now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(day); yesterday.setDate(day.getDate() - 1);
    return date >= day ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
      : date >= yesterday ? 'Yesterday' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
  }
  function sessionRows(rows, parent, state, deletable) {
    if (!rows.length) { element('p', state.history?.query ? 'No matching chats.' : 'No saved chats yet.', parent).className = 'muted'; return; }
    const list = element('ul', '', parent); list.className = 'session-list';
    for (const session of rows) {
      const item = element('li', '', list); item.className = 'session-row';
      const currentChat = state.chat?.sessionId === session.sessionId;
      const open = button('', () => vscode.postMessage({ type: 'sessions/open', sessionId: session.sessionId }), item, state.busy, `open:${session.sessionId}`);
      open.className = 'session-open';
      if (currentChat) open.setAttribute('aria-current', 'true');
      element('span', session.title, open).className = 'session-title';
      const timestamp = element('time', sessionDate(session.updatedAt), open); timestamp.dateTime = session.updatedAt; timestamp.title = new Date(session.updatedAt).toLocaleString();
      open.setAttribute('aria-label', `${session.title}, ${timestamp.title}${currentChat ? ', Current chat' : ''}`);
      if (currentChat) element('span', 'Current chat', open).className = 'session-current';
      if (session.snippet && session.snippet !== session.title) element('span', session.snippet, open).className = 'session-snippet';
      if (session.status === 'interrupted') element('span', 'Interrupted', open).className = 'muted';
      if (deletable) { const remove = button('Delete', () => vscode.postMessage({ type: 'sessions/delete', sessionId: session.sessionId }), item, state.busy, `delete:${session.sessionId}`);
        remove.className = 'session-delete'; remove.setAttribute('aria-label', `Delete chat: ${session.title}`); }
    }
  }
  function renderHistory(state, entered, focusKey, selection) {
    const navigation = element('nav', '', document.getElementById('navigation')); navigation.className = 'actions'; navigation.setAttribute('aria-label', 'Chats');
    button('Back', () => send('navigation/home'), navigation, state.busy, 'history-back');
    button('New Chat', () => send('chat/new'), navigation, state.busy || !hasProvider(state));
    element('h2', 'Chats');
    element('p', state.historyAvailable === false ? 'Open a trusted local single-folder workspace to save chats.' : 'Chats are saved locally for this workspace. New Chat starts a fresh conversation; saved chats can be reopened.', content).className = 'muted';
    const label = element('label', 'Search chats'); label.htmlFor = 'chat-search';
    const input = element('input'); input.id = 'chat-search'; input.type = 'text'; input.setAttribute('role', 'searchbox'); input.maxLength = 200; input.placeholder = 'Search chats…'; input.dataset.focusKey = 'chat-search';
    if (entered) searchDraft = state.history.query;
    input.value = searchDraft; input.disabled = state.busy;
    input.addEventListener('input', () => { searchDraft = input.value; clearTimeout(searchTimer);
      searchTimer = setTimeout(() => vscode.postMessage({ type: 'sessions/search', query: searchDraft, offset: 0 }), 180); });
    const results = element('section'); results.setAttribute('aria-label', 'Saved chats');
    sessionRows(state.history.items, results, state, true);
    element('p', `${state.history.items.length} chats shown${state.history.hasMore ? ' · More available' : ''}`, results).setAttribute('role', 'status');
    const pages = element('div'); pages.className = 'actions';
    if (state.history.offset) button('Previous', () => vscode.postMessage({ type: 'sessions/search', query: state.history.query, offset: Math.max(0, state.history.offset - 50) }), pages, state.busy, 'previous-page');
    if (state.history.hasMore) button('Next', () => vscode.postMessage({ type: 'sessions/search', query: state.history.query, offset: state.history.offset + 50 }), pages, state.busy, 'next-page');
    const focus = [...document.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey && !node.disabled);
    if (focus) { focus.focus(); if (selection && focus === input) input.setSelectionRange(...selection); }
    else if (!state.busy) { (entered ? input : document.querySelector('.session-open') || input).focus(); }
  }
  function chatAction(type, extra = {}) {
    if (current?.chat) vscode.postMessage({ type, sessionId: current.chat.sessionId, ...extra });
  }
  function providerActions(state, parent) {
    parent.replaceChildren();
    const provider = state.providers.find(provider => provider.id === state.chat.providerId);
    if (!provider) return;
    if (provider.connection !== 'connected' || !provider.autoAvailable) {
      element('p', provider.description || 'Configure models to enable Auto.', parent);
      const actions = element('div', '', parent); actions.className = 'actions';
      for (const action of provider.actions) {
        const labels = { connect: 'Reconnect', configureModels: 'Configure models', status: 'Connection status', retry: 'Retry' };
        const control = button(labels[action], () => vscode.postMessage({ type: 'provider', providerId: provider.id, action }), actions, state.busy);
        if (action === 'connect' || action === 'retry' || (action === 'configureModels' && !state.chat.canSend)) control.className = 'primary';
      }
    }
  }
  function renderChat(state) {
    document.body.classList.add('conversation');
    const chat = state.chat;
    const fresh = !conversationRoot || draftSession !== chat.sessionId;
    const wasRunning = conversationRoot?.running;
    if (fresh) {
      conversationRoot?.dispose();
      if (draftSession !== chat.sessionId) { pendingSend = undefined; if (chat.preserveDraftFromSessionId !== draftSession) draft = ''; stickToBottom = true; }
      draftSession = chat.sessionId;
      content.replaceChildren();
      const navigationSlot = document.getElementById('navigation'); navigationSlot.replaceChildren();
      const navigation = element('nav', '', navigationSlot); navigation.className = 'actions chat-navigation'; navigation.setAttribute('aria-label', 'Chat');
      const home = button('Home', () => send('navigation/home'), navigation);
      const newChat = button('New Chat', () => send('chat/new'), navigation);
      const attention = element('div'); attention.className = 'connection-attention';
      const thread = element('div'); thread.id = 'thread'; thread.setAttribute('role', 'log');
      thread.tabIndex = 0; thread.setAttribute('aria-label', 'Conversation'); thread.setAttribute('aria-live', 'off');
      thread.addEventListener('scroll', () => { stickToBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48; });
      const status = element('p'); status.id = 'execution-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const splitter = element('div'); splitter.className = 'chat-splitter'; splitter.tabIndex = 0;
      splitter.setAttribute('role', 'separator'); splitter.setAttribute('aria-orientation', 'horizontal');
      splitter.setAttribute('aria-label', 'Resize conversation and input'); splitter.setAttribute('aria-controls', 'thread prompt');
      splitter.title = 'Drag to resize input · Arrow keys to adjust · Double-click to reset';
      const composer = element('div'); composer.className = 'composer';
      const chips = element('div', '', composer); chips.className = 'context-chips'; chips.setAttribute('aria-label', 'Context for next message'); chips.setAttribute('role', 'list');
      const label = element('label', 'Ask NX', composer); label.htmlFor = 'prompt'; label.className = 'sr-only';
      const input = element('textarea', '', composer); input.id = 'prompt'; input.rows = 2; input.maxLength = 16000;
      input.placeholder = 'Ask NX…'; input.value = draft; input.setAttribute('aria-describedby', 'composer-help');
      const help = element('p', 'Enter to send · Shift+Enter for a new line', composer); help.id = 'composer-help'; help.className = 'sr-only';
      const controls = element('div', '', composer); controls.className = 'execution-controls';
      const addContext = button('+ Context', () => chatAction('context/openPicker'), controls); addContext.className = 'add-context'; addContext.setAttribute('aria-label', 'Add Context');
      const providerPicker = button('', () => chatAction('provider/openPicker'), controls); providerPicker.className = 'provider-picker'; providerPicker.setAttribute('aria-label', 'Switch provider');
      const autoLabel = element('label', '', controls); autoLabel.className = 'auto-switch';
      const auto = element('input', '', autoLabel); auto.type = 'checkbox'; auto.id = 'auto'; auto.setAttribute('role', 'switch'); auto.setAttribute('aria-label', 'Auto');
      element('span', '', autoLabel).className = 'switch-track'; autoLabel.append(document.createTextNode('Auto '));
      const autoState = element('span', '', autoLabel); autoState.className = 'auto-state'; auto.addEventListener('change', () => chatAction('execution/setAuto', { on: auto.checked }));
      const manual = element('div', '', controls); manual.className = 'manual-controls';
      const modelLabel = element('label', 'Model', manual); modelLabel.htmlFor = 'manual-model'; modelLabel.className = 'sr-only';
      const model = element('select', '', manual); model.id = 'manual-model';
      model.addEventListener('change', () => chatAction('execution/selectModel', { providerId: current.chat.providerId, modelId: model.value }));
      const effortLabel = element('label', 'Effort', manual); effortLabel.htmlFor = 'manual-effort'; effortLabel.className = 'sr-only';
      const effort = element('select', '', manual); effort.id = 'manual-effort';
      effort.addEventListener('change', () => chatAction('execution/selectEffort', { effort: effort.value }));
      const blocked = element('p', '', composer); blocked.className = 'muted';
      const submit = button('Send', () => {
        if (current.chat.running) chatAction('chat/stop');
        else sendPrompt();
      }, controls); submit.className = 'primary'; submit.setAttribute('aria-label', 'Send');
      function sendPrompt() {
        if (current.busy || !current.chat.canSend || !input.value.trim()) return;
        if (pendingSend) return;
        pendingSend = { sessionId: current.chat.sessionId, text: input.value, requestId: ++sendId };
        chatAction('chat/send', { text: input.value, requestId: pendingSend.requestId });
        updateSubmit();
      }
      function updateSubmit() { submit.disabled = current.chat.running ? false : current.busy || !!pendingSend || !current.chat.canSend || !input.value.trim(); }
      input.addEventListener('input', () => { draft = input.value; updateSubmit(); });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendPrompt(); }
      });
      function resizeComposer(height = composerHeight) {
        const minimum = chips.offsetHeight + (chips.offsetHeight ? 5 : 0) + controls.offsetHeight + blocked.offsetHeight + (blocked.offsetHeight ? 8 : 0) + 67;
        const maximum = Math.max(minimum, composer.getBoundingClientRect().height + thread.clientHeight - 60);
        const size = Math.round(Math.max(minimum, Math.min(maximum, height)));
        const following = stickToBottom;
        composerHeight = size; composer.style.height = `${size}px`;
        splitter.setAttribute('aria-valuemin', String(minimum)); splitter.setAttribute('aria-valuemax', String(Math.round(maximum)));
        splitter.setAttribute('aria-valuenow', String(size)); splitter.setAttribute('aria-valuetext', `Input height ${size} pixels`);
        if (following) thread.scrollTop = thread.scrollHeight;
      }
      let drag;
      splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); splitter.setPointerCapture(event.pointerId);
        drag = { y: event.clientY, height: composer.getBoundingClientRect().height };
        splitter.classList.add('dragging');
      });
      splitter.addEventListener('pointermove', event => { if (drag) resizeComposer(drag.height + drag.y - event.clientY); });
      const endDrag = () => { drag = undefined; splitter.classList.remove('dragging'); };
      splitter.addEventListener('lostpointercapture', endDrag);
      splitter.addEventListener('pointerup', event => { splitter.releasePointerCapture(event.pointerId); endDrag(); });
      splitter.addEventListener('pointercancel', endDrag);
      splitter.addEventListener('dblclick', () => resizeComposer(112));
      splitter.addEventListener('keydown', event => {
        const heights = { ArrowUp: composerHeight + 16, ArrowDown: composerHeight - 16, Home: 0, End: Infinity };
        if (Object.hasOwn(heights, event.key)) { event.preventDefault(); resizeComposer(heights[event.key]); }
      });
      const observer = new ResizeObserver(() => resizeComposer());
      for (const node of [content, chips, controls, attention, status, blocked]) observer.observe(node);
      conversationRoot = { providerPicker, boundaries: new Map(), chips, addContext, home, newChat, attention, thread, status, input, auto, autoState, model, effort, manual, blocked, submit, updateSubmit,
        dispose: () => observer.disconnect(),
        rendered: new Map(), running: false, catalogKey: '', effortKey: '' };
      input.focus();
    }
    const ui = conversationRoot;
    ui.running = chat.running;
    if (pendingSend?.sessionId === chat.sessionId && chat.messages.some(message => message.role === 'user' && message.text === pendingSend.text && !ui.knownUsers?.has(message.id))) {
      if (ui.input.value === pendingSend.text) { draft = ''; ui.input.value = ''; }
      pendingSend = undefined;
    }
    ui.knownUsers = new Set(chat.messages.filter(message => message.role === 'user').map(message => message.id));
    ui.addContext.disabled = state.busy || chat.running || chat.contextAvailable === false;
    ui.addContext.title = chat.contextAvailable === false ? 'Open a trusted single local workspace to attach context' : 'Attach explicit context for the next message';
    const chipKey = JSON.stringify([chat.draftContext, chat.running, state.busy]);
    if (ui.chipKey !== chipKey) {
      const focusedId = document.activeElement?.dataset.contextId;
      ui.chips.replaceChildren();
      for (const ref of chat.draftContext || []) {
        const chip = element('span', '', ui.chips); chip.className = 'context-chip'; chip.setAttribute('role', 'listitem');
        const label = element('span', ref.label, chip); label.title = ref.label;
        const remove = button('×', () => chatAction('context/remove', { id: ref.id }), chip, state.busy || chat.running);
        remove.dataset.contextId = ref.id; remove.setAttribute('aria-label', `Remove ${ref.label}`); remove.title = `Remove ${ref.label}`;
      }
      if (focusedId) (Array.from(ui.chips.querySelectorAll('button')).find(button => button.dataset.contextId === focusedId) || ui.addContext).focus({ preventScroll: true });
      ui.chipKey = chipKey;
    }
    ui.providerPicker.hidden = !chat.providerPickerAvailable; ui.providerPicker.disabled = state.busy;
    ui.providerPicker.textContent = `${chat.providerLabel || chat.providerId} ▾`;
    ui.home.disabled = state.busy; ui.newChat.disabled = state.busy || !hasProvider(state);
    content.setAttribute('aria-busy', String(state.busy));
    document.getElementById('settings').disabled = state.busy;
    document.getElementById('workspace').textContent = `Workspace: ${state.workspaceLabel}`;
    // Keep the textarea, message nodes, focus, selection and scroll position during deltas.
    const connectionKey = JSON.stringify([state.providers, state.busy, state.notice]);
    if (ui.connectionKey !== connectionKey) { providerActions(state, ui.attention); if (state.notice) element('p', state.notice, ui.attention).setAttribute('role', 'alert'); ui.connectionKey = connectionKey; }
    for (const message of chat.messages) {
      let row = ui.rendered.get(message.id);
      if (!row) {
        const article = element('article', '', ui.thread); article.className = `message ${message.role}`;
        element('h2', message.role === 'user' ? 'You' : 'NX', article);
        row = { article, references: element('div', '', article), activity: element('div', '', article), text: element('div', '', article), state: element('p', '', article) }; row.activity.className = 'tool-activity';
        row.text.className = 'message-text'; row.state.className = 'muted'; ui.rendered.set(message.id, row);
        if (message.role === 'assistant') {
          row.copy = button('Copy response', async () => {
            const value = row.value;
            try { await markdownActions.copy(value); if (row.value === value) responseCopyIcon(row.copy, 'copied'); }
            catch { if (row.value === value) responseCopyIcon(row.copy, 'failed'); }
          }, article);
          row.copy.className = 'copy-response icon-button';
          responseCopyIcon(row.copy);
        }
      }
      const refsKey = JSON.stringify(message.references);
      if (row.refsKey !== refsKey) {
        row.references.replaceChildren(); row.references.className = 'historical-context';
        if (message.role === 'user' && message.references?.length) {
          row.references.setAttribute('aria-label', 'Attached context'); row.references.setAttribute('role', 'list');
          for (const ref of message.references) {
            const label = (ref.kind === 'file' || ref.kind === 'image') ? `${ref.kind === 'image' ? 'Image · ' : ''}${ref.path}${ref.scope === 'external' ? ' · External' : ''}` : ref.kind === 'selection' ? `Selection · ${ref.path} ${ref.startLine}–${ref.endLine}` : ref.kind === 'diagnostics' ? `Diagnostics · ${ref.count} items${ref.omitted ? ` (${ref.omitted} omitted)` : ''}` : `Git diff · ${ref.count} files`;
            const chip = element('span', label, row.references); chip.className = 'context-chip'; chip.setAttribute('role', 'listitem'); chip.title = label;
          }
        }
        row.refsKey = refsKey;
      }
      if (row.value !== message.text) {
        if (message.role === 'assistant') window.nxMarkdown.render(message.text, row.text, markdownActions);
        else row.text.textContent = message.text;
        row.value = message.text;
        if (row.copy) { responseCopyIcon(row.copy); row.copy.disabled = !message.text; }
      }
      if (message.turn) activity(message.turn, row);
      row.state.textContent = message.turn ? `${statusIcon[message.turn.status]} ${statusCopy[message.turn.status]}${executionLabel(message.turn) ? ` · ${executionLabel(message.turn)}` : ''}`
        : message.status ? `${statusIcon[message.status]} ${statusCopy[message.status]}` : '';
      row.state.title = message.turn?.notice || '';
    }
    for (const [index, segment] of (chat.segments || []).entries()) {
      if (!index) continue;
      let boundary = ui.boundaries.get(segment.id);
      if (!boundary) { boundary = element('div', '', ui.thread); boundary.className = 'provider-boundary'; boundary.setAttribute('role', 'note'); ui.boundaries.set(segment.id, boundary); }
      const previous = chat.segments[index - 1];
      boundary.textContent = `${previous.providerLabel} → ${segment.providerLabel} · ${segment.contextCarryMode === 'selected' ? `${segment.carryCount || 0} context items selected to carry` : 'Continue fresh'} · Previous conversation stays local`;
      ui.thread.insertBefore(boundary, ui.rendered.get(chat.messages[segment.startIndex]?.id)?.article || null);
    }
    if (!chat.messages.length && !ui.guidance) {
      ui.guidance = element('div', '', ui.thread); ui.guidance.className = 'empty-guidance';
      element('h2', 'Ask NX about this workspace', ui.guidance);
      const examples = element('ul', '', ui.guidance);
      for (const example of ['Explain this project', 'Find where routing is implemented', 'Check current diagnostics']) element('li', example, examples);
    }
    if (chat.messages.length && ui.guidance) { ui.guidance.remove(); ui.guidance = undefined; }
    // Announce turn-state transitions, not each token/tool update.
    const statusText = chat.running ? chat.status || 'Working…' : chat.status || '';
    if (ui.status.textContent !== statusText) ui.status.textContent = statusText;
    ui.status.className = chat.running ? '' : 'sr-only';
    ui.auto.checked = chat.autoOn; ui.auto.setAttribute('aria-checked', String(chat.autoOn)); ui.autoState.textContent = chat.autoOn ? 'ON' : 'OFF'; ui.auto.disabled = state.busy || chat.running || !chat.autoAvailable;
    ui.auto.title = chat.autoAvailable ? 'Use Router to select a model for each turn' : 'Auto unavailable: check connection and model mappings';
    ui.manual.hidden = chat.autoOn;
    const catalogKey = JSON.stringify([chat.models, chat.manualModelId]);
    if (catalogKey !== ui.catalogKey) {
      ui.model.replaceChildren();
      const placeholder = element('option', chat.manualModelId && !chat.manualValid ? 'Selected model unavailable — choose a model' : 'Choose a model', ui.model);
      placeholder.value = ''; placeholder.disabled = true;
      for (const model of chat.models) { const option = element('option', model.name || model.id, ui.model); option.value = model.id; }
      ui.model.value = chat.models.some(model => model.id === chat.manualModelId) ? chat.manualModelId : '';
      ui.catalogKey = catalogKey;
    }
    ui.model.disabled = state.busy || chat.running || !chat.models.length;
    const effortKey = JSON.stringify([chat.effortOptions, chat.manualEffort]);
    if (effortKey !== ui.effortKey) {
      ui.effort.replaceChildren();
      const defaultOption = element('option', 'Default', ui.effort); defaultOption.value = 'default';
      for (const effort of chat.effortOptions) { const option = element('option', effort, ui.effort); option.value = effort; }
      ui.effort.value = chat.manualEffort || 'default'; ui.effortKey = effortKey;
    }
    ui.effort.hidden = !chat.effortOptions.length;
    ui.effort.disabled = state.busy || chat.running || !chat.manualValid || !chat.effortOptions.length;
    ui.blocked.textContent = chat.contextNotice || state.notice || chat.blockedReason || '';
    ui.blocked.setAttribute('role', chat.contextNotice ? 'alert' : 'status');
    ui.submit.textContent = chat.running ? 'Stop' : 'Send'; ui.submit.setAttribute('aria-label', chat.running ? 'Stop' : 'Send'); ui.updateSubmit();
    if (stickToBottom) ui.thread.scrollTop = ui.thread.scrollHeight;
    if (wasRunning && !chat.running && (document.activeElement === ui.submit || document.activeElement === document.body)) ui.input.focus();
  }
  window.addEventListener('message', event => {
    if (event.data?.type === 'state') render(event.data.state);
    else if (event.data?.type === 'sendResult' && pendingSend?.sessionId === event.data.sessionId && pendingSend.requestId === event.data.requestId) {
      if (event.data.ok && conversationRoot?.input.value === pendingSend.text) { draft = ''; conversationRoot.input.value = ''; }
      pendingSend = undefined; conversationRoot?.updateSubmit();
    }
    else if (event.data?.type === 'copyResult') copies.get(event.data.requestId)?.(event.data.ok === true);
  });
  send('ready');
})();
