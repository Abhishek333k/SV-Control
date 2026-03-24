const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, clipboard } = require('electron');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { exec, spawn } = require('child_process');
const portfinder = require('portfinder');

let mainWindow;
let tray = null;
let currentPort = 3000;

// --- GAME VAULT STORAGE ---
const gameVaultPath = path.join(app.getPath('userData'), 'game-vault.json');

function loadGameVault() {
    try {
        if (fs.existsSync(gameVaultPath)) {
            const data = fs.readFileSync(gameVaultPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Failed to load game vault:', err);
    }
    return [];
}

function saveGameVault(games) {
    try {
        fs.writeFileSync(gameVaultPath, JSON.stringify(games, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('Failed to save game vault:', err);
        return false;
    }
}

let gameVault = loadGameVault();

// --- CUSTOM ACTIONS STORAGE ---
const customActionsPath = path.join(app.getPath('userData'), 'custom-actions.json');

function loadCustomActions() {
    try {
        if (fs.existsSync(customActionsPath)) {
            const data = fs.readFileSync(customActionsPath, 'utf8');
            const actions = JSON.parse(data);
            // Backward compatibility: assign "Default" workspace to actions without one
            return actions.map(action => ({
                ...action,
                workspace: action.workspace || 'Default'
            }));
        }
    } catch (err) {
        console.error('Failed to load custom actions:', err);
    }
    return [];
}

function saveCustomActions(actions) {
    try {
        fs.writeFileSync(customActionsPath, JSON.stringify(actions, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('Failed to save custom actions:', err);
        return false;
    }
}

let customActions = loadCustomActions();

// --- SYSTEM STATE TRACKING ---
let micIsMuted = false;
let currentVolume = 50; // Track volume level (0-100)
let currentBrightness = 100; // Track brightness (0-100)

// --- SYSTEM TELEMETRY ---
let telemetryInterval = null;
let prevCpuLoad = null;

// --- VOLUME MONITORING ---
// Windows doesn't expose volume/brightness via simple PowerShell without external packages
// We track based on user interactions

function startVolumeMonitor() {
    // Volume/brightness tracking is handled through user interactions
}

function stopVolumeMonitor() {
    // No-op
}

async function getTelemetry() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ramPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    const cpus = os.cpus();
    let cpuPercent = 0;

    if (!prevCpuLoad) {
        prevCpuLoad = cpus.map(cpu => cpu.times);
        return { cpu: 0, ram: ramPercent, micMuted: micIsMuted, volume: currentVolume, brightness: currentBrightness };
    }

    for (let i = 0; i < cpus.length; i++) {
        const curr = cpus[i].times;
        const prev = prevCpuLoad[i];
        const total = (curr.user - prev.user) + (curr.sys - prev.sys) + (curr.nice - prev.nice) + (curr.irq - prev.irq) + (curr.idle - prev.idle);
        if (total > 0) {
            const idlePercent = (curr.idle - prev.idle) / total;
            cpuPercent += (1 - idlePercent) * 100;
        }
    }
    cpuPercent = Math.round(cpuPercent / cpus.length);
    prevCpuLoad = cpus.map(cpu => cpu.times);

    return { cpu: cpuPercent, ram: ramPercent, micMuted: micIsMuted, volume: currentVolume, brightness: currentBrightness };
}

function startTelemetry() {
    if (telemetryInterval) return;
    prevCpuLoad = null; // Reset CPU calculation for accuracy
    telemetryInterval = setInterval(() => {
        if (connectedSocket) {
            getTelemetry().then(telemetry => {
                io.emit('telemetry-update', telemetry);
            });
        }
    }, 1000);
    startVolumeMonitor();
}

function stopTelemetry() {
    if (telemetryInterval) {
        clearInterval(telemetryInterval);
        telemetryInterval = null;
    }
    stopVolumeMonitor();
}

// --- SECURE STATE MACHINE ---
let SESSION_PIN;
let sessionToken = null;
let connectedSocket = null;
let disconnectTimeout = null;
let authAttempts = 0;

// --- NATIVE WINDOWS EXECUTION (NO JAVA REQUIRED) ---
function triggerWindowsKey(hexCode) {
    const psCommand = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint d, int e); }'; [K]::keybd_event(${hexCode}, 0, 0, 0)`;
    exec(`powershell.exe -NoProfile -WindowStyle Hidden -Command "${psCommand}"`);
}

// --- SMART IP PARSER ---
function getSecureIP() {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
        const lowerName = name.toLowerCase();
        if (lowerName.includes('vmware') || lowerName.includes('virtual') || lowerName.includes('wsl') || lowerName.includes('vethernet')) continue;
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const networkIP = getSecureIP();
const webApp = express();
const server = http.createServer(webApp);
const io = new Server(server, { cors: { origin: "*" } });

webApp.use(express.static(path.join(__dirname, 'public')));

// --- SECURE SESSION GENERATOR ---
function generateNewSession() {
    SESSION_PIN = Math.floor(1000 + Math.random() * 9000).toString();
    sessionToken = Math.random().toString(36).substring(2); 
    authAttempts = 0; 
    const accessUrl = `http://${networkIP}:${currentPort}`;
    
    if (connectedSocket) {
        connectedSocket.emit('session-expired');
        connectedSocket.disconnect();
        connectedSocket = null;
    }
    clearTimeout(disconnectTimeout);

    QRCode.toDataURL(accessUrl, { color: { dark: '#bb9af7', light: '#1E2030' }})
        .then(url => {
            if (mainWindow) mainWindow.webContents.send('show-qr', { pin: SESSION_PIN, qr: url, url: accessUrl });
        })
        .catch(err => console.error("QR Error:", err));
}

// --- WEBSOCKET ENGINE ---
io.on('connection', (socket) => {
    socket.on('authenticate', (pin) => {
        if (pin === SESSION_PIN) {
            authAttempts = 0;
            clearTimeout(disconnectTimeout);

            if (connectedSocket && connectedSocket.id !== socket.id) {
                connectedSocket.emit('session-expired');
                connectedSocket.disconnect();
            }

            connectedSocket = socket;
            startTelemetry();
            const telemetry = getTelemetry();
            socket.emit('auth-success', { 
                token: sessionToken, 
                micMuted: micIsMuted, 
                customActions: customActions,
                telemetry: telemetry
            });
            if (mainWindow) mainWindow.webContents.send('device-connected', `Device Authenticated`);
        } else {
            authAttempts++;
            socket.emit('auth-failed');

            if (authAttempts >= 5) {
                if (mainWindow) mainWindow.webContents.send('log-action', `[ALERT] Brute force detected. Scorching session.`);
                generateNewSession();
            }
        }
    });

    socket.on('reconnect-session', (token) => {
        if (token === sessionToken) {
            clearTimeout(disconnectTimeout);
            connectedSocket = socket;
            startTelemetry();
            const telemetry = getTelemetry();
            socket.emit('auth-success', { 
                token: sessionToken, 
                micMuted: micIsMuted, 
                customActions: customActions,
                telemetry: telemetry
            });

            // 🟢 THE FIX: We must send 'device-connected' so the UI knows to stop the timer!
            if (mainWindow) mainWindow.webContents.send('device-connected', `Device Auto-Reconnected.`);
        } else {
            socket.emit('session-expired');
        }
    });

    socket.on('disconnect', () => {
        if (connectedSocket && socket.id === connectedSocket.id) {
            if (mainWindow) mainWindow.webContents.send('device-disconnected');
            disconnectTimeout = setTimeout(() => { generateNewSession(); }, 300000);
            stopTelemetry();
        }
    });

    socket.on('trigger-action', (actionId, param) => {
        if (socket.id !== connectedSocket?.id) return;

        try {
            if (mainWindow) mainWindow.webContents.send('log-action', `Executing: ${actionId}`);

            // Check for custom action first
            const customAction = customActions.find(a => a.id === actionId);
            if (customAction) {
                exec(customAction.command, (err, stdout, stderr) => {
                    if (err) {
                        if (mainWindow) mainWindow.webContents.send('log-action', `[ALERT] Custom action "${customAction.name}" failed`);
                        socket.emit('action-failed', { actionId });
                    } else {
                        if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Custom action "${customAction.name}" executed`);
                    }
                });
                return;
            }

            switch (actionId) {
                // === AUDIO CONTROLS ===
                case 'MUTE_MIC':
                    triggerWindowsKey('0xAD');
                    micIsMuted = !micIsMuted;
                    io.emit('state-update', { actionId: 'MUTE_MIC', state: micIsMuted });
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Mic ${micIsMuted ? 'Muted' : 'Unmuted'}`);
                    break;

                case 'VOLUME_UP':
                    triggerWindowsKey('0xAF');
                    currentVolume = Math.min(100, currentVolume + 10);
                    io.emit('telemetry-update', { volume: currentVolume });
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Volume Up`);
                    break;

                case 'VOLUME_DOWN':
                    triggerWindowsKey('0xAE');
                    currentVolume = Math.max(0, currentVolume - 10);
                    io.emit('telemetry-update', { volume: currentVolume });
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Volume Down`);
                    break;

                case 'BRIGHTNESS_UP':
                    currentBrightness = Math.min(100, currentBrightness + 10);
                    io.emit('telemetry-update', { brightness: currentBrightness });
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Brightness Up`);
                    break;

                case 'BRIGHTNESS_DOWN':
                    currentBrightness = Math.max(0, currentBrightness - 10);
                    io.emit('telemetry-update', { brightness: currentBrightness });
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Brightness Down`);
                    break;

                case 'NEXT_TRACK':
                    triggerWindowsKey('0xB0');
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Next Track`);
                    break;

                case 'PREV_TRACK':
                    triggerWindowsKey('0xB1');
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Previous Track`);
                    break;

                case 'PLAY_MEDIA':
                    triggerWindowsKey('0xB3');
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Play/Pause`);
                    break;

                // === POWER CONTROLS ===
                case 'LOCK_PC':
                    exec('rundll32.exe user32.dll,LockWorkStation');
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] PC Locked`);
                    break;

                case 'SLEEP_PC':
                    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] PC entering sleep`);
                    break;

                // === SYSTEM UTILITIES ===
                case 'OPEN_TASK_MANAGER':
                    exec('taskmgr.exe');
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Task Manager opened`);
                    break;

                case 'LAUNCH_BROWSER':
                    const url = param || 'https://google.com';
                    exec(`start ${url}`, { shell: true });
                    if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Browser opened: ${url}`);
                    break;

                // === GAME LAUNCHER ===
                case 'LAUNCH_GAME':
                    if (param) {
                        spawn(param, [], { detached: true, stdio: 'ignore' });
                        if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Launched: ${path.basename(param)}`);
                    } else {
                        if (mainWindow) mainWindow.webContents.send('log-action', `[ALERT] No game path provided`);
                        socket.emit('action-failed', { actionId: 'LAUNCH_GAME' });
                    }
                    break;

                // === SYSTEM MAINTENANCE ===
                case 'FLUSH_RAM':
                    exec('powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File SV-Ghost.ps1', (err) => {
                        if (err) {
                            if (mainWindow) mainWindow.webContents.send('log-action', `[ALERT] RAM Flush Failed`);
                            socket.emit('action-failed', { actionId: 'FLUSH_RAM' });
                        } else {
                            if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] RAM Flushed successfully.`);
                        }
                    });
                    break;

                default:
                    if (mainWindow) mainWindow.webContents.send('log-action', `Unknown Action: ${actionId}`);
                    socket.emit('action-failed', { actionId });
            }
        } catch (err) {
            console.error(`Action Error:`, err);
            if (mainWindow) mainWindow.webContents.send('log-action', `[ALERT] Execution Error: ${actionId}`);
            socket.emit('action-failed', { actionId });
        }
    });

    socket.on('get-game-vault', () => {
        if (socket.id !== connectedSocket?.id) return;
        socket.emit('game-vault', gameVault);
    });
});

// --- THE SV-VAULT GAME PICKER ---
ipcMain.handle('add-game-to-vault', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Game Executable',
        filters: [{ name: 'Executables', extensions: ['exe'] }],
        properties: ['openFile']
    });

    if (result.canceled) return null;

    const gamePath = result.filePaths[0];
    const gameName = path.basename(gamePath, '.exe');

    // Add to vault
    const existingGame = gameVault.find(g => g.path === gamePath);
    if (!existingGame) {
        gameVault.push({ name: gameName, path: gamePath });
        saveGameVault(gameVault);
        if (mainWindow) mainWindow.webContents.send('vault-updated', gameVault);
    }

    return { name: gameName, path: gamePath };
});

// --- GET GAME VAULT LIST ---
ipcMain.handle('get-game-vault', () => {
    return gameVault;
});

// --- REMOVE GAME FROM VAULT ---
ipcMain.handle('remove-game-from-vault', (event, gamePath) => {
    gameVault = gameVault.filter(g => g.path !== gamePath);
    saveGameVault(gameVault);
    if (mainWindow) mainWindow.webContents.send('vault-updated', gameVault);
    return true;
});

// --- LAUNCH GAME ---
ipcMain.handle('launch-game', (event, gamePath) => {
    try {
        spawn(gamePath, [], { detached: true, stdio: 'ignore' });
        if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Launched: ${path.basename(gamePath)}`);
        return true;
    } catch (err) {
        console.error('Failed to launch game:', err);
        return false;
    }
});

// --- CUSTOM ACTIONS IPC ---
ipcMain.handle('save-custom-action', (event, action) => {
    const newAction = {
        id: 'CUSTOM_' + Date.now(),
        name: action.name,
        emoji: action.emoji,
        command: action.command,
        workspace: action.workspace || 'Default'
    };
    customActions.push(newAction);
    saveCustomActions(customActions);
    if (mainWindow) mainWindow.webContents.send('custom-actions-updated', customActions);
    if (connectedSocket) connectedSocket.emit('custom-actions-updated', customActions);
    return newAction;
});

ipcMain.handle('get-custom-actions', () => {
    return customActions;
});

ipcMain.handle('delete-custom-action', (event, actionId) => {
    customActions = customActions.filter(a => a.id !== actionId);
    saveCustomActions(customActions);
    if (mainWindow) mainWindow.webContents.send('custom-actions-updated', customActions);
    if (connectedSocket) connectedSocket.emit('custom-actions-updated', customActions);
    return true;
});

// --- CLIPBOARD SYNC ---
ipcMain.handle('sync-clipboard-to-pc', (event, text) => {
    try {
        clipboard.writeText(text);
        if (mainWindow) mainWindow.webContents.send('log-action', `[SYSTEM] Clipboard synced from mobile`);
        return { success: true };
    } catch (err) {
        console.error('Clipboard write failed:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('fetch-clipboard-from-pc', () => {
    try {
        const text = clipboard.readText();
        return { success: true, text: text || '' };
    } catch (err) {
        console.error('Clipboard read failed:', err);
        return { success: false, text: '' };
    }
});

// --- MOBILE GAME PICKER ---
ipcMain.handle('mobile-add-game', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Game Executable',
        filters: [{ name: 'Executables', extensions: ['exe'] }],
        properties: ['openFile']
    });

    if (result.canceled) return { success: false };

    const gamePath = result.filePaths[0];
    const gameName = path.basename(gamePath, '.exe');

    const existingGame = gameVault.find(g => g.path === gamePath);
    if (!existingGame) {
        gameVault.push({ name: gameName, path: gamePath });
        saveGameVault(gameVault);
        if (mainWindow) mainWindow.webContents.send('vault-updated', gameVault);
        if (connectedSocket) connectedSocket.emit('game-vault', gameVault);
    }

    return { success: true, name: gameName, path: gamePath };
});


// --- ELECTRON UI & TRAY ---
function createTray() {
    const iconPath = path.join(__dirname, 'public', 'favicon.png');
    const trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Command Center', click: () => { if (mainWindow) mainWindow.show(); } },
        { type: 'separator' },
        { label: 'Quit SV-Control', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('SV-Control Engine');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480, height: 650,
        frame: false, backgroundColor: '#11121A',
        resizable: false,
        webPreferences: { 
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,                      
            contextIsolation: true                       
        }
    });
    mainWindow.loadFile('host.html');
    mainWindow.webContents.once('dom-ready', generateNewSession);

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide(); 
        }
        return false;
    });
}

// --- BOOT SEQUENCE ---
app.whenReady().then(async () => {
    try {
        currentPort = await portfinder.getPortPromise({ port: 3000 });
        server.listen(currentPort, '0.0.0.0', () => {
            console.log(`[NETWORK] Engine listening on Port ${currentPort}`);
        });
        
        createWindow();
        createTray();
        
        app.setLoginItemSettings({ openAtLogin: true });
    } catch (err) {
        console.error("Boot Failure:", err);
        app.quit();
    }
});

ipcMain.on('force-kick', () => generateNewSession());
ipcMain.on('close-app', () => { if (mainWindow) mainWindow.hide(); });