/* Pure parsing and editing of PORTFOLIO.md and NOTES.md. No network, no DOM.
   Used by app.js in the browser and by test.js under node. */
(function (root) {
  'use strict';
  const LEVELS = ['high', 'medium', 'low', 'parked'];
  const levelIdx = l => { const i = LEVELS.indexOf(l); return i < 0 ? 2 : i; };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- NOTES.md ----------
  function parseValue(v) {
    v = v.trim();
    if (v.startsWith('[')) {
      try { return JSON.parse(v).map(String); } catch (e) {
        return v.replace(/^\[|\]$/g, '').split(',').map(x => x.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean);
      }
    }
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '');
    else v = v.replace(/^(["'][^"']*["'])\s+#.*$/, '$1');
    return v.trim().replace(/^["']+|["']+$/g, '');
  }

  function parseNotes(text) {
    const meta = {}; let body = text;
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (m) {
      for (const line of m[1].split('\n')) {
        if (line.includes(':') && !line.trimStart().startsWith('#')) {
          const i = line.indexOf(':');
          meta[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
        }
      }
      body = m[2];
    }
    body = body.replace(/^\s*# [^\n]*\n/, '');
    return { meta, body };
  }

  function asList(v) {
    if (Array.isArray(v)) return v.filter(x => x && !x.startsWith('Name:'));
    return v ? [v] : [];
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(?<!href=")(?<!">)(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  function mdToHtml(md) {
    const out = []; let tag = null;
    const close = () => { if (tag) { out.push(`</${tag}>`); tag = null; } };
    for (const raw of md.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { close(); continue; }
      if (line.startsWith('### ')) { close(); out.push(`<h4>${inline(line.slice(4))}</h4>`); continue; }
      if (line.startsWith('## ')) { close(); out.push(`<h3>${inline(line.slice(3))}</h3>`); continue; }
      const ul = line.match(/^\s*[-*] (.*)$/), ol = line.match(/^\s*\d+\. (.*)$/);
      if (ul || ol) {
        const t = ul ? 'ul' : 'ol';
        if (tag !== t) { close(); out.push(`<${t}>`); tag = t; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        continue;
      }
      close(); out.push(`<p>${inline(line.trim())}</p>`);
    }
    close();
    return out.join('\n');
  }

  // YAML scalar or list, readable by build_dashboard.py's simple parser.
  // Straight double quotes become ” so both parsers read the value back unchanged.
  const tidy = x => String(x).replace(/\s+/g, ' ').trim().replace(/"/g, '”').replace(/^'|'$/g, '’');
  function fmtYaml(v) {
    if (Array.isArray(v)) return '[' + v.map(x => '"' + tidy(x) + '"').join(', ') + ']';
    v = tidy(v);
    if (v === '') return '""';
    return /^[\s'\[\]{}>|*&!%@`#,?:-]| #|: /.test(v) ? '"' + v + '"' : v;
  }

  function setFrontmatter(text, key, value) {
    const L = text.split('\n');
    if ((L[0] || '').trim() !== '---') throw new Error('NOTES.md has no frontmatter');
    let close = -1;
    for (let i = 1; i < L.length; i++) if (L[i].trim() === '---') { close = i; break; }
    if (close < 0) throw new Error('NOTES.md frontmatter is not closed');
    const re = new RegExp('^' + key + ':');
    const line = `${key}: ${fmtYaml(value)}`;
    for (let i = 1; i < close; i++) {
      if (re.test(L[i])) {
        const c = /^[\w-]+:\s*(?:"[^"]*"|'[^']*'|[^#\[\s][^#]*?)?(\s+#.*)$/.exec(L[i]);
        L[i] = line + (c ? c[1] : '');
        return L.join('\n');
      }
    }
    L.splice(close, 0, line);
    return L.join('\n');
  }

  function addLog(text, entry) {
    const L = text.split('\n');
    const i = L.findIndex(l => l.trim() === '## Log');
    if (i < 0) return text.replace(/\s*$/, '') + '\n\n## Log\n' + entry + '\n';
    L.splice(i + 1, 0, entry);
    return L.join('\n');
  }

  // ---------- PORTFOLIO.md ----------
  const fields = (s, n) => { const f = s.split('|').map(x => x.trim()); while (f.length < n) f.push(''); return f; };

  function parsePortfolio(text) {
    const lines = text.split('\n');
    const res = { lines, sections: {}, today: { date: '', items: [] }, week: { date: '', items: [] }, projects: [], obligations: [] };
    let sec = null;
    lines.forEach((line, idx) => {
      if (line.startsWith('## ')) {
        if (sec && res.sections[sec]) res.sections[sec].end = idx;
        const head = line.slice(3).trim(), low = head.toLowerCase();
        const date = head.includes('·') ? head.split('·')[1].trim() : '';
        sec = low.startsWith('today') ? 'today' : low.startsWith('this week') ? 'week'
          : (low.startsWith('projects') || low.startsWith('active')) ? 'projects'
          : low.startsWith('obligations') ? 'obligations' : 'other' + idx;
        res.sections[sec] = { head: idx, end: lines.length };
        if (sec === 'today' || sec === 'week') res[sec].date = date;
        return;
      }
      if (!sec || !line.trim()) return;
      if ((sec === 'today' || sec === 'week') && line.startsWith('- ')) {
        const f = fields(line.slice(2), 5);
        res[sec].items.push({ idx, slot: f[0], project: f[1], goal: f[2], done: f[3].replace(/^done when:\s*/, ''), status: (f[4] || 'open').toLowerCase() });
      } else if (sec === 'projects') {
        const m = line.match(/^\s*(\d+)\.\s*(.*)$/);
        if (!m) return;
        const f = fields(m[2], 4);
        const hasLevel = LEVELS.includes(f[1].toLowerCase());
        res.projects.push({ idx, rank: +m[1], folder: f[0], level: hasLevel ? f[1].toLowerCase() : '', target: hasLevel ? f[2] : f[1], due: hasLevel ? f[3] : f[2] });
      } else if (sec === 'obligations' && line.startsWith('- ')) {
        const f = fields(line.slice(2), 4);
        res.obligations.push({ idx, date: f[0], area: f[1], task: f[2], notes: f[3] });
      }
    });
    return res;
  }

  function splice(text, start, end, newLines) {
    const L = text.split('\n');
    L.splice(start, end - start, ...newLines);
    return L.join('\n');
  }

  function insertAtSectionEnd(text, sec, newLines) {
    const p = parsePortfolio(text), s = p.sections[sec];
    if (!s) throw new Error(`PORTFOLIO.md has no ${sec} section`);
    let pos = s.end;
    while (pos > s.head + 1 && !p.lines[pos - 1].trim()) pos--;
    return splice(text, pos, pos, newLines);
  }

  const sprintLine = s => `- ${s.slot} | ${s.project} | ${s.goal} | done when: ${s.done} | ${s.status}`;

  function findSprint(p, idx) {
    const it = p.today.items.concat(p.week.items).find(i => i.idx === idx);
    if (!it) throw new Error('Sprint line not found; refresh and try again');
    return it;
  }

  function setSprintStatus(text, idx, status) {
    const it = findSprint(parsePortfolio(text), idx);
    return splice(text, idx, idx + 1, [sprintLine(Object.assign({}, it, { status }))]);
  }

  function addSprint(text, s) {
    const sec = /^(AM|PM)$/i.test(s.slot) ? 'today' : 'week';
    return insertAtSectionEnd(text, sec, [sprintLine(Object.assign({ status: 'open' }, s))]);
  }

  function removeItem(text, idx) {
    const L = text.split('\n');
    if (!(L[idx] || '').startsWith('- ')) throw new Error('Line not found; refresh and try again');
    L.splice(idx, 1);
    return L.join('\n');
  }

  // New day: date the Today heading and clear the old day's lines.
  function rollToday(text, date) {
    const p = parsePortfolio(text), s = p.sections.today;
    if (!s) throw new Error('PORTFOLIO.md has no Today section');
    const L = text.split('\n');
    for (let i = s.end - 1; i > s.head; i--) if (L[i].startsWith('- ')) L.splice(i, 1);
    L[s.head] = `## Today · ${date}`;
    return L.join('\n');
  }

  const projectLine = (p, i) => `${i + 1}. ${p.folder} | ${p.level || 'low'} | ${p.target} |` + (p.due ? ' ' + p.due : '');
  const byLevel = list => list.map((p, i) => [p, i]).sort((a, b) => levelIdx(a[0].level) - levelIdx(b[0].level) || a[1] - b[1]).map(x => x[0]);

  function writeProjects(text, list) {
    const p = parsePortfolio(text), idxs = p.projects.map(x => x.idx);
    const lines = byLevel(list).map(projectLine);
    if (!idxs.length) return insertAtSectionEnd(text, 'projects', lines);
    const first = idxs[0], last = idxs[idxs.length - 1];
    if (last - first + 1 !== idxs.length) throw new Error('Projects list has gaps; fix PORTFOLIO.md by hand');
    return splice(text, first, last + 1, lines);
  }

  function moveProject(list, folder, delta) {
    const l = list.map(x => Object.assign({}, x));
    const i = l.findIndex(p => p.folder === folder), j = i + delta;
    if (i < 0 || j < 0 || j >= l.length || levelIdx(l[i].level) !== levelIdx(l[j].level)) return l;
    [l[i], l[j]] = [l[j], l[i]];
    return l;
  }

  function setLevel(list, folder, level) {
    const l = list.map(x => Object.assign({}, x));
    const p = l.find(x => x.folder === folder);
    if (p) p.level = level; else l.push({ folder, level, target: '', due: '' });
    return byLevel(l);
  }

  function setTarget(list, folder, target, due) {
    return list.map(x => x.folder === folder ? Object.assign({}, x, { target, due }) : Object.assign({}, x));
  }

  function addObligation(text, o) {
    const line = `- ${o.date} | ${o.area} | ${o.task} | ${o.notes || ''}`.replace(/\s+$/, '');
    const p = parsePortfolio(text);
    const after = p.obligations.find(x => x.date > o.date);
    return after ? splice(text, after.idx, after.idx, [line]) : insertAtSectionEnd(text, 'obligations', [line]);
  }


  // ---------- Next items (today's work lives here, marked in place) ----------
  // A Next item may carry a mark: "- [today 2026-11-15] Proofread Agni's revision" or "[week 2026-11-16]" (week = Monday).
  const MARK = /^\[(today|week)\s+(\d{4}-\d{2}-\d{2})\]\s*/;

  function nextItems(text) {
    const L = text.split('\n');
    let start = -1, end = L.length;
    for (let i = 0; i < L.length; i++) {
      if (start < 0 && /^###\s+Next\s*$/.test(L[i])) { start = i; continue; }
      if (start >= 0 && /^#{1,3}\s/.test(L[i])) { end = i; break; }
    }
    const items = [];
    if (start >= 0) {
      for (let i = start + 1; i < end; i++) {
        const m = /^-\s+(.*\S)\s*$/.exec(L[i]);
        if (!m) continue;
        const k = MARK.exec(m[1]);
        items.push({ line: i, text: k ? m[1].slice(k[0].length) : m[1], mark: k ? k[1] : '', date: k ? k[2] : '' });
      }
    }
    return { start, end, items };
  }

  function findItem(text, line, expect) {
    const it = nextItems(text).items.find(i => i.line === line);
    if (!it || (expect != null && it.text !== expect)) throw new Error('That item changed; refresh and try again');
    return it;
  }

  function markItem(text, line, expect, mark, date) {
    const it = findItem(text, line, expect), L = text.split('\n');
    L[line] = '- ' + (mark ? `[${mark} ${date}] ` : '') + it.text;
    return L.join('\n');
  }

  function completeItem(text, line, expect, date, tool) {
    const it = findItem(text, line, expect), L = text.split('\n');
    L.splice(line, 1);
    return addLog(L.join('\n'), `- ${date} [${tool}]: done: ${it.text}`);
  }

  function addItem(text, item) {
    const n = nextItems(text);
    if (n.start < 0) throw new Error('This NOTES.md has no "### Next" section');
    const L = text.split('\n');
    let pos = n.end;
    while (pos > n.start + 1 && !L[pos - 1].trim()) pos--;
    L.splice(pos, 0, '- ' + item);
    return L.join('\n');
  }

  function monday(dateStr) {
    const d = new Date(dateStr + 'T12:00:00'), wd = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - wd);
    return d.toLocaleDateString('en-CA');
  }

  // Items for someone else, or that wait on something, are not suggested.
  const notMine = s => /^(wait|when |once |after |then\b)/i.test(s) || /^[A-Z][\w.-]*((\s*\+\s*|\s+and\s+|,\s*)[A-Z][\w.-]*)*:\s/.test(s);

  // Up to n suggestions, one per project: someone waits on you (oldest first), then a deadline within 7 days, then rank.
  function suggest(projects, todayStr, n) {
    const t = dayNum(todayStr);
    const key = p => {
      const w = asList(p.meta.waiting_on_me);
      const since = w.map(x => dayNum((/since (\d{4}-\d{2}-\d{2})/.exec(x) || [])[1])).filter(x => x != null);
      const dl = dayNum(p.meta.deadline);
      if (w.length) return [0, since.length ? Math.min(...since) : 0, p.entry.rank];
      if (dl != null && dl - t <= 7) return [1, dl, p.entry.rank];
      return [2, 0, p.entry.rank];
    };
    const why = k => (k[0] === 0 ? 'someone waits on you' : k[0] === 1 ? 'deadline soon' : 'priority');
    const out = [];
    projects.filter(p => p.entry && p.entry.level !== 'parked' && p.next)
      .map(p => ({ p, k: key(p) }))
      .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
      .forEach(({ p, k }) => {
        if (out.length >= n) return;
        const it = p.next.items.find(i => !i.mark && !notMine(i.text));
        if (it) out.push({ folder: p.folder, line: it.line, text: it.text, why: why(k) });
      });
    return out;
  }

  // Dobbie's suggestion file: lines "- <project-folder> | <exact Next item text>".
  function parseSuggestions(text) {
    return text.split('\n').map(l => /^-\s+([^|]+?)\s*\|\s*(.+?)\s*$/.exec(l)).filter(Boolean).map(m => ({ folder: m[1], text: m[2] }));
  }

  // ---------- Checks ----------
  function dayNum(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null;
  }

  // Same rules as build_dashboard.py.
  function computeExceptions(port, projects, todayStr) {
    const ex = [], t = dayNum(todayStr);
    const listed = new Map(port.projects.map(p => [p.folder, p]));
    for (const p of projects) {
      const m = p.meta || {}, e = listed.get(p.folder);
      for (const w of asList(m.waiting_on_me)) ex.push(`${p.folder}: ${w} waits on you`);
      const active = e && e.level !== 'parked';
      const lt = dayNum(m.last_touched);
      if (active && lt != null && t - lt >= 14) ex.push(`${p.folder}: untouched ${t - lt} days`);
      if (!e) ex.push(`${p.folder}: not in PORTFOLIO.md (add it under Projects)`);
      const dl = dayNum(m.deadline);
      if (dl != null) {
        if (dl < t) ex.push(`${p.folder}: DEADLINE PASSED — ${m.deadline}`);
        else if (dl - t <= 7) ex.push(`${p.folder}: deadline in ${dl - t} days — ${m.deadline}`);
      }
    }
    for (const o of port.obligations.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      const d = dayNum(o.date.replace(/\?$/, ''));
      if (d == null) continue;
      if (d < t) ex.push(`Overdue ${o.date}: ${o.task}`);
      else if (d - t <= 7) ex.push(`Due ${o.date}: ${o.task}`);
    }
    return ex;
  }

  function cosStatus(names, now) {
    for (const n of names.slice().sort().reverse()) {
      const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(n);
      if (!m) continue;
      const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      return { last: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`, stale: now - d > 26 * 3600e3 };
    }
    return { last: '', stale: true };
  }

  function pendingRequests(names, doneNames) {
    const done = new Set(doneNames);
    return names.filter(n => n.endsWith('.md') && !done.has(n)).sort();
  }

  const api = { LEVELS, esc, parseValue, parseNotes, asList, inline, mdToHtml, fmtYaml, setFrontmatter, addLog, parsePortfolio, setSprintStatus, addSprint, removeItem, rollToday, writeProjects, moveProject, setLevel, setTarget, addObligation, computeExceptions, cosStatus, pendingRequests, dayNum, nextItems, markItem, completeItem, addItem, monday, suggest, parseSuggestions, notMine };
  root.VW = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
