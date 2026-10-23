'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the UI and the main process.
 * Node stays out of the renderer; every call is an explicit channel.
 */
const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: call('settings:get'),
    set: call('settings:set'),
    editors: call('settings:editors'),
    encryption: call('settings:encryption'),
  },
  sites: {
    list: call('sites:list'),
    save: call('sites:save'),
    remove: call('sites:remove'),
    folders: call('sites:folders'),
    addFolder: call('sites:addFolder'),
    renameFolder: call('sites:renameFolder'),
    removeFolder: call('sites:removeFolder'),
    setFolder: call('sites:setFolder'),
  },
  bookmarks: {
    list: call('bookmarks:list'),
    save: call('bookmarks:save'),
    remove: call('bookmarks:remove'),
  },
  filezilla: {
    detect: call('fz:detect'),
    pickFile: call('fz:pickFile'),
    import: call('fz:import'),
    export: call('fz:export'),
  },
  tabs: {
    list: call('tabs:list'),
    create: call('tabs:create'),
    activate: call('tabs:activate'),
    close: call('tabs:close'),
    busy: call('tabs:busy'),
  },
  conn: {
    connect: call('conn:connect'),
    disconnect: call('conn:disconnect'),
    status: call('conn:status'),
  },
  local: {
    home: call('local:home'),
    list: call('local:list'),
    mkdir: call('local:mkdir'),
    createFile: call('local:createFile'),
    rename: call('local:rename'),
    remove: call('local:delete'),
    reveal: call('local:reveal'),
    open: call('local:open'),
    pickDir: call('local:pickDir'),
    pickFile: call('local:pickFile'),
    pickImage: call('local:pickImage'),
  },
  remote: {
    list: call('remote:list'),
    mkdir: call('remote:mkdir'),
    createFile: call('remote:createFile'),
    rename: call('remote:rename'),
    remove: call('remote:delete'),
    chmod: call('remote:chmod'),
  },
  queue: {
    download: call('queue:download'),
    upload: call('queue:upload'),
    cancel: call('queue:cancel'),
    cancelAll: call('queue:cancelAll'),
    clear: call('queue:clear'),
  },
  edit: {
    open: call('edit:open'),
    list: call('edit:list'),
    upload: call('edit:upload'),
    stop: call('edit:stop'),
    redownload: call('edit:redownload'),
    reopen: call('edit:reopen'),
    editedPaths: call('edit:editedPaths'),
  },
  misc: {
    copy: call('misc:copy'),
    paths: call('misc:paths'),
  },
  onEvent: (cb) => ipcRenderer.on('app:event', (_e, msg) => cb(msg)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
