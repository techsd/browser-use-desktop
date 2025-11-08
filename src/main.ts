import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { spawn, ChildProcess } from 'child_process';
import started from 'electron-squirrel-startup';
import { pythonCommand, chromeCommand, detectBrowserType, getUserDataDir } from './config';
import fs from 'fs';
import os from 'os';
import http from 'http';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let pyProcess: ChildProcess | null = null;
let chromeProcess: ChildProcess | null = null;

// Clear any potentially existing IPC handlers
function clearIPCHandlers() {
  ipcMain.removeAllListeners('restart-python');
  ipcMain.removeAllListeners('restart-chrome');
}

// Create required directories
function createRequiredDirectories() {
  const baseDir = path.join(os.homedir(), 'Downloads', 'browser-use');
  const dirs = ['recordings', 'traces', 'history'];
  
  dirs.forEach(dir => {
    const dirPath = path.join(baseDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  });
}

// Load default settings from JSON
function loadDefaultSettings() {
  const settingsPath = path.join(app.getAppPath(), 'lib/web-ui/tmp/webui_settings/31ccfe5a-ef3b-4064-836c-6910ab3a3281.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings;
    }
  } catch (e) {
    console.error('Error loading default settings:', e);
  }
  return null;
}

const createWindow = () => {
  // Make sure we clean up any existing handlers first
  clearIPCHandlers();
  
  // Get the primary display dimensions
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  // Calculate half width for positioning
  const halfWidth = Math.floor(width / 2);
  
  // Create the browser window positioned on left half
  const mainWindow = new BrowserWindow({
    width: halfWidth,
    height: height,
    x: 0,
    y: 0,
    frame: false, // Remove window frame
    titleBarStyle: 'hidden', // Hide title bar on macOS
    backgroundColor: '#000000', // Set black background
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // Enable webview tag
      sandbox: false, // Disable sandbox for preload script
    },
  });

  // Set up dark mode
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      body {
        background-color: #000000;
        color: #ffffff;
      }
      * {
        color-scheme: dark;
      }
    `);
  });
  
  // Clean up IPC handlers when window is closed
  mainWindow.on('closed', () => {
    clearIPCHandlers();
  });
  
  // Set up IPC handlers for restarting processes
  ipcMain.on('restart-python', () => {
    startPyProcess(mainWindow);
  });
  
  ipcMain.on('restart-chrome', () => {
    startChromeProcess(mainWindow);
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();

  // Load default settings and pass them to the web UI
  const defaultSettings = loadDefaultSettings();
  if (defaultSettings) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('load-default-settings', defaultSettings);
    });
  }

  // Start the Python process
  startPyProcess(mainWindow);
  
  // Wait a bit before starting Chrome to ensure Python is running first
  setTimeout(() => {
    startChromeProcess(mainWindow);
  }, 1000);
};

function startPyProcess(mainWindow: BrowserWindow) {
  // Find Chrome path first - needed for environment variables
  const chromePath = findBestChromeExecutable();
  if (!chromePath) {
    console.error('Could not find Chrome for Python process environment');
  }
  
  // Ensure user data directory exists
  const userDataDir = ensureChromeUserDataDir(chromePath);
  
  // Working directory for the subprocess
  const options = {
    cwd: path.join(app.getAppPath(), pythonCommand.workingDir),
    shell: false,
    env: {
      ...process.env,
      BROWSER_USE_DESKTOP_APP: 'true',
      CHROME_PATH: chromePath || '',
      CHROME_CDP: 'http://localhost:9222',
      CHROME_USER_DATA: userDataDir
    }
  };

  // Clear existing process if it exists
  if (pyProcess) {
    try {
      // Remove all listeners first to prevent callback after destroy
      pyProcess.stdout.removeAllListeners();
      pyProcess.stderr.removeAllListeners();
      pyProcess.removeAllListeners();
      
      pyProcess.kill();
    } catch (e) {
      console.error('Error killing Python process:', e);
    }
    pyProcess = null;
  }

  // Spawn the Python process
  pyProcess = spawn(pythonCommand.path, pythonCommand.args, options);
  
  // Send process output to the renderer
  pyProcess.stdout.on('data', (data) => {
    const output = data.toString();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-output', { type: 'stdout', data: output });
    }
  });
  
  pyProcess.stderr.on('data', (data) => {
    const output = data.toString();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-output', { type: 'stderr', data: output });
    }
  });
  
  pyProcess.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-output', { 
        type: 'error', 
        data: `Failed to start subprocess: ${error.message}` 
      });
    }
  });
  
  pyProcess.on('close', (code) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-output', { 
        type: 'info', 
        data: `Python process exited with code ${code}` 
      });
    }
    pyProcess = null;
  });
  
  // Notify the renderer the process has started
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('py-started');
  }
  
  // We'll let the renderer detect when the server is ready from the stdout logs
  // but still send the ready signal after a longer timeout as a fallback
  setTimeout(() => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('py-ready', 'http://127.0.0.1:7788');
    }
  }, 10000); // 10 seconds delay as fallback
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createRequiredDirectories();
  createWindow();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Kill the Python and Chrome processes before the app quits
app.on('before-quit', (event) => {
  // Prevent the default quit behavior so we can clean up first
  event.preventDefault();
  
  // Counter to track cleanup completion
  let cleanupCounter = 0;
  const processesToCleanup = (pyProcess ? 1 : 0) + (chromeProcess ? 1 : 0);
  
  if (processesToCleanup === 0) {
    // No processes to clean up, safe to quit immediately
    app.exit(0);
    return;
  }
  
  // Set a safety timeout to force quit after 1 second if processes don't exit properly
  const forceQuitTimeout = setTimeout(() => {
    console.warn('Force quitting after timeout');
    app.exit(0);
  }, 1000);
  
  // Function to check if cleanup is done
  const checkCleanup = () => {
    cleanupCounter++;
    if (cleanupCounter >= processesToCleanup) {
      // All processes cleaned up, now safe to exit
      clearTimeout(forceQuitTimeout); // Clear the force quit timeout
      app.exit(0);
    }
  };
  
  // Clean up Python process
  if (pyProcess) {
    try {
      // Kill the process immediately
      pyProcess.kill('SIGKILL');
      pyProcess = null;
      checkCleanup();
    } catch (e) {
      console.error('Error killing Python process:', e);
      pyProcess = null;
      checkCleanup();
    }
  }
  
  // Clean up Chrome process
  if (chromeProcess) {
    try {
      // Kill the process immediately
      chromeProcess.kill('SIGKILL');
      chromeProcess = null;
      checkCleanup();
    } catch (e) {
      console.error('Error killing Chrome process:', e);
      chromeProcess = null;
      checkCleanup();
    }
  }
});

function startChromeProcess(mainWindow: BrowserWindow) {
  // Clear existing process if it exists
  if (chromeProcess) {
    try {
      // Remove all listeners first to prevent callback after destroy
      chromeProcess.stdout.removeAllListeners();
      chromeProcess.stderr.removeAllListeners();
      chromeProcess.removeAllListeners();
      
      chromeProcess.kill();
    } catch (e) {
      console.error('Error killing Chrome process:', e);
    }
    chromeProcess = null;
  }

  // Find the best Chrome executable for the current OS
  const chromePath = findBestChromeExecutable();
  if (!chromePath) {
    const errorMsg = 'Could not find a valid Chrome executable. Please install Google Chrome and try again.';
    console.error(errorMsg);
    mainWindow.webContents.send('chrome-output', { type: 'error', data: errorMsg });
    return;
  }
  
  // Update chromeCommand with the found path
  chromeCommand.path = chromePath;
  
  // Ensure Chrome user data directory exists
  const userDataDir = ensureChromeUserDataDir(chromePath);
  
  // Get screen dimensions for window positioning
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const halfWidth = Math.floor(width / 2);
  
  // Compose Chrome arguments with the validated user data directory
  const args = [
    '--remote-debugging-port=9222',
    `--window-position=${halfWidth},0`,
    `--window-size=${halfWidth},${height}`,
    '--install-autogenerated-theme=0,0,0', // Theme setting
    '--disable-web-security',
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check'
  ];
  
  // Add compatibility flags
  args.push('--disable-features=TranslateUI');
  args.push('--disable-extensions');
  
  // Add minimal necessary flags for stability based on platform
  if (process.platform === 'linux') {
    // Linux often needs these flags
    args.push('--no-sandbox');
    args.push('--disable-gpu');
  }
  
  // Store the args in chromeCommand for other parts of the app
  chromeCommand.args = args;
  
  // Log Chrome launch information
  console.log('Launching Chrome with path:', chromePath);
  console.log('Chrome arguments:', args);
  
  try {
    // Spawn the Chrome process
    chromeProcess = spawn(chromePath, args);
    
    if (!chromeProcess || !chromeProcess.pid) {
      const errorMsg = `Failed to launch Chrome process - could not start the process`;
      console.error(errorMsg);
      mainWindow.webContents.send('chrome-output', { type: 'error', data: errorMsg });
      return;
    }
    
    console.log(`Chrome process started with PID: ${chromeProcess.pid}`);
    
    // Set up Chrome process event listeners
    chromeProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('Chrome stdout:', output);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome-output', { type: 'stdout', data: output });
      }
    });
    
    chromeProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log('Chrome stderr:', output);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome-output', { type: 'stderr', data: output });
      }
    });
    
    chromeProcess.on('error', (error) => {
      console.error('Chrome process error:', error.message);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome-output', { 
          type: 'error', 
          data: `Failed to start Chrome: ${error.message}` 
        });
      }
    });
    
    chromeProcess.on('close', (code) => {
      console.log(`Chrome process exited with code ${code}`);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome-output', { 
          type: 'info', 
          data: `Chrome process exited with code ${code}` 
        });
      }
      chromeProcess = null;
    });
    
    // Notify the renderer the process has started
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome-started');
    }
    
    // Verify Chrome is listening on debug port
    setTimeout(() => {
      verifyChromeLaunched(mainWindow);
    }, 2000);
  } catch (error) {
    const errorMsg = `Unexpected error launching Chrome: ${error}`;
    console.error(errorMsg);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome-output', { type: 'error', data: errorMsg });
    }
  }
}

/**
 * Verifies that Chrome launched successfully and is accessible via debug port
 */
function verifyChromeLaunched(mainWindow: BrowserWindow): void {
  console.log('Verifying Chrome is accessible on debug port...');
  
  try {
    // Try to connect to Chrome's debug port
    const options = {
      host: '127.0.0.1',
      port: 9222,
      path: '/json/version',
      timeout: 2000
    };
    
    const req = http.get(options, (res) => {
      if (res.statusCode === 200) {
        console.log('Chrome debug port connection successful');
        
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const info = JSON.parse(data);
            console.log('Chrome debug info:', info);
            
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send('chrome-output', { 
                type: 'info', 
                data: `Chrome ready - ${info.Browser || 'Chrome'} [${info.Protocol || 'CDP'}]` 
              });
            }
          } catch (e) {
            console.error('Error parsing Chrome debug info:', e);
          }
        });
      } else {
        console.error(`Chrome debug port returned status code: ${res.statusCode}`);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('chrome-output', { 
            type: 'warning', 
            data: `Chrome may not be fully initialized (status: ${res.statusCode})` 
          });
        }
      }
    });
    
    req.on('error', (e) => {
      console.error('Error connecting to Chrome debug port:', e.message);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome-output', { 
          type: 'warning', 
          data: `Chrome debug port not accessible: ${e.message}. The browser may still be starting.` 
        });
      }
    });
    
    req.end();
  } catch (e) {
    console.error('Error verifying Chrome launch:', e);
  }
}

/**
 * Finds the best Chrome executable for the current OS
 * @returns The path to the Chrome executable or null if not found
 */
function findBestChromeExecutable(): string | null {
  // Define platform-specific paths in order of preference
  const paths: string[] = [];
  
  if (process.platform === 'darwin') {
    // macOS paths
    paths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    paths.push('/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta');
    paths.push('/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev');
    paths.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    // Add fallback for homebrew installations
    paths.push('/opt/homebrew/bin/chromium');
  } else if (process.platform === 'win32') {
    // Windows paths
    paths.push('C:\Program Files\Google\Chrome\Application\chrome.exe');
    paths.push('C:\Program Files (x86)\Google\Chrome\Application\chrome.exe');
    
    // Add LocalAppData path if available
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      paths.push(`${localAppData}\Google\Chrome\Application\chrome.exe`);
    }
    
    // Microsoft Edge as fallback (Chromium-based)
    paths.push('C:\Program Files\Microsoft\Edge\Application\msedge.exe');
    paths.push('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe');
  } else {
    // Linux paths
    paths.push('/usr/bin/google-chrome');
    paths.push('/usr/bin/google-chrome-stable');
    paths.push('/opt/google/chrome/chrome');
    paths.push('/usr/bin/chromium-browser');
    paths.push('/usr/bin/chromium');
    paths.push('/snap/bin/chromium');
  }
  
  console.log('Checking for Chrome at these paths:', paths);
  
  // Find first existing path
  for (const path of paths) {
    if (fs.existsSync(path)) {
      console.log(`Found Chrome executable at: ${path}`);
      return path;
    }
  }
  
  console.error('No Chrome executable found in common locations');
  return null;
}

/**
 * Ensures the Chrome user data directory exists
 * @param chromePath The path to the Chrome executable
 * @returns The path to the Chrome user data directory
 */
function ensureChromeUserDataDir(chromePath: string | null): string {
  // Detect browser type
  const browserType = chromePath ? detectBrowserType(chromePath) : 'chrome';
  console.log('Detected browser type:', browserType);
  
  // Get user data directory from config based on browser type
  const userDataDir = getUserDataDir(browserType);
  console.log(`Using ${browserType} user data directory: ${userDataDir}`);
  
  // Ensure the directory exists
  try {
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      console.log(`Created ${browserType} user data directory: ${userDataDir}`);
      
      // Create first_run file to prevent first run experience
      const firstRunPath = path.join(userDataDir, 'First Run');
      fs.writeFileSync(firstRunPath, '');
      console.log('Created First Run file to disable welcome screen');
      
      // Create an empty Preferences file with basic settings
      const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
      
      // Create Default directory if it doesn't exist
      const defaultDir = path.join(userDataDir, 'Default');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      
      // Basic preferences to disable welcome page, etc.
      const defaultPrefs = {
        browser: {
          custom_chrome_frame: false,
          check_default_browser: false
        },
        profile: {
          default_content_setting_values: {
            notifications: 2 // Block notifications: 1=allow, 2=block, 3=ask
          }
        },
        session: {
          restore_on_startup: 5 // Don't restore anything: 5=open new tab
        },
        bookmark_bar: {
          show_on_all_tabs: false
        },
        distribution: {
          import_bookmarks: false,
          import_history: false,
          import_search_engine: false,
          make_chrome_default: false,
          show_welcome_page: false,
          skip_first_run_ui: true
        }
      };
      
      fs.writeFileSync(prefsPath, JSON.stringify(defaultPrefs, null, 2));
      console.log('Created default Chrome preferences file');
    } else {
      console.log(`Using existing ${browserType} user data directory: ${userDataDir}`);
    }
  } catch (err) {
    console.error(`Error creating ${browserType} user data directory: ${err}`);
    // Fallback to a temporary directory
    const fallbackDir = path.join(os.tmpdir(), `${browserType}-user-data`);
    fs.mkdirSync(fallbackDir, { recursive: true });
    console.log(`Using fallback ${browserType} user data directory: ${fallbackDir}`);
    return fallbackDir;
  }
  
  return userDataDir;
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.