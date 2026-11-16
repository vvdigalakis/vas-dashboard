/* Dashboard app: logs in to Dropbox in the browser, reads and edits vas-work files directly.
   No server. The Dropbox key lives only in this tab (sessionStorage) and expires in about 4 hours.
   Single source of truth: projects and levels come from PORTFOLIO.md; status and work items from each NOTES.md.
   Today's and this week's work are Next items marked in place: "- [today YYYY-MM-DD] …", "- [week <Monday>] …". */
(function () {
  'use strict';
  const V = window.VW, esc = V.esc;
  const APP_KEY = '';  // Dropbox app key (public by design). Empty: asked once, kept in this browser.
  const API = 'https://api.dropboxapi.com/2/', CONTENT = 'https://content.dropboxapi.com/2/';
  const REDIRECT = location.origin + location.pathname;
  const app = document.getElementById('app'), toast = document.getElementById('toast');
  const store = kind => ({
    get: k => { try { return window[kind].getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { window[kind].setItem(k, v); } catch (e) { /* storage blocked */ } },
    del: k => { try { window[kind].removeItem(k); } catch (e) { /* storage blocked */ } },
  });
  const ss = store('sessionStorage'), ls = store('localStorage');
  const appKey = () => APP_KEY || ls.get('vw_app_key') || '';
  const pad = n => String(n).padStart(2, '0');
  const today = () => new Date().toLocaleDateString('en-CA');
  const stamp = () => { const d = new Date(); return `${today()}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const short = f => String(f).replace(/^\d{4}_/, '');
  const GROUPS = ['high', 'medium', 'low', 'parked', 'completed', 'archived'];

  const S = {
    token: null, root: ss.get('vw_root') || '', base: ls.get('vw_base'),
    port: null, folders: [], notes: {}, completed: [], archived: [], cosNames: [], reqNames: [], doneNames: [], suggestText: '',
    extraNotes: {}, det: new Set(), detClosed: new Set(), editor: null, editing: null, picking: null, busy: false, loadedAt: 0,
    filter: new Set((ls.get('vw_filter') || 'high,medium').split(',').filter(g => GROUPS.includes(g))),
    sort: ls.get('vw_sort') || 'priority',
  };
  { const t = ss.get('vw_token'), exp = +ss.get('vw_exp') || 0; if (t && Date.now() < exp) S.token = t; }

  function say(msg, kind) {
    toast.textContent = msg;
    toast.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(say.t);
    say.t = setTimeout(() => { toast.className = 'toast'; }, kind === 'bad' ? 9000 : 2500);
  }

  // ---------- Dropbox ----------
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const argHeader = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

  async function startLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    ss.set('vw_verifier', verifier);
    location.href = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: appKey(), response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', redirect_uri: REDIRECT, token_access_type: 'online',
    });
  }

  async function finishLogin(code) {
    history.replaceState(null, '', REDIRECT);
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: ss.get('vw_verifier') || '', client_id: appKey(), redirect_uri: REDIRECT }),
    });
    const j = await r.json();
    ss.del('vw_verifier');
    if (!r.ok) throw new Error('Login failed: ' + (j.error_description || r.status));
    S.token = j.access_token;
    ss.set('vw_token', S.token);
    ss.set('vw_exp', String(Date.now() + ((j.expires_in || 14400) - 60) * 1000));
    S.root = '';
    const acct = await rpc('users/get_current_account', null);
    const ri = acct.root_info || {};
    if (ri.root_namespace_id && ri.root_namespace_id !== ri.home_namespace_id) S.root = JSON.stringify({ '.tag': 'root', root: ri.root_namespace_id });
    ss.set('vw_root', S.root);
  }

  function logout() {
    if (S.token) fetch(API + 'auth/token/revoke', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } }).catch(() => {});
    S.token = null; S.port = null;
    ['vw_token', 'vw_exp', 'vw_root'].forEach(ss.del);
    render();
  }

  function headers(extra) {
    const h = Object.assign({ Authorization: 'Bearer ' + S.token }, extra);
    if (S.root) h['Dropbox-API-Path-Root'] = S.root;
    return h;
  }

  function expired() { S.token = null; ['vw_token', 'vw_exp'].forEach(ss.del); render(); return new Error('Session expired. Log in again.'); }

  async function rpc(ep, body) {
    const r = await fetch(API + ep, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (r.status === 401) throw expired();
    const t = await r.text();
    if (!r.ok) { const e = new Error(`${ep}: ${r.status} ${t.slice(0, 200)}`); e.status = r.status; throw e; }
    return t ? JSON.parse(t) : null;
  }

  async function download(path) {
    const r = await fetch(CONTENT + 'files/download', { method: 'POST', headers: headers({ 'Dropbox-API-Arg': argHeader({ path }) }) });
    if (r.status === 401) throw expired();
    if (r.status === 409) return null;
    if (!r.ok) throw new Error(`Could not read ${path} (${r.status})`);
    const h = r.headers.get('Dropbox-API-Result');
    const text = await r.text();
    const meta = h ? JSON.parse(h) : await rpc('files/get_metadata', { path });
    return { text, rev: meta.rev, modified: meta.server_modified || '' };
  }

  // rev given: overwrite only if the file is unchanged since we read it. No rev: create a new file.
  async function upload(path, text, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
    const r = await fetch(CONTENT + 'files/upload', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path, mode, autorename: false, mute: true }) }),
      body: new TextEncoder().encode(text),
    });
    if (r.status === 401) throw expired();
    const t = await r.text();
    if (r.status === 409 && /conflict/.test(t)) { const e = new Error('conflict'); e.conflict = true; throw e; }
    if (!r.ok) throw new Error(`Could not save ${path} (${r.status} ${t.slice(0, 200)})`);
    return JSON.parse(t);
  }

  async function listFolder(path) {
    let res;
    try { res = await rpc('files/list_folder', { path }); } catch (e) { if (e.status === 409) return []; throw e; }
    const out = res.entries.slice();
    while (res.has_more) { res = await rpc('files/list_folder/continue', { cursor: res.cursor }); out.push(...res.entries); }
    return out;
  }

  async function findBase() {
    const s = await rpc('files/search_v2', { query: 'PORTFOLIO.md', options: { filename_only: true, max_results: 50 } });
    const hit = s.matches.map(m => m.metadata.metadata.path_display).find(p => /\/vas-work\/_system\/PORTFOLIO\.md$/i.test(p));
    if (!hit) throw new Error('Could not find vas-work/_system/PORTFOLIO.md in this Dropbox.');
    const base = hit.replace(/\/_system\/PORTFOLIO\.md$/i, '');
    ls.set('vw_base', base);
    return base;
  }

  const projectPath = (group, folder) => `${S.base}/research/projects-${group === 'completed' || group === 'archived' ? group : 'active'}/${folder}`;

  async function load() {
    say('Loading…');
    if (!S.base) S.base = await findBase();
    const b = S.base, P = b + '/research/';
    const [port, act, comp, arch, cos, req, done, sug] = await Promise.all([
      download(b + '/_system/PORTFOLIO.md'), listFolder(P + 'projects-active'), listFolder(P + 'projects-completed'),
      listFolder(P + 'projects-archived'), listFolder(b + '/_system/cos-log'), listFolder(b + '/_system/requests'),
      listFolder(b + '/_system/requests/done'), listFolder(b + '/_system/suggestions'),
    ]);
    if (!port) { ls.del('vw_base'); S.base = null; throw new Error('PORTFOLIO.md not found. Refresh to search again.'); }
    const dirs = es => es.filter(e => e['.tag'] === 'folder' && !e.name.startsWith('.')).map(e => e.name).sort();
    const files = es => es.filter(e => e['.tag'] === 'file').map(e => e.name).sort();
    const folders = dirs(act);
    const todaySug = files(sug).filter(n => n.startsWith(today())).pop();
    const [notes, sugFile] = await Promise.all([
      Promise.all(folders.map(f => download(`${P}projects-active/${f}/NOTES.md`))),
      todaySug ? download(`${b}/_system/suggestions/${todaySug}`) : null,
    ]);
    Object.assign(S, { port, folders, completed: dirs(comp), archived: dirs(arch), cosNames: files(cos), reqNames: files(req), doneNames: files(done),
      suggestText: sugFile ? sugFile.text : '', notes: {}, loadedAt: Date.now() });
    folders.forEach((f, i) => { S.notes[f] = notes[i]; });
    say('Up to date', 'ok');
    render();
  }

  async function loadExtra(group, folder) {
    const k = group + '/' + folder;
    if (k in S.extraNotes) return;
    S.extraNotes[k] = null;
    S.extraNotes[k] = await download(projectPath(group, folder) + '/NOTES.md');
    S.extraNotes[k] = S.extraNotes[k] || false;
    render();
  }

  // ---------- Saving ----------
  async function save(path, current, fn, msg, onSaved, keepOnConflict) {
    if (S.busy) return false;
    S.busy = true; say('Saving…');
    try {
      const text = fn(current.text);
      if (text === current.text) { say('No changes'); return true; }
      const meta = await upload(path, text, current.rev);
      onSaved({ text, rev: meta.rev, modified: meta.server_modified || new Date().toISOString() });
      say(msg || 'Saved', 'ok');
      render();
      return true;
    } catch (e) {
      if (!e.conflict) { say(e.message || String(e), 'bad'); return false; }
      if (keepOnConflict) { say('The file changed elsewhere. Nothing was overwritten. Copy your text, cancel, and reopen.', 'bad'); return false; }
      S.busy = false;
      await load();
      say('The file changed elsewhere, so nothing was overwritten. Reloaded: please redo your change.', 'bad');
      return false;
    } finally { S.busy = false; }
  }
  const savePortfolio = (fn, msg, keep) => save(S.base + '/_system/PORTFOLIO.md', S.port, fn, msg, v => { S.port = v; }, keep);
  const saveNotes = (folder, fn, msg, keep) => save(projectPath('active', folder) + '/NOTES.md', S.notes[folder], fn, msg, v => { S.notes[folder] = v; }, keep);
  const saveProjects = (fn, msg) => savePortfolio(t => V.writeProjects(t, fn(V.parsePortfolio(t).projects)), msg);

  async function saveFields(folder, fd) {
    const n = S.notes[folder], meta = V.parseNotes(n.text).meta;
    const lines = s => String(s || '').split('\n').map(clean).filter(Boolean);
    let t = n.text; const changed = [];
    for (const k of ['next', 'deadline']) {
      const v = clean(fd[k]);
      if (v !== (meta[k] || '')) { t = V.setFrontmatter(t, k, v); changed.push(k); }
    }
    for (const k of ['waiting_on_me', 'i_wait_on']) {
      const v = lines(fd[k]);
      if (JSON.stringify(v) !== JSON.stringify(V.asList(meta[k]))) { t = V.setFrontmatter(t, k, v); changed.push(k); }
    }
    if (!changed.length) return say('No changes');
    t = V.addLog(t, `- ${today()} [app]: updated ${changed.join(', ')}`);
    if (await saveNotes(folder, () => t, 'Saved')) { S.editing = null; render(); }
  }

  // A message is a new file; it never edits anything.
  async function leaveMessage(fd, folder) {
    const text = String(fd.text || '').trim();
    if (!text) return;
    say('Saving…');
    if (folder) {
      await upload(`${projectPath('active', folder)}/inbox/${stamp()}_vas-note.md`, `# Note from Vas (dashboard app)\n\n${new Date().toLocaleString('en-US')}\n\n${text}\n`, null);
      say('Saved in the project inbox. The next session folds it in.', 'ok');
    } else {
      const name = `${stamp()}_request.md`;
      await upload(`${S.base}/_system/requests/${name}`, `# Request from Vas (dashboard app)\n\nWritten: ${new Date().toLocaleString('en-US')}\nProject: ${fd.project || 'all'}\n\n${text}\n`, null);
      S.reqNames.push(name);
      say('Message saved. The next agent session acts on it.', 'ok');
    }
    render();
  }

  // ---------- Model ----------
  function model() {
    const port = V.parsePortfolio(S.port.text);
    const listed = new Map(port.projects.map(p => [p.folder, p]));
    const t = today(), tn = V.dayNum(t), wk = V.monday(t);
    const projects = S.folders.map(f => {
      const n = S.notes[f], pn = n ? V.parseNotes(n.text) : { meta: {}, body: '' }, e = listed.get(f) || null;
      const lt = V.dayNum(pn.meta.last_touched);
      return { folder: f, group: e ? (V.LEVELS.includes(e.level) ? e.level : 'low') : 'low', hasNotes: !!n, meta: pn.meta, body: pn.body, entry: e,
        next: n ? V.nextItems(n.text) : null,
        idle: e && e.level !== 'parked' && lt != null && tn - lt >= 14 ? tn - lt : 0 };
    });
    projects.sort((a, b) => (a.entry ? a.entry.rank : 1e6) - (b.entry ? b.entry.rank : 1e6) || a.folder.localeCompare(b.folder));
    const marked = mark => projects.flatMap(p => (p.next ? p.next.items.filter(i => i.mark === mark).map(i => Object.assign({ folder: p.folder, group: p.group }, i)) : []));
    const todays = marked('today').filter(i => i.date <= t), weeks = marked('week');
    // Suggestions: Dobbie's file for today if there is one, else computed from the notes.
    let suggestions, by = 'Suggested';
    const fromDobbie = V.parseSuggestions(S.suggestText);
    if (fromDobbie.length) {
      by = 'Dobbie suggests';
      suggestions = fromDobbie.map(s => {
        const p = projects.find(x => x.folder === s.folder), it = p && p.next && p.next.items.find(i => i.text.trim().toLowerCase() === s.text.trim().toLowerCase());
        return it ? { folder: p.folder, group: p.group, line: it.line, text: it.text, mark: it.mark, date: it.date, why: '' } : { folder: s.folder, group: 'low', text: s.text, missing: true };
      }).filter(s => s.missing || !(s.mark === 'today' && s.date === t));
    } else suggestions = V.suggest(projects, t, 3).map(s => Object.assign({ group: (projects.find(p => p.folder === s.folder) || {}).group }, s));
    const newest = [S.port].concat(S.folders.map(f => S.notes[f])).filter(Boolean).map(x => x.modified).filter(Boolean).sort().pop() || '';
    return { port, projects, t, wk, todays, weeks, suggestions, by, newest,
      exceptions: V.computeExceptions(port, projects, t), cos: V.cosStatus(S.cosNames, new Date()), pending: V.pendingRequests(S.reqNames, S.doneNames) };
  }

  // ---------- Rendering ----------
  const route = () => { const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')); const m = /^p\/(\w+)\/(.+)$/.exec(h); return m ? { view: 'project', group: m[1], folder: m[2] } : { view: h || 'home' }; };
  const det = (key, defOpen) => `data-key="${esc(key)}"${S.det.has(key) || (defOpen && !S.detClosed.has(key)) ? ' open' : ''}`;
  const kv = (k, v, cls) => `<div class="kv"><span>${k}</span><span class="${cls || ''}">${esc(v || '—')}</span></div>`;
  const when = iso => {
    if (!iso) return '—';
    const d = new Date(iso), t = new Date(), y = new Date(Date.now() - 864e5);
    const hm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === t.toDateString() ? 'today ' + hm : d.toDateString() === y.toDateString() ? 'yesterday ' + hm : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + hm;
  };
  const itemAttrs = i => `data-folder="${esc(i.folder)}" data-line="${i.line}" data-text="${esc(i.text)}"`;

  function render() {
    if (!S.token) return renderLogin();
    if (!S.port) { app.innerHTML = '<p class="muted">Loading…</p>'; return; }
    if (S.editor) return renderEditor();
    const M = model(), r = route();
    app.innerHTML = r.view === 'project' ? projectView(M, r.group, r.folder) : r.view === 'week' ? weekView(M) : homeView(M);
  }

  function renderLogin() {
    const key = appKey();
    app.innerHTML = `<section class="card pad login"><h1>Vas Chief of Staff Dashboard</h1>
      ${key ? '<button class="btn primary" data-act="login">Log in with Dropbox</button>'
        : '<form data-form="appkey" class="stack"><label>Dropbox app key<input name="key" required autocomplete="off" spellcheck="false"></label><button class="btn primary">Save key</button></form>'}
    </section>`;
  }

  function renderEditor() {
    const ed = S.editor;
    app.innerHTML = `<header class="top"><button class="back" data-act="editor-cancel">‹ Cancel</button><button class="btn primary small" data-act="editor-save">Save</button></header>
      <p class="label">${esc(ed.label)}</p>
      <textarea id="editor-text" class="editor" spellcheck="false" aria-label="File text">${esc(ed.text)}</textarea>
      <p class="small muted">Saved straight to Dropbox. If an agent changed the file in the meantime, nothing is overwritten.</p>`;
  }

  function statusBar(M) {
    const cos = M.cos.last ? 'Dobbie checked ' + M.cos.last.slice(5) : 'Dobbie has not checked yet';
    return `<header class="titlebar"><h1>Vas Chief of Staff Dashboard</h1><div class="topbar"><button class="icon" data-act="reload" aria-label="Refresh">↻</button>
      <details class="menu" ${det('menu')}><summary aria-label="Menu">⋯</summary><div class="menubox"><button data-act="edit-portfolio">Edit PORTFOLIO.md</button><button data-act="logout">Log out</button></div></details></div></header>
      <p class="statusline">Updated ${esc(when(M.newest))} · Loaded ${esc(when(new Date(S.loadedAt).toISOString()))} · <span class="${M.cos.stale ? 'bad' : ''}">${esc(cos)}</span></p>`;
  }

  function workRow(i, opts) {
    const o = opts || {};
    return `<div class="work"><span class="bar g-${esc(i.group || 'low')}"></span><span class="grow">${i.folder ? `<span class="proj">${esc(short(i.folder))}</span>` : ''}${esc(i.text)}${o.note ? `<span class="sub">${esc(o.note)}</span>` : ''}</span>
      <span class="acts">${o.acts || ''}</span></div>`;
  }

  function homeView(M) {
    let h = statusBar(M);
    // Message for agents: one simple bar.
    h += `<form class="msgbar" data-form="message">
      <textarea name="text" rows="1" required placeholder="Message for agents…" aria-label="Message for agents"></textarea>
      <select name="project" aria-label="About"><option value="">About: anything</option>${M.projects.map(p => `<option value="${esc(p.folder)}">About: ${esc(short(p.folder))}</option>`).join('')}</select>
      <button class="send" aria-label="Leave message">➤</button></form>
      ${M.pending.length ? `<p class="statusline">${M.pending.length} message${M.pending.length > 1 ? 's' : ''} not yet picked up by an agent.</p>` : ''}`;
    // Today
    h += `<section class="card pad"><div class="cardhead2"><span class="label">Today · ${esc(new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</span><a class="link" href="#/week">This week (${M.weeks.filter(i => i.date === M.wk).length}) ›</a></div>`;
    if (M.todays.length) {
      h += M.todays.map(i => workRow(i, {
        note: i.date < M.t ? `carried over from ${i.date}` : '',
        acts: (i.date < M.t ? `<button class="btn small" data-act="mark" data-mark="today" ${itemAttrs(i)}>Keep</button>` : '')
          + `<button class="icon done" data-act="complete" ${itemAttrs(i)} aria-label="Done">✓</button><button class="icon" data-act="mark" data-mark="" ${itemAttrs(i)} aria-label="Remove from today">✕</button>`,
      })).join('');
    } else h += '<p class="empty">Nothing picked for today yet.</p>';
    if (M.todays.length < 3 && M.suggestions.length) {
      h += `<p class="label sublabel">${esc(M.by)}</p>` + M.suggestions.map(s => (s.missing
        ? workRow(s, { note: 'not found in the notes; ask Dobbie to use an existing Next item' })
        : workRow(s, { note: s.why ? 'why: ' + s.why : '', acts: `<button class="btn small" data-act="mark" data-mark="today" ${itemAttrs(s)}>Do today</button>` }))).join('');
    }
    h += `<button class="link-btn" data-act="pick" data-mark="${S.picking === 'today' ? '' : 'today'}">${S.picking === 'today' ? 'Close' : 'Pick something else from the notes…'}</button>`;
    if (S.picking === 'today') h += picker(M, 'today');
    if (M.exceptions.length) h += `<details class="alerts" ${det('alerts')}><summary>⚠ ${M.exceptions.length} alert${M.exceptions.length > 1 ? 's' : ''}</summary>${M.exceptions.map(e => `<div class="exc">${esc(e)}</div>`).join('')}</details>`;
    h += '</section>';
    h += projectsSection(M);
    h += obligationsCard(M);
    return h;
  }

  // Next items of ranked, non-parked projects, to mark for today or this week.
  function picker(M, mark) {
    const date = mark === 'week' ? M.wk : M.t;
    const free = i => !(i.mark === mark && i.date === date);
    const ps = M.projects.filter(p => p.entry && p.group !== 'parked' && p.next && p.next.items.some(free));
    return `<div class="picker">${ps.map(p => `<div class="pgroup"><p class="pname"><span class="dot g-${p.group}"></span>${esc(short(p.folder))}</p>`
      + p.next.items.filter(free).map(i => `<button class="pitem" data-act="mark" data-mark="${mark}" ${itemAttrs(Object.assign({ folder: p.folder }, i))}>${esc(i.text)}${i.mark ? ` <span class="chip">${esc(i.mark)}</span>` : ''}</button>`).join('') + '</div>').join('')}</div>`;
  }

  function projectsSection(M) {
    let rows = M.projects.map(p => ({ folder: p.folder, group: p.group, rank: p.entry ? p.entry.rank : 1e6, due: (p.entry && p.entry.due) || '', last: p.meta.last_touched || '', p }))
      .concat(S.completed.map(f => ({ folder: f, group: 'completed', rank: 2e6, due: '', last: '' })), S.archived.map(f => ({ folder: f, group: 'archived', rank: 3e6, due: '', last: '' })));
    const counts = Object.fromEntries(GROUPS.map(g => [g, rows.filter(r => r.group === g).length]));
    rows = rows.filter(r => S.filter.has(r.group));
    const cmp = { priority: (a, b) => a.rank - b.rank, due: (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.rank - b.rank,
      name: (a, b) => short(a.folder).localeCompare(short(b.folder)), last: (a, b) => (b.last || '').localeCompare(a.last || '') || a.rank - b.rank }[S.sort] || ((a, b) => a.rank - b.rank);
    rows.sort(cmp);
    const chips = GROUPS.map(g => `<button class="fchip g-${g}" data-act="filter" data-group="${g}" aria-pressed="${S.filter.has(g)}"><span class="dot g-${g}"></span>${g} <span class="n">${counts[g]}</span></button>`).join('');
    const sortSel = `<select class="sortsel" data-change="sort" aria-label="Sort">${[['priority', 'Priority'], ['due', 'Due date'], ['name', 'Name'], ['last', 'Last work']].map(([k, l]) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>Sort: ${l}</option>`).join('')}</select>`;
    const row = r => `<a class="prow" href="#/p/${r.group === 'completed' || r.group === 'archived' ? r.group : 'active'}/${encodeURIComponent(r.folder)}"><span class="bar g-${r.group}"></span>
      <span class="name">${esc(short(r.folder))}</span>${r.p && V.asList(r.p.meta.waiting_on_me).length ? '<span class="chip warn">waits on you</span>' : ''}${r.p && r.p.idle ? `<span class="chip">idle ${r.p.idle}d</span>` : ''}
      <span class="due">${esc(S.sort === 'last' ? r.last : r.due)}</span><span class="chev" aria-hidden="true">›</span></a>`;
    return `<section class="card"><div class="cardhead"><span class="label">Projects</span>${sortSel}</div><div class="fchips">${chips}</div>
      ${rows.length ? rows.map(row).join('') : '<p class="empty pad">No projects match. Tap a filter above.</p>'}</section>`;
  }

  function obligationsCard(M) {
    const t = V.dayNum(M.t);
    const ob = M.port.obligations.slice().sort((a, b) => a.date.localeCompare(b.date));
    const cls = o => { const d = V.dayNum(o.date.replace(/\?$/, '')); return d == null ? '' : d < t ? 'over' : d - t <= 7 ? 'soon' : ''; };
    const nSoon = ob.filter(o => cls(o)).length;
    const rows = ob.length ? ob.map(o => `<div class="ob"><span class="${cls(o)}">${esc(o.date)}</span><span class="grow">${esc(o.task)}<span class="sub">${esc(o.area)}${o.notes ? ' · ' + esc(o.notes) : ''}</span></span>
      <button class="icon" data-act="ob-done" data-idx="${o.idx}" aria-label="Done: remove">✓</button></div>`).join('') : '<p class="empty">None.</p>';
    return `<section class="card"><details ${det('obligations')}><summary class="cardsum"><span class="label">Obligations · ${ob.length}</span>${nSoon ? `<span class="chip warn">${nSoon} due soon</span>` : ''}</summary><div class="inner">${rows}
      <details class="adder" ${det('add-ob')}><summary>+ Add an obligation</summary>
      <form class="grid2" data-form="ob-add">
        <label>Date<input name="date" type="date" required></label>
        <label>Area<select name="area"><option>teaching</option><option>service</option><option>admin</option></select></label>
        <label class="span2">Task<input name="task" required></label>
        <label class="span2">Notes<input name="notes"></label>
        <div class="formend"><button class="btn primary">Add</button></div></form></details></div></details></section>`;
  }

  function weekView(M) {
    let h = `<header class="top"><a class="back" href="#/">‹ Today</a><span class="label">This week · from ${esc(M.wk)}</span></header><section class="card pad">`;
    const items = M.weeks.filter(i => i.date === M.wk), old = M.weeks.filter(i => i.date !== M.wk);
    h += items.length ? items.map(i => workRow(i, { acts: `<button class="btn small" data-act="mark" data-mark="today" ${itemAttrs(i)}>Today</button><button class="icon done" data-act="complete" ${itemAttrs(i)} aria-label="Done">✓</button><button class="icon" data-act="mark" data-mark="" ${itemAttrs(i)} aria-label="Remove from week">✕</button>` })).join('')
      : '<p class="empty">Nothing planned for this week yet.</p>';
    if (old.length) h += `<p class="label sublabel">From an earlier week</p>` + old.map(i => workRow(i, { note: 'week of ' + i.date, acts: `<button class="btn small" data-act="mark" data-mark="week" ${itemAttrs(i)}>Keep</button><button class="icon" data-act="mark" data-mark="" ${itemAttrs(i)} aria-label="Drop">✕</button>` })).join('');
    h += `<button class="link-btn" data-act="pick" data-mark="${S.picking === 'week' ? '' : 'week'}">${S.picking === 'week' ? 'Close' : 'Pick from the notes…'}</button>`;
    if (S.picking === 'week') h += picker(M, 'week');
    return h + '<p class="sub">Up to about 8 items. Dobbie or a Monday planning session can propose them.</p></section>';
  }

  function projectView(M, group, folder) {
    const active = group === 'active';
    const p = active ? M.projects.find(x => x.folder === folder) : null;
    if (active && !p) return '<header class="top"><a class="back" href="#/">‹ Today</a></header><p class="empty">Project not found.</p>';
    let h = `<header class="top"><a class="back" href="#/">‹ Today</a>`;
    if (!active) {
      const k = group + '/' + folder, n = S.extraNotes[k];
      if (!(k in S.extraNotes)) loadExtra(group, folder).catch(e => say(e.message, 'bad'));
      h += `<span class="chip">${esc(group)}</span></header><h1><span class="dot big g-${esc(group)}"></span>${esc(short(folder))}</h1>`;
      if (!n && n !== false) return h + '<p class="empty">Loading notes…</p>';
      if (n === false) return h + '<p class="empty">No NOTES.md in this project.</p>';
      return h + notesBlock(V.parseNotes(n.text).body, k, true);
    }
    const e = p.entry, m = p.meta, f = esc(folder), cur = e ? (e.level || 'low') : '';
    const opts = (e ? '' : '<option value="">Rank as…</option>') + V.LEVELS.map(l => `<option value="${l}"${l === cur ? ' selected' : ''}>${l}</option>`).join('');
    h += `<div class="controls"><select data-change="level" data-folder="${f}" aria-label="Level">${opts}</select>
      ${e && cur !== 'parked' ? `<button class="btn small" data-act="move" data-dir="-1" data-folder="${f}" aria-label="Rank up">↑</button><button class="btn small" data-act="move" data-dir="1" data-folder="${f}" aria-label="Rank down">↓</button>` : ''}</div></header>
      <h1><span class="dot big g-${p.group}"></span>${esc(short(folder))}${e && cur !== 'parked' ? ` <span class="muted rankno">#${e.rank}</span>` : ''}</h1>`;
    if (S.editing === folder) {
      h += `<section class="card pad">`;
      if (e) h += `<form class="grid2" data-form="target" data-folder="${f}"><label>${cur === 'parked' ? 'Reason parked' : 'Target'}<input name="target" value="${esc(e.target)}"></label><label>Due<input name="due" value="${esc(e.due)}" placeholder="YYYY-MM-DD"></label><div class="formend"><button class="btn">Save target</button></div></form>`;
      if (p.hasNotes) h += `<form class="grid2" data-form="fields" data-folder="${f}">
        <label class="span2">Next (one line)<input name="next" value="${esc(m.next || '')}"></label>
        <label>Waiting on me <span class="hint">one per line: Name: what (since date)</span><textarea name="waiting_on_me" rows="2">${esc(V.asList(m.waiting_on_me).join('\n'))}</textarea></label>
        <label>I wait on <span class="hint">one per line</span><textarea name="i_wait_on" rows="2">${esc(V.asList(m.i_wait_on).join('\n'))}</textarea></label>
        <label class="span2">Hard deadline <span class="hint">external only</span><input name="deadline" value="${esc(m.deadline || '')}"></label>
        <div class="formend"><button type="button" class="btn ghost" data-act="edit-close">Cancel</button><button class="btn primary">Save</button></div></form>`;
      h += '</section>';
    } else {
      h += `<section class="card pad summary">
        ${kv(cur === 'parked' ? 'Parked' : 'Target', e ? [e.target, e.due].filter(Boolean).join(' · ') : 'Not in PORTFOLIO')}
        ${kv('Waiting on me', V.asList(m.waiting_on_me).join('; '), V.asList(m.waiting_on_me).length ? 'warn' : '')}
        ${kv('I wait on', V.asList(m.i_wait_on).join('; '))}
        ${m.deadline ? kv('Hard deadline', m.deadline) : ''}
        ${kv('Last real work', (m.last_touched || '') + (p.idle ? ` (${p.idle} days ago)` : ''), p.idle ? 'warn' : '')}
        <div class="rowbtns"><button class="btn small" data-act="edit-open" data-folder="${f}">Edit details</button>${p.hasNotes ? `<button class="btn small ghost" data-act="edit-notes" data-folder="${f}">Edit NOTES.md</button>` : ''}</div></section>`;
    }
    if (!p.hasNotes) return h + '<p class="empty">No NOTES.md yet. Open the project in a session to create it.</p>';
    // Next items with today / week / done.
    const items = p.next.items;
    h += `<section class="card pad"><p class="label">Next</p>${items.length ? items.map(i => {
      const it = Object.assign({ folder, group: p.group }, i), isToday = i.mark === 'today' && i.date === M.t, isWeek = i.mark === 'week' && i.date === M.wk;
      return `<div class="work"><span class="bar g-${p.group}"></span><span class="grow">${esc(i.text)}</span><span class="acts">`
        + `<button class="tog${isToday ? ' on' : ''}" data-act="mark" data-mark="${isToday ? '' : 'today'}" ${itemAttrs(it)} aria-pressed="${isToday}">today</button>`
        + `<button class="tog${isWeek ? ' on' : ''}" data-act="mark" data-mark="${isWeek ? '' : 'week'}" ${itemAttrs(it)} aria-pressed="${isWeek}">week</button>`
        + `<button class="icon done" data-act="complete" ${itemAttrs(it)} aria-label="Done">✓</button></span></div>`;
    }).join('') : '<p class="empty">No Next items.</p>'}
      <form class="addrow" data-form="add-item" data-folder="${f}"><input name="item" required placeholder="Add a next step"><button class="btn small">Add</button></form></section>`;
    // Note for this project's inbox.
    h += `<section class="card pad"><p class="label">Leave a note for this project</p><form class="ask" data-form="note" data-folder="${f}">
      <textarea name="text" rows="1" required placeholder="Goes to ${esc(short(folder))}/inbox/. The next session folds it into the notes."></textarea><span></span><button class="btn primary">Leave</button></form></section>`;
    h += notesBlock(p.body, folder, false);
    h += `<p class="small muted">${esc(m.phase || '')}${m.role ? ' · ' + esc(m.role) : ''}${V.asList(m.collaborators).length ? ' · ' + esc(V.asList(m.collaborators).join(', ')) : ''}</p>`;
    return h;
  }

  // Notes, one collapsible block per section; Status open by default. The Next list is shown above, not repeated.
  function notesBlock(body, key, openAll) {
    const parts = body.split(/^(?=## )/m).filter(s => s.trim());
    return '<section class="card notescard">' + parts.map(s => {
      const nl = s.indexOf('\n'), head = s.startsWith('## ') ? s.slice(3, nl < 0 ? undefined : nl).trim() : 'Notes';
      let txt = s.startsWith('## ') ? (nl < 0 ? '' : s.slice(nl + 1)) : s;
      if (!openAll) txt = txt.replace(/^### Next[ \t]*\n(?:(?!#{2,3} )[^\n]*\n?)*/m, '');
      return `<details ${det('n:' + key + ':' + head, openAll ? head === 'Status' || head === 'Brief' : head === 'Status')}><summary>${esc(head)}</summary><div class="notes">${V.mdToHtml(txt)}</div></details>`;
    }).join('') + '</section>';
  }

  // ---------- Events ----------
  app.addEventListener('toggle', ev => {
    const k = ev.target.dataset && ev.target.dataset.key;
    if (!k) return;
    if (ev.target.open) { S.det.add(k); S.detClosed.delete(k); } else { S.det.delete(k); S.detClosed.add(k); }
  }, true);

  window.addEventListener('hashchange', () => { S.det.delete('menu'); S.editing = null; S.picking = null; render(); window.scrollTo(0, 0); });

  app.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const d = b.dataset, act = d.act, folder = d.folder, line = +d.line;
    try {
      switch (act) {
        case 'login': await startLogin(); break;
        case 'reload': S.det.delete('menu'); await load(); break;
        case 'logout': logout(); break;
        case 'pick': S.picking = d.mark || null; render(); break;
        case 'mark': {
          const mark = d.mark, date = mark === 'week' ? V.monday(today()) : today();
          if (await saveNotes(folder, t => V.markItem(t, line, d.text, mark, date), mark ? `Marked for ${mark === 'today' ? 'today' : 'this week'}` : 'Unmarked')) { S.picking = null; render(); }
          break;
        }
        case 'complete': if (confirm(`Done: "${d.text}"?\nIt moves from Next to the Log.`)) await saveNotes(folder, t => V.completeItem(t, line, d.text, today(), 'app'), 'Done ✓'); break;
        case 'filter': { const g = d.group; if (S.filter.has(g)) S.filter.delete(g); else S.filter.add(g); ls.set('vw_filter', [...S.filter].join(',')); render(); break; }
        case 'edit-open': S.editing = folder; render(); break;
        case 'edit-close': S.editing = null; render(); break;
        case 'move': await saveProjects(l => V.moveProject(l, folder, +d.dir), 'Moved'); break;
        case 'ob-done': if (confirm('Done? This removes the line from PORTFOLIO.md.')) await savePortfolio(t => V.removeItem(t, +d.idx), 'Obligation done'); break;
        case 'edit-portfolio': S.det.delete('menu'); S.editor = { kind: 'portfolio', label: '_system/PORTFOLIO.md', text: S.port.text }; render(); break;
        case 'edit-notes': S.editor = { kind: 'notes', folder, label: folder + '/NOTES.md', text: S.notes[folder].text }; render(); break;
        case 'editor-cancel': {
          const v = document.getElementById('editor-text').value;
          if (v === S.editor.text || confirm('Discard your changes?')) { S.editor = null; render(); }
          break;
        }
        case 'editor-save': {
          const v = document.getElementById('editor-text').value, ed = S.editor;
          const ok = ed.kind === 'portfolio' ? await savePortfolio(() => v, 'PORTFOLIO.md saved', true) : await saveNotes(ed.folder, () => v, 'NOTES.md saved', true);
          if (ok) { S.editor = null; render(); }
          break;
        }
        default: break;
      }
    } catch (e) { say(e.message || String(e), 'bad'); }
  });

  app.addEventListener('submit', async ev => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(form)), folder = form.dataset.folder;
    try {
      switch (form.dataset.form) {
        case 'appkey': ls.set('vw_app_key', fd.key.trim()); render(); break;
        case 'message': await leaveMessage(fd, null); break;
        case 'note': await leaveMessage(fd, folder); break;
        case 'add-item': await saveNotes(folder, t => V.addItem(t, clean(fd.item)), 'Added to Next'); break;
        case 'target': await saveProjects(l => V.setTarget(l, folder, clean(fd.target).replace(/\|/g, '/'), clean(fd.due).replace(/\|/g, '/')), 'Target saved'); break;
        case 'fields': await saveFields(folder, fd); break;
        case 'ob-add': await savePortfolio(t => V.addObligation(t, { date: fd.date, area: fd.area, task: clean(fd.task).replace(/\|/g, '/'), notes: clean(fd.notes).replace(/\|/g, '/') }), 'Obligation added'); break;
        default: break;
      }
    } catch (e) { say(e.message || String(e), 'bad'); }
  });

  app.addEventListener('change', async ev => {
    const el = ev.target;
    if (el.dataset.change === 'sort') { S.sort = el.value; ls.set('vw_sort', S.sort); render(); return; }
    if (el.dataset.change === 'level' && el.value) {
      try { await saveProjects(l => V.setLevel(l, el.dataset.folder, el.value), 'Level: ' + el.value); } catch (e) { say(e.message || String(e), 'bad'); }
    }
  });

  // Grow message boxes as you type.
  app.addEventListener('input', ev => {
    if (ev.target.matches('.ask textarea, .msgbar textarea')) { ev.target.style.height = 'auto'; ev.target.style.height = Math.min(ev.target.scrollHeight, 200) + 'px'; }
  });

  // Refresh when you come back to the tab, unless you are typing or editing.
  document.addEventListener('visibilitychange', () => {
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (document.visibilityState === 'visible' && S.token && S.port && !S.editor && !S.editing && !S.busy && !typing && Date.now() - S.loadedAt > 60e3) load().catch(e => say(e.message || String(e), 'bad'));
  });

  (async function boot() {
    const q = new URLSearchParams(location.search);
    try {
      if (q.get('error')) { history.replaceState(null, '', REDIRECT); say('Dropbox: ' + (q.get('error_description') || q.get('error')), 'bad'); }
      if (q.get('code')) await finishLogin(q.get('code'));
      render();
      if (S.token) await load();
    } catch (e) { render(); say(e.message || String(e), 'bad'); }
  })();
})();
