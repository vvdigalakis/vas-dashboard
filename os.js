/* "How it works": an interactive architecture diagram (C4 container style) for the app.
   High level: names and connections only. Tap a box for details. No data; only the system's design. */
(function (root) {
  'use strict';

  // kind: person | app | agent | store | file | ext
  const NODES = [
    { id: 'vas', kind: 'person', x: 135, y: 12, w: 90, h: 36, label: ['Vas'],
      title: 'Vas', role: 'Decide priorities and all scientific questions. Everything else is bookkeeping for agents.',
      rows: [['Uses', 'The app on phone or web; Dobbie in ChatGPT; Claude Code / Codex in VS Code.'], ['Goal', 'Under 5 minutes a day of upkeep.']] },
    { id: 'app', kind: 'app', x: 6, y: 100, w: 80, h: 48, label: ['Dashboard', 'app'],
      title: 'Dashboard app', role: 'This page. See status, pick today’s work, edit, leave messages.',
      rows: [['Tech', 'Static HTML + JavaScript, hosted on GitHub Pages. Logs in to your BU Dropbox in the browser (OAuth PKCE); the key stays in the tab for about 4 hours.'],
        ['Reads', 'PORTFOLIO.md, every NOTES.md, Dobbie’s log and suggestions.'],
        ['Writes', 'NOTES.md (today/week marks, done items, Next, fields), PORTFOLIO.md (levels, ranks, targets, obligations), new messages and project notes.'],
        ['Safety', 'Saves only if the file has not changed since it was loaded; otherwise reloads and asks you to redo.'],
        ['Where', '_system/app/']] },
    { id: 'dobbie', kind: 'agent', x: 94, y: 100, w: 80, h: 48, label: ['Dobbie'],
      title: 'Dobbie (chief of staff)', role: 'Keeps every project visible and moving; keeps you accountable.',
      rows: [['Tech', 'ChatGPT with the BU Dropbox connector. Job description: _system/CHIEF-OF-STAFF.md.'],
        ['Does', 'Weekday morning brief (when scheduled), today’s suggestions, alerts, Monday plan, monthly portfolio review.'],
        ['Reads', 'All of vas-work.'],
        ['Writes', 'New files only: project inbox notes, suggestions, its run log. PORTFOLIO.md only with your OK on each file move.'],
        ['Never', 'Edits NOTES.md, sends email, changes calendars, deletes, makes scientific decisions.']] },
    { id: 'sessions', kind: 'agent', x: 182, y: 100, w: 80, h: 48, label: ['Session', 'agents'],
      title: 'Session agents', role: 'Do the project work with you and keep the notes current.',
      rows: [['Tech', 'Claude Code and Codex in VS Code on your Mac. Rules: AGENTS.md. Skills: session-start, wrap-up, sprint, plan, report, handoff.'],
        ['Reads', 'All of vas-work, plus git history of project repos.'],
        ['Writes', 'NOTES.md and PORTFOLIO.md directly; fold inboxes and messages; publish the app with one script.'],
        ['Never', 'Push to collaborator repos, send email, delete files, invent results.']] },
    { id: 'cloud', kind: 'agent', x: 270, y: 100, w: 84, h: 48, label: ['Chat & cloud', 'agents'],
      title: 'Chat and cloud agents', role: 'Brainstorming and tasks that run in the cloud.',
      rows: [['Tech', 'ChatGPT, Claude chat, Codex cloud, Claude Code web; each reads vas-work through a Dropbox connector.'],
        ['Writes', 'New files only: a HANDOFF note in the project’s inbox/. Code changes as pull requests, never merged.'],
        ['Never', 'Edit NOTES.md or PORTFOLIO.md.']] },
    { id: 'store', kind: 'store', x: 22, y: 196, w: 316, h: 132, label: ['vas-work · Dropbox'],
      title: 'vas-work (Dropbox)', role: 'The single source of truth: plain Markdown files in your BU Dropbox, synced to the Mac. Every fact lives in one file.',
      rows: [['Contains', 'PORTFOLIO.md, one NOTES.md + inbox/ per project, messages and suggestions, rules and logs.'],
        ['Rule', 'Nothing is copied between files; the app and agents read and edit the same lines.']] },
    { id: 'portfolio', kind: 'file', x: 34, y: 226, w: 140, h: 40, label: ['PORTFOLIO'], parent: 'store',
      title: 'PORTFOLIO.md', role: 'Priorities and obligations.',
      rows: [['Holds', 'One ranked list of projects (high / medium / low / parked), each with one target and date; obligations (teaching, service, admin).'],
        ['Where', '_system/PORTFOLIO.md']] },
    { id: 'notes', kind: 'file', x: 186, y: 226, w: 140, h: 40, label: ['NOTES + inbox'], parent: 'store',
      title: 'NOTES.md + inbox/', role: 'One per project: its state, next steps and history.',
      rows: [['NOTES.md', 'Brief · Status (Where we are, Next, Backlog, Open questions, Ideas) · Decisions · Log. Today’s and this week’s work are Next items marked [today …] / [week …]; done items move to the Log.'],
        ['inbox/', 'New inputs (your notes, Dobbie’s email notes, chat handoffs) waiting for the next session to fold them in.'],
        ['Where', 'research/projects-active/<project>/']] },
    { id: 'messages', kind: 'file', x: 34, y: 276, w: 140, h: 40, label: ['Messages'], parent: 'store',
      title: 'Messages and suggestions', role: 'How you and Dobbie hand things to agents without editing anything.',
      rows: [['Messages', '_system/requests/: what you type in the app. The next session acts on it and files a reply in requests/done/.'],
        ['Suggestions', '_system/suggestions/: Dobbie’s picks for today; the app shows them and you accept with one tap.']] },
    { id: 'rules', kind: 'file', x: 186, y: 276, w: 140, h: 40, label: ['Rules & logs'], parent: 'store',
      title: 'Rules and logs', role: 'The shared contract every agent follows.',
      rows: [['Rules', 'AGENTS.md (all agents), CHIEF-OF-STAFF.md (Dobbie), skills/, standards/ (writing, templates), SPEC.md (design).'],
        ['Logs', '_system/cos-log/: one file per Dobbie run; the app shows the latest as “Dobbie checked”.']] },
    { id: 'pages', kind: 'ext', x: 6, y: 372, w: 130, h: 40, label: ['GitHub Pages'],
      title: 'GitHub Pages', role: 'Hosts the app’s code. No data.',
      rows: [['Repo', 'vvdigalakis/vas-dashboard (public; 4 code files only).'],
        ['Updated by', 'Session agents, only with _system/tools/publish_app.sh.']] },
    { id: 'repos', kind: 'ext', x: 224, y: 372, w: 130, h: 40, label: ['Collaborator', 'repos'],
      title: 'Collaborator repos', role: 'Code and papers shared with coauthors.',
      rows: [['Where', 'Git clones in each project’s code/ and paper/ folders (GitHub, Overleaf).'],
        ['Rule', 'NOTES.md and inbox/ stay outside them. Agents read their history; never push or merge without your OK.']] },
  ];

  // type: edit (solid, both ways) | add (dashed: reads, new files only) | use (thin)
  const EDGES = [
    { from: 'vas', to: 'app', type: 'use', d: 'M150 48 C150 74 46 70 46 100' },
    { from: 'vas', to: 'dobbie', type: 'use', d: 'M168 48 C168 72 134 76 134 100' },
    { from: 'vas', to: 'sessions', type: 'use', d: 'M192 48 C192 72 222 76 222 100' },
    { from: 'vas', to: 'cloud', type: 'use', d: 'M210 48 C210 74 312 70 312 100' },
    { from: 'app', to: 'store', type: 'edit', d: 'M46 148 V196' },
    { from: 'dobbie', to: 'store', type: 'add', d: 'M134 148 V196' },
    { from: 'sessions', to: 'store', type: 'edit', d: 'M222 148 V196' },
    { from: 'cloud', to: 'store', type: 'add', d: 'M312 148 V196' },
    { from: 'pages', to: 'app', type: 'use', d: 'M14 372 V148' },
    { from: 'store', to: 'repos', type: 'use', d: 'M289 328 V372' },
  ];

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const byId = Object.fromEntries(NODES.map(n => [n.id, n]));

  function svg(sel) {
    const related = new Set([sel]);
    EDGES.forEach(e => { if (e.from === sel || e.to === sel) { related.add(e.from); related.add(e.to); } });
    const parent = sel && byId[sel] ? byId[sel].parent : null;
    if (parent) { related.add(parent); EDGES.forEach(e => { if (e.from === parent || e.to === parent) { related.add(e.from); related.add(e.to); } }); }
    NODES.forEach(n => { if (n.parent && n.parent === sel) related.add(n.id); });
    const dim = id => (sel && !related.has(id) ? ' dim' : '');
    const edges = EDGES.map(e => {
      const hot = sel && (e.from === sel || e.to === sel || (parent && (e.from === parent || e.to === parent)));
      const ends = e.type === 'edit' ? ' marker-start="url(#os-a)" marker-end="url(#os-a)"' : ' marker-end="url(#os-a)"';
      return `<path class="os-edge t-${e.type}${hot ? ' hot' : sel ? ' dim' : ''}" d="${e.d}"${ends}/>`;
    }).join('');
    const node = n => {
      const rx = n.kind === 'person' ? 18 : n.kind === 'store' ? 14 : n.kind === 'file' ? 8 : 10;
      const lines = n.label, lh = 14, cy = n.kind === 'store' ? n.y + 18 : n.y + n.h / 2 - (lines.length - 1) * lh / 2 + 4;
      const text = lines.map((l, i) => `<text x="${n.x + n.w / 2}" y="${cy + i * lh}" text-anchor="middle">${esc(l)}</text>`).join('');
      return `<g class="os-node k-${n.kind}${sel === n.id ? ' sel' : ''}${dim(n.id)}" data-node="${n.id}" role="button" tabindex="0" aria-label="${esc(n.title)}">`
        + `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}"/>${text}</g>`;
    };
    const order = NODES.filter(n => n.kind === 'store').concat(NODES.filter(n => n.kind !== 'store'));
    return `<svg class="os" viewBox="0 0 360 420" role="img" aria-label="Architecture of the work system">
      <defs><marker id="os-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z"/></marker></defs>
      ${edges}${order.map(node).join('')}</svg>`;
  }

  function details(sel) {
    const n = byId[sel];
    if (!n) return '<p class="sub">Tap any box for details.</p>';
    return `<div class="os-detail"><p class="label">${esc(n.kind === 'file' ? 'In vas-work' : n.kind === 'ext' ? 'External' : n.kind)}</p><h2>${esc(n.title)}</h2><p>${esc(n.role)}</p>`
      + n.rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('') + '</div>';
  }

  const legend = '<div class="os-legend"><span><i class="lg edit"></i>reads &amp; edits</span><span><i class="lg add"></i>reads, adds new files only</span><span><i class="lg use"></i>uses / hosts</span></div>';

  root.VW_OS = { svg, details, legend, ids: NODES.map(n => n.id) };
})(typeof window !== 'undefined' ? window : globalThis);
