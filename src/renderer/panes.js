'use strict';
/* One file list pane (used for both Local site and Remote site). */

function FilePane(opts) {
  const root = opts.root;
  const side = opts.side;                 // 'local' | 'remote'
  const tbody = root.querySelector('tbody');
  const pathInput = root.querySelector('.path');
  const filterInput = root.querySelector('.filter');
  const statusBar = root.querySelector('.pane-status');

  const state = {
    path: '',
    parent: '',
    items: [],
    selection: new Set(),     // names
    lastClicked: null,
    sortKey: 'name',
    sortDir: 1,
    filter: '',
    showHidden: true,
    compare: null,            // Map(name -> 'only'|'diff'|'newer'|'same')
    hideIdentical: false,
    editing: new Set(),       // remote paths currently being edited
  };

  /* ------------------------------------------------------------ helpers */

  function joinPath(dir, name) {
    if (side === 'remote') {
      return dir.endsWith('/') ? dir + name : dir + '/' + name;
    }
    return dir.endsWith('/') ? dir + name : dir + '/' + name;
  }

  function visibleItems() {
    let list = state.items.slice();
    if (!state.showHidden) list = list.filter((i) => !i.name.startsWith('.'));
    if (state.filter) {
      const f = state.filter.toLowerCase();
      list = list.filter((i) => i.name.toLowerCase().includes(f));
    }
    if (state.compare && state.hideIdentical) {
      list = list.filter((i) => i.isDir || state.compare.get(i.name) !== 'same');
    }
    const dir = state.sortDir;
    const key = state.sortKey;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // directories first
      let va;
      let vb;
      if (key === 'size') { va = a.size || 0; vb = b.size || 0; }
      else if (key === 'mtime') { va = a.mtime || 0; vb = b.mtime || 0; }
      else if (key === 'type') { va = L.fileType(a.name, a.isDir); vb = L.fileType(b.name, b.isDir); }
      else if (key === 'perm') { va = a.permissions || ''; vb = b.permissions || ''; }
      else if (key === 'owner') { va = String(a.owner || ''); vb = String(b.owner || ''); }
      else { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return list;
  }

  function selectedItems() {
    return state.items.filter((i) => state.selection.has(i.name));
  }

  function entryFor(item) {
    const full = joinPath(state.path, item.name);
    return side === 'remote'
      ? { name: item.name, isDir: item.isDir, remotePath: full, size: item.size, mtime: item.mtime }
      : { name: item.name, isDir: item.isDir, localPath: full, size: item.size, mtime: item.mtime };
  }

  /* ------------------------------------------------------------- render */

  function render() {
    const list = visibleItems();
    tbody.innerHTML = '';

    if (state.parent && state.parent !== state.path) {
      const up = L.el('tr', { class: 'dir' }, [
        L.el('td', {}, [L.el('span', { class: 'ico', text: '📁' }), '..']),
        L.el('td', { class: 'num' }), L.el('td'), L.el('td'),
        // permissions + owner are remote-only columns
        ...(side === 'remote' ? [L.el('td', { class: 'perm' }), L.el('td')] : []),
      ]);
      up.ondblclick = () => opts.onNavigate(state.parent);
      tbody.append(up);
    }

    let files = 0;
    let dirs = 0;
    let bytes = 0;

    for (const item of list) {
      if (item.isDir) dirs += 1; else { files += 1; bytes += item.size || 0; }

      const cmp = state.compare ? state.compare.get(item.name) : null;
      const cls = [
        item.isDir ? 'dir' : '',
        state.selection.has(item.name) ? 'sel' : '',
        cmp === 'only' ? 'cmp-only' : cmp === 'diff' ? 'cmp-diff' : cmp === 'newer' ? 'cmp-newer' : '',
      ].filter(Boolean).join(' ');

      const beingEdited = side === 'remote' && state.editing.has(joinPath(state.path, item.name));

      const nameCell = L.el('td', { title: item.name }, [
        L.el('span', { class: 'ico', text: item.isDir ? '📁' : item.isLink ? '🔗' : '📄' }),
        item.name,
        beingEdited ? L.el('span', { class: 'editing-tag', text: 'being edited' }) : null,
      ]);

      const cells = [
        nameCell,
        L.el('td', { class: 'num', text: item.isDir ? '' : L.fmtSize(item.size) }),
        L.el('td', { text: L.fileType(item.name, item.isDir) }),
        L.el('td', { text: L.fmtDate(item.mtime) }),
      ];
      if (side === 'remote') {
        cells.push(L.el('td', { class: 'perm', text: item.permissions || '' }));
        cells.push(L.el('td', { text: [item.owner, item.group].filter((v) => v !== undefined && v !== null && v !== '').join('/') }));
      }

      const tr = L.el('tr', { class: cls, draggable: true }, cells);
      tr.dataset.name = item.name;

      tr.onmousedown = (e) => {
        if (e.button === 2 && !state.selection.has(item.name)) selectOnly(item.name);
      };
      tr.onclick = (e) => {
        if (e.metaKey || e.ctrlKey) {
          if (state.selection.has(item.name)) state.selection.delete(item.name);
          else state.selection.add(item.name);
          state.lastClicked = item.name;
          render();
        } else if (e.shiftKey && state.lastClicked) {
          const names = list.map((i) => i.name);
          const a = names.indexOf(state.lastClicked);
          const b = names.indexOf(item.name);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) state.selection.add(names[i]);
          }
          render();
        } else {
          selectOnly(item.name);
        }
      };
      tr.ondblclick = () => {
        if (item.isDir) opts.onNavigate(joinPath(state.path, item.name));
        else opts.onActivate(entryFor(item));
      };
      tr.oncontextmenu = (e) => {
        e.preventDefault();
        opts.onMenu(e, selectedItems().map(entryFor));
      };
      tr.ondragstart = (e) => {
        if (!state.selection.has(item.name)) selectOnly(item.name);
        e.dataTransfer.setData('text/plain', side);
        e.dataTransfer.effectAllowed = 'copy';
      };

      tbody.append(tr);
    }

    if (!list.length) {
      tbody.append(L.el('tr', {}, [
        L.el('td', { class: 'empty', colspan: side === 'remote' ? 6 : 4, text: state.path ? 'Empty directory listing' : 'Not connected' }),
      ]));
    }

    pathInput.value = state.path;
    const sel = selectedItems();
    statusBar.textContent = sel.length
      ? `Selected ${sel.length} item${sel.length > 1 ? 's' : ''}. Total size: ${L.fmtSize(sel.reduce((n, i) => n + (i.size || 0), 0))}`
      : `${files} file${files === 1 ? '' : 's'} and ${dirs} director${dirs === 1 ? 'y' : 'ies'}. Total size: ${L.fmtSize(bytes)}`;
  }

  function selectOnly(name) {
    state.selection = new Set([name]);
    state.lastClicked = name;
    render();
  }

  /* ------------------------------------------------------------- events */

  root.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = 1; }
      render();
    };
  });

  root.querySelector('[data-act="up"]').onclick = () => {
    if (state.parent && state.parent !== state.path) opts.onNavigate(state.parent);
  };
  root.querySelector('[data-act="refresh"]').onclick = () => opts.onNavigate(state.path);

  filterInput.oninput = () => { state.filter = filterInput.value; render(); };

  pathInput.onkeydown = (e) => {
    if (e.key === 'Enter') opts.onNavigate(pathInput.value.trim());
    if (e.key === 'Escape') pathInput.value = state.path;
  };

  // Drag a selection onto the other pane to transfer it.
  root.addEventListener('dragover', (e) => {
    const from = e.dataTransfer.getData('text/plain');
    if (from && from !== side) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  root.addEventListener('drop', (e) => {
    const from = e.dataTransfer.getData('text/plain');
    if (!from || from === side) return;
    e.preventDefault();
    opts.onDrop(from);
  });

  // Remember which pane the user last touched (keyboard shortcuts need it).
  root.addEventListener('mousedown', () => opts.onFocus && opts.onFocus(side), true);

  // Empty-area right click: directory level actions.
  tbody.addEventListener('contextmenu', (e) => {
    if (e.target.closest('tr[data-name]')) return;
    e.preventDefault();
    state.selection = new Set();
    render();
    opts.onMenu(e, []);
  });

  /* ---------------------------------------------------------------- api */

  return {
    side,
    state,
    render,
    get path() { return state.path; },
    setData(data) {
      state.path = data.path;
      state.parent = data.parent;
      state.items = data.items || [];
      state.selection = new Set();
      render();
    },
    clear() {
      state.path = '';
      state.parent = '';
      state.items = [];
      state.selection = new Set();
      render();
    },
    setShowHidden(v) { state.showHidden = v; render(); },
    setCompare(map, hideIdentical) { state.compare = map; state.hideIdentical = hideIdentical; render(); },
    setEditing(paths) { state.editing = new Set(paths || []); render(); },
    selectedEntries() { return selectedItems().map(entryFor); },
    items() { return state.items; },
    joinPath,
  };
}
