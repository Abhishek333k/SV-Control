const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('svHost', {
    closeApp: () => ipcRenderer.send('close-app'),
    forceKick: () => ipcRenderer.send('force-kick'),
    addGameDialog: () => ipcRenderer.invoke('add-game-to-vault'),
    getGameVault: () => ipcRenderer.invoke('get-game-vault'),
    removeGameFromVault: (gamePath) => ipcRenderer.invoke('remove-game-from-vault', gamePath),
    launchGame: (gamePath) => ipcRenderer.invoke('launch-game', gamePath),
    saveCustomAction: (action) => ipcRenderer.invoke('save-custom-action', action),
    getCustomActions: () => ipcRenderer.invoke('get-custom-actions'),
    deleteCustomAction: (actionId) => ipcRenderer.invoke('delete-custom-action', actionId),
    syncClipboardToPc: (text) => ipcRenderer.invoke('sync-clipboard-to-pc', text),
    fetchClipboardFromPc: () => ipcRenderer.invoke('fetch-clipboard-from-pc'),
    mobileAddGame: () => ipcRenderer.invoke('mobile-add-game'),

    onShowQr: (callback) => ipcRenderer.on('show-qr', (event, data) => callback(data)),
    onDeviceConnected: (callback) => ipcRenderer.on('device-connected', (event, msg) => callback(msg)),
    onDeviceDisconnected: (callback) => ipcRenderer.on('device-disconnected', () => callback()),
    onLogAction: (callback) => ipcRenderer.on('log-action', (event, msg) => callback(msg)),
    onVaultUpdated: (callback) => ipcRenderer.on('vault-updated', (event, games) => callback(games)),
    onCustomActionsUpdated: (callback) => ipcRenderer.on('custom-actions-updated', (event, actions) => callback(actions))
});
