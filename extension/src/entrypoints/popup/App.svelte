<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getConnections,
    removeConnection,
    updateConnection,
    getRelayLog,
    clearLog,
    getSettings,
    setSettings,
    addConnection,
  } from '../../lib/storage';
  import { fetchSpec, hashSpec } from '../../lib/protocol';
  import { uuid } from '../../lib/uuid';
  import {
    type Connection,
    type EndpointSpec,
    type EventType,
    type RelayLogEntry,
    type ExtensionSettings,
    PROTOCOL_VERSION,
  } from '../../lib/types';

  type Tab = 'connections' | 'events' | 'settings';
  type AddStep = null | 'form' | 'transparency' | 'done';

  const ALL_EVENT_TYPES: EventType[] = ['conversation.complete', 'conversation.captured', 'manual.push'];

  let activeTab = $state<Tab>('connections');
  let connections = $state<Connection[]>([]);
  let log = $state<RelayLogEntry[]>([]);
  let settings = $state<ExtensionSettings>({
    enabled: true,
    privacyMode: false,
    claudeAiSyncEnabled: true,
    claudeAiSyncPeriodMin: 30,
  });
  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  // Add-connection flow
  let addStep = $state<AddStep>(null);
  let formName = $state('');
  let formEndpoint = $state('');
  let formToken = $state('');
  let formScopes = $state('claude.ai/*');
  let formEvents = $state<EventType[]>(['manual.push', 'conversation.complete']);
  let probedSpec = $state<EndpointSpec | null>(null);
  let probedHash = $state<string>('');

  onMount(refresh);

  async function refresh(): Promise<void> {
    connections = await getConnections();
    log = await getRelayLog();
    settings = await getSettings();
  }

  function openAddFlow(): void {
    addStep = 'form';
    formName = '';
    formEndpoint = '';
    formToken = '';
    formScopes = 'claude.ai/*';
    formEvents = ['manual.push', 'conversation.complete'];
    probedSpec = null;
    probedHash = '';
    error = null;
  }

  async function probeEndpoint(): Promise<void> {
    error = null;
    if (!formEndpoint.trim()) {
      error = 'Endpoint URL required.';
      return;
    }
    busy = true;
    try {
      const spec = await fetchSpec(formEndpoint.trim());
      probedSpec = spec;
      probedHash = await hashSpec(spec);
      if (!formName) formName = spec.name;
      addStep = 'transparency';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function acceptAndSave(): Promise<void> {
    if (!probedSpec) return;
    busy = true;
    try {
      const scopes = formScopes
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(pattern => ({ pattern }));

      const summary = `This connection will send ${formEvents.join(', ')} from pages matching [${scopes.map(s => s.pattern).join(', ')}] to ${formEndpoint.trim()} (declared name: ${probedSpec.name}, data flow: ${probedSpec.dataFlow}).`;

      const conn: Connection = {
        id: uuid(),
        name: formName.trim() || probedSpec.name,
        endpointUrl: formEndpoint.trim(),
        authToken: formToken.trim() || undefined,
        scopes,
        events: formEvents,
        trustAcceptance: {
          acceptedAt: new Date().toISOString(),
          dataFlowSummary: summary,
          version: PROTOCOL_VERSION,
          specHash: probedHash,
        },
        enabled: true,
        createdAt: new Date().toISOString(),
        totalEventsRelayed: 0,
      };
      await addConnection(conn);
      addStep = 'done';
      info = `Connection "${conn.name}" added.`;
      setTimeout(() => { info = null; }, 3000);
      await refresh();
      setTimeout(() => { addStep = null; }, 800);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function toggleConnection(c: Connection): Promise<void> {
    await updateConnection(c.id, { enabled: !c.enabled });
    await refresh();
  }

  async function revoke(c: Connection): Promise<void> {
    await removeConnection(c.id);
    await refresh();
  }

  async function manualPush(): Promise<void> {
    error = null;
    info = null;
    busy = true;
    try {
      const r = (await browser.runtime.sendMessage({ type: 'CAPTURE_CURRENT_TAB' })) as
        | { ok: true; relayed: number }
        | { ok: false; error: string };
      if (r.ok) {
        info = r.relayed === 0
          ? 'No connection matched the current tab URL.'
          : `Relayed to ${r.relayed} connection${r.relayed === 1 ? '' : 's'}.`;
        await refresh();
      } else {
        error = r.error;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      setTimeout(() => { info = null; }, 4000);
    }
  }

  async function toggleEnabled(): Promise<void> {
    settings = { ...settings, enabled: !settings.enabled };
    await setSettings({ enabled: settings.enabled });
  }

  async function togglePrivacy(): Promise<void> {
    settings = { ...settings, privacyMode: !settings.privacyMode };
    await setSettings({ privacyMode: settings.privacyMode });
  }

  async function toggleClaudeAiSync(): Promise<void> {
    settings = { ...settings, claudeAiSyncEnabled: !settings.claudeAiSyncEnabled };
    await setSettings({ claudeAiSyncEnabled: settings.claudeAiSyncEnabled });
  }

  async function clearAllLog(): Promise<void> {
    await clearLog();
    log = [];
  }

  function toggleEvent(e: EventType): void {
    formEvents = formEvents.includes(e)
      ? formEvents.filter(x => x !== e)
      : [...formEvents, e];
  }

  function shortTime(ts: string): string {
    const d = new Date(ts);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  }
</script>

<div class="root">
  <header class="topbar">
    <div class="brand">
      <span class="brand-dot" class:on={settings.enabled}></span>
      <span class="brand-name">Conversation Bridge</span>
    </div>
    <button class="push-btn" onclick={manualPush} disabled={busy} title="Capture current tab and relay to matching connections">
      Push
    </button>
  </header>

  <nav class="tabs">
    <button class="tab" class:active={activeTab === 'connections'} onclick={() => activeTab = 'connections'}>
      Connections
      <span class="count">{connections.length}</span>
    </button>
    <button class="tab" class:active={activeTab === 'events'} onclick={() => activeTab = 'events'}>
      Events
      <span class="count">{log.length}</span>
    </button>
    <button class="tab" class:active={activeTab === 'settings'} onclick={() => activeTab = 'settings'}>
      Settings
    </button>
  </nav>

  {#if error}
    <div class="banner banner-error">{error}</div>
  {/if}
  {#if info}
    <div class="banner banner-info">{info}</div>
  {/if}

  <main class="content">
    {#if activeTab === 'connections'}
      {#if addStep === 'form'}
        <section class="card">
          <h2>Add connection</h2>
          <p class="hint">Step 1 of 2: tell the extension where to send events.</p>
          <label>
            <span>Endpoint URL</span>
            <input type="url" bind:value={formEndpoint} placeholder="http://localhost:8000" />
          </label>
          <label>
            <span>Auth token (optional)</span>
            <input type="text" bind:value={formToken} placeholder="Bearer token, if your endpoint requires one" />
          </label>
          <label>
            <span>Scope patterns (comma-separated)</span>
            <input type="text" bind:value={formScopes} placeholder="claude.ai/*, claude.ai/share/*" />
          </label>
          <fieldset>
            <legend>Event types</legend>
            {#each ALL_EVENT_TYPES as e}
              <label class="checkbox">
                <input type="checkbox" checked={formEvents.includes(e)} onchange={() => toggleEvent(e)} />
                <span>{e}</span>
              </label>
            {/each}
          </fieldset>
          <div class="row">
            <button class="btn ghost" onclick={() => addStep = null}>Cancel</button>
            <button class="btn primary" onclick={probeEndpoint} disabled={busy || !formEndpoint}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </section>
      {:else if addStep === 'transparency' && probedSpec}
        <section class="card">
          <h2>Review and accept</h2>
          <p class="hint">Step 2 of 2: this is exactly what will happen.</p>
          <div class="spec">
            <div class="spec-row"><span>Endpoint name</span><strong>{probedSpec.name}</strong></div>
            <div class="spec-row"><span>Endpoint URL</span><strong class="mono">{formEndpoint}</strong></div>
            <div class="spec-row"><span>Endpoint version</span><strong>{probedSpec.version}</strong></div>
            <div class="spec-row"><span>Accepts events</span><strong>{probedSpec.accepts.join(', ')}</strong></div>
            {#if probedSpec.contact}
              <div class="spec-row"><span>Contact</span><strong>{probedSpec.contact}</strong></div>
            {/if}
            {#if probedSpec.repository}
              <div class="spec-row"><span>Repository</span><strong class="mono">{probedSpec.repository}</strong></div>
            {/if}
          </div>
          <div class="dataflow">
            <span class="dataflow-label">What this endpoint says it does with your data:</span>
            <p>{probedSpec.dataFlow}</p>
          </div>
          <div class="dataflow">
            <span class="dataflow-label">What this extension will send:</span>
            <ul>
              <li>From pages matching <code>{formScopes}</code></li>
              <li>When these events fire: <code>{formEvents.join(', ')}</code></li>
              <li>Payload includes: conversation messages, page title, URL, share URL (if any)</li>
              <li>{formToken ? 'Authorization: Bearer <your token>' : 'No auth token attached'}</li>
            </ul>
          </div>
          <div class="row">
            <button class="btn ghost" onclick={() => addStep = 'form'}>Back</button>
            <button class="btn primary" onclick={acceptAndSave} disabled={busy}>
              {busy ? 'Saving…' : 'Accept and enable'}
            </button>
          </div>
        </section>
      {:else}
        <div class="row spread">
          <span class="section-title">Configured connections</span>
          <button class="btn primary small" onclick={openAddFlow}>+ Add</button>
        </div>
        {#if connections.length === 0}
          <div class="card empty">
            <p>No connections configured.</p>
            <p class="hint">Add one to point this extension at your endpoint.</p>
          </div>
        {:else}
          {#each connections as c (c.id)}
            <article class="conn-card">
              <header class="conn-head">
                <span class="conn-dot" class:on={c.enabled}></span>
                <strong class="conn-name">{c.name}</strong>
                <label class="switch" title={c.enabled ? 'Enabled' : 'Disabled'}>
                  <input type="checkbox" checked={c.enabled} onchange={() => toggleConnection(c)} />
                  <span class="slider"></span>
                </label>
              </header>
              <div class="conn-body">
                <div class="conn-row"><span>Endpoint</span><span class="mono">{c.endpointUrl}</span></div>
                <div class="conn-row"><span>Scopes</span><span>{c.scopes.map(s => s.pattern).join(', ')}</span></div>
                <div class="conn-row"><span>Events</span><span>{c.events.join(', ')}</span></div>
                <div class="conn-row"><span>Relayed</span><span>{c.totalEventsRelayed} events</span></div>
                {#if c.lastActiveAt}
                  <div class="conn-row"><span>Last active</span><span>{shortTime(c.lastActiveAt)}</span></div>
                {/if}
              </div>
              <details class="trust">
                <summary>What you approved</summary>
                <p>{c.trustAcceptance.dataFlowSummary}</p>
                <p class="hint">Accepted {shortTime(c.trustAcceptance.acceptedAt)} · protocol v{c.trustAcceptance.version}</p>
              </details>
              <footer class="conn-foot">
                <button class="btn danger small" onclick={() => revoke(c)}>Revoke</button>
              </footer>
            </article>
          {/each}
        {/if}
      {/if}
    {:else if activeTab === 'events'}
      <div class="row spread">
        <span class="section-title">Recent events</span>
        {#if log.length > 0}
          <button class="btn ghost small" onclick={clearAllLog}>Clear log</button>
        {/if}
      </div>
      {#if log.length === 0}
        <div class="card empty">
          <p>No events relayed yet.</p>
          <p class="hint">Successful + failed relays will appear here.</p>
        </div>
      {:else}
        <ul class="log">
          {#each log as e (e.id)}
            <li class="log-item">
              <span class="log-dot" class:err={e.status === 'error'}></span>
              <div class="log-body">
                <div class="log-line"><strong>{e.eventType}</strong> → {e.connectionName}</div>
                <div class="log-detail">{e.status === 'success' ? (e.detail || 'accepted') : (e.detail || 'failed')}</div>
              </div>
              <span class="log-time">{shortTime(e.timestamp)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if activeTab === 'settings'}
      <section class="card">
        <h2>Settings</h2>
        <div class="setting-row">
          <div>
            <span class="label">Bridge enabled</span>
            <p class="hint">Master switch. When off, no events are relayed.</p>
          </div>
          <label class="switch">
            <input type="checkbox" checked={settings.enabled} onchange={toggleEnabled} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div>
            <span class="label">Privacy mode</span>
            <p class="hint">Strip message content; relay only metadata + counts.</p>
          </div>
          <label class="switch">
            <input type="checkbox" checked={settings.privacyMode} onchange={togglePrivacy} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="setting-row">
          <div>
            <span class="label">Auto-sync claude.ai</span>
            <p class="hint">
              Poll your claude.ai conversations in the background (every
              {settings.claudeAiSyncPeriodMin} min) using your existing session.
              Relays new/updated chats as conversation.captured events.
            </p>
          </div>
          <label class="switch">
            <input type="checkbox" checked={settings.claudeAiSyncEnabled} onchange={toggleClaudeAiSync} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="about">
          <p class="hint">Protocol version: {PROTOCOL_VERSION}</p>
          <p class="hint">
            <a href="https://github.com/liamhodgsonhollingsworth/conversation-bridge" target="_blank" rel="noopener">
              github.com/liamhodgsonhollingsworth/conversation-bridge
            </a>
          </p>
        </div>
      </section>
    {/if}
  </main>
</div>

<style>
  .root {
    display: flex;
    flex-direction: column;
    min-height: 440px;
    max-height: 600px;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: white;
    border-bottom: 1px solid #e4e4e7;
  }
  .brand { display: flex; align-items: center; gap: 8px; }
  .brand-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #d4d4d8;
  }
  .brand-dot.on { background: #22c55e; }
  .brand-name { font-size: 13px; font-weight: 600; color: #18181b; }
  .push-btn {
    font-size: 11px; font-weight: 600;
    padding: 6px 12px;
    border-radius: 6px;
    background: #18181b; color: white;
    border: none; cursor: pointer;
  }
  .push-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .tabs {
    display: flex;
    background: white;
    border-bottom: 1px solid #e4e4e7;
  }
  .tab {
    flex: 1;
    padding: 10px 8px;
    font-size: 11px; font-weight: 500;
    background: none; border: none; cursor: pointer;
    color: #71717a;
    border-bottom: 2px solid transparent;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .tab:hover { color: #18181b; }
  .tab.active {
    color: #18181b;
    border-bottom-color: #18181b;
  }
  .count {
    font-size: 10px;
    background: #f4f4f5;
    padding: 1px 6px;
    border-radius: 10px;
    color: #71717a;
  }
  .tab.active .count { background: #18181b; color: white; }

  .banner {
    padding: 8px 12px; font-size: 11px;
  }
  .banner-error { background: #fef2f2; color: #b91c1c; border-bottom: 1px solid #fecaca; }
  .banner-info { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .row { display: flex; gap: 8px; align-items: center; }
  .row.spread { justify-content: space-between; }
  .section-title {
    font-size: 11px; font-weight: 600;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .card {
    background: white;
    border: 1px solid #e4e4e7;
    border-radius: 8px;
    padding: 14px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .card h2 { font-size: 13px; font-weight: 600; color: #18181b; }
  .card.empty { text-align: center; color: #71717a; font-size: 12px; }
  .card.empty p { margin: 4px 0; }
  .hint { font-size: 11px; color: #a1a1aa; }

  label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #52525b; }
  label > span { font-weight: 500; }
  input[type=url], input[type=text] {
    padding: 7px 10px; font-size: 12px;
    border: 1px solid #e4e4e7; border-radius: 6px;
    background: #fafafa; color: #18181b;
  }
  input[type=url]:focus, input[type=text]:focus {
    outline: none; border-color: #18181b;
    background: white;
  }
  fieldset {
    border: 1px solid #e4e4e7;
    border-radius: 6px;
    padding: 8px 10px;
    display: flex; flex-direction: column; gap: 6px;
  }
  legend {
    font-size: 11px; color: #71717a;
    padding: 0 4px;
  }
  .checkbox {
    display: flex; flex-direction: row; align-items: center; gap: 6px;
    font-size: 12px;
  }
  .checkbox input { margin: 0; }

  .btn {
    padding: 7px 14px; font-size: 12px; font-weight: 500;
    border-radius: 6px; cursor: pointer; border: 1px solid transparent;
  }
  .btn.primary { background: #18181b; color: white; }
  .btn.primary:hover:not(:disabled) { background: #27272a; }
  .btn.ghost { background: #f4f4f5; color: #3f3f46; }
  .btn.ghost:hover:not(:disabled) { background: #e4e4e7; }
  .btn.danger { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
  .btn.danger:hover { background: #fee2e2; }
  .btn.small { padding: 4px 10px; font-size: 11px; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .spec { display: flex; flex-direction: column; gap: 4px; }
  .spec-row {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 11px; gap: 8px;
  }
  .spec-row span { color: #71717a; }
  .spec-row strong { color: #18181b; text-align: right; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }

  .dataflow {
    background: #fafafa;
    border: 1px solid #e4e4e7;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
  }
  .dataflow-label {
    font-size: 11px; color: #71717a;
    display: block; margin-bottom: 4px; font-weight: 500;
  }
  .dataflow p, .dataflow li { line-height: 1.4; color: #3f3f46; }
  .dataflow ul { padding-left: 18px; }
  .dataflow code {
    font-family: ui-monospace, monospace; font-size: 11px;
    background: white; padding: 1px 4px; border-radius: 3px;
    border: 1px solid #e4e4e7;
  }

  .conn-card {
    background: white;
    border: 1px solid #e4e4e7;
    border-radius: 8px;
    padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .conn-head { display: flex; align-items: center; gap: 8px; }
  .conn-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #d4d4d8; flex-shrink: 0;
  }
  .conn-dot.on { background: #22c55e; }
  .conn-name { flex: 1; font-size: 12px; color: #18181b; }
  .conn-body { display: flex; flex-direction: column; gap: 3px; }
  .conn-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
  .conn-row span:first-child { color: #71717a; }
  .conn-row span:last-child { color: #3f3f46; text-align: right; word-break: break-all; }
  .conn-foot { display: flex; justify-content: flex-end; }
  .trust summary {
    font-size: 11px; color: #71717a; cursor: pointer;
    padding: 4px 0;
  }
  .trust p {
    font-size: 11px; color: #52525b;
    margin-top: 4px; line-height: 1.4;
  }

  .switch {
    position: relative; width: 32px; height: 18px;
    display: inline-block; flex-shrink: 0;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; inset: 0; cursor: pointer;
    background: #d4d4d8; border-radius: 9px;
    transition: background 0.15s;
  }
  .slider::before {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 14px; height: 14px;
    border-radius: 50%; background: white;
    transition: transform 0.15s;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }
  .switch input:checked + .slider { background: #18181b; }
  .switch input:checked + .slider::before { transform: translateX(14px); }

  .log {
    list-style: none; display: flex; flex-direction: column; gap: 6px;
  }
  .log-item {
    display: flex; align-items: flex-start; gap: 8px;
    background: white;
    border: 1px solid #e4e4e7;
    border-radius: 6px;
    padding: 8px 10px;
  }
  .log-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #22c55e; margin-top: 5px; flex-shrink: 0;
  }
  .log-dot.err { background: #ef4444; }
  .log-body { flex: 1; min-width: 0; }
  .log-line { font-size: 12px; color: #18181b; }
  .log-detail { font-size: 11px; color: #71717a; margin-top: 2px; word-break: break-all; }
  .log-time { font-size: 10px; color: #a1a1aa; flex-shrink: 0; }

  .setting-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 6px 0;
  }
  .setting-row .label { font-size: 12px; font-weight: 500; color: #18181b; display: block; }
  .about { margin-top: 6px; padding-top: 10px; border-top: 1px solid #f4f4f5; }
  .about a { color: #18181b; }
</style>
