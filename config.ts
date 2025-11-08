{
  // Configuration for processes
  export const pythonCommand = {
    path: './.venv/bin/python',
    args: ['webui.py', '--ip', '127.0.0.1', '--port', '7788'],
    workingDir: 'lib/web-ui',
    // Full command string for display
    get display(): string {
      return `${this.path} ${this.args.join(' ')}`;
    }
  };

  // Platform type for OS detection
  type Platform = 'darwin' | 'win32' | 'linux' | string;

  // Define the nodeAPI interface that's injected by the preload script
  declare global {
    interface Window {
      nodeAPI?: {
        platform: Platform;
        homedir: string;
        env: {
          HOME?: string;
          USERPROFILE?: string;
          LOCALAPPDATA?: string;
        };
        pathSep: string;
      };
    }
  }

  // Get platform info from nodeAPI bridge or fallback to browser detection
  function getPlatform(): Platform {
    if (typeof window !== 'undefined' && window.nodeAPI) {
      return window.nodeAPI.platform;
    }
    
    // Fallback to browser detection if nodeAPI is not available
    if (typeof navigator !== 'undefined') {
      const userAgent = navigator.userAgent;
      if (userAgent.includes('Win')) return 'win32';
      if (userAgent.includes('Mac')) return 'darwin';
      if (userAgent.includes('Linux')) return 'linux';
    }
    
    return 'unknown';
  }

  // Get home directory from nodeAPI bridge
  function getHomeDir(): string {
    if (typeof window !== 'undefined' && window.nodeAPI) {
      return window.nodeAPI.homedir || '';
    }
    return '';
  }

  // Get environment variables from nodeAPI bridge
  function getEnvVar(name: string): string {
    if (typeof window !== 'undefined' && window.nodeAPI && window.nodeAPI.env) {
      // Use type assertion to bypass TypeScript's index signature check
      return (window.nodeAPI.env as Record<string, string | undefined>)[name] || '';
    }
    return '';
  }

  // Default Chrome paths by platform
  const CHROME_PATHS: Record<Platform, string[]> = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', // Edge as fallback
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ]
  };

  // Default user data directories by platform and browser
  const USER_DATA_DIRS: Record<Platform, Record<string, string>> = {
    darwin: {
      chrome: `${getHomeDir()}/Library/Application Support/Google/Chrome`,
      edge: `${getHomeDir()}/Library/Application Support/Microsoft Edge`
    },
    win32: {
      chrome: 'C:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
      edge: 'C:\\Users\\user\\AppData\\Local\\Microsoft Edge\\User Data\\Default'
    },
    linux: {
      chrome: `${getHomeDir()}/.config/google-chrome`,
      edge: `${getHomeDir()}/.config/microsoft-edge`
    }
  };

  // Determine Chrome path based on OS
  function getChromePath(): string {
    // Get platform from nodeAPI
    const currentPlatform = getPlatform();
    console.log('Detected platform:', currentPlatform);
    
    const paths = CHROME_PATHS[currentPlatform] || CHROME_PATHS.linux;
    console.log('Potential Chrome paths:', paths);
    
    // Try direct check in Node environment
    if (typeof window === 'undefined' || typeof require !== 'undefined') {
      try {
        // Import fs dynamically to avoid linter errors
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        console.log('Checking if Chrome paths exist using Node.js fs module');
        for (const path of paths) {
          try {
            if (fs.existsSync(path)) {
              console.log('Found Chrome at:', path);
              return path;
            }
          } catch (e) {
            console.warn(`Error checking Chrome path ${path}:`, e);
          }
        }
      } catch (e) {
        console.warn('Could not use fs module to check paths:', e);
      }
    }
    
    // In browser context or if no valid path found, return the first path for the platform
    console.log('Using default Chrome path for platform:', paths[0]);
    return paths[0];
  }

  // Get default user data directory based on OS and browser
  function getUserDataDir(browser: string = 'chrome'): string {
    const homeDir = getHomeDir() || getEnvVar('HOME') || getEnvVar('USERPROFILE') || '';
    const currentPlatform = getPlatform();
    
    const dirs = USER_DATA_DIRS[currentPlatform] || USER_DATA_DIRS.linux;
    return dirs[browser] || dirs.chrome;
  }

  // Detect browser type from path
  function detectBrowserType(path: string): string {
    if (path.toLowerCase().includes('edge') || path.toLowerCase().includes('msedge')) {
      return 'edge';
    }
    return 'chrome';
  }

  // Basic Chrome command class - actual initialization happens in main.ts
  class ChromeCommand {
    private _path = '';
    private _args = [
      '--remote-debugging-port=9222',
      '--window-position=0,0',
      '--disable-web-security'
    ];

    get path(): string {
      return this._path;
    }

    set path(value: string) {
      this._path = value;
    }

    get args(): string[] {
      return this._args;
    }

    set args(value: string[]) {
      this._args = value;
    }

    get display(): string {
      return `${this.path} ${this.args.join(' ')}`;
    }
  }

  export const chromeCommand = new ChromeCommand();
  export { detectBrowserType };
}