import { isEditorOrigin } from './lib/editor-origins'

/**
 * @deprecated This file is DEPRECATED as of January 2026.
 *
 * Console logging functionality has been moved to the OverSkill Runtime SDK:
 * https://sdk.overskill.com/v1/platform.js
 *
 * The Runtime SDK is loaded via script tag in index.html and provides:
 * - ConsoleLogger: Same functionality, but hot-updatable from CDN
 * - ErrorReporter: New error capture and deduplication
 * - Version tracking and automatic updates
 *
 * This file is kept for backward compatibility with existing apps that
 * may still import it directly. New apps should NOT import this file.
 *
 * Migration: Remove `import './consoleLogger'` from main.tsx
 * The SDK handles everything automatically when loaded from index.html.
 */

// Console Logger - Captures console logs and sends to OverSkill for AI debugging
// This enables the AI to read actual browser console logs when debugging issues

class ConsoleLogger {
  constructor() {
    this.logs = [];
    this.maxLogs = 100; // Keep last 100 logs in memory
    this.appId = this.getAppId();
    this.sendInterval = 5000; // Send logs every 5 seconds
    this.originalConsole = {};

    // Don't initialize in production to avoid overhead
    if (this.shouldEnable()) {
      this.init();
    }
  }

  shouldEnable() {
    // CRITICAL: Skip if Runtime SDK is already handling console logging
    // The SDK loads via <script defer> before this module code runs
    // This prevents duplicate requests and CORS issues
    if (window.OverSkillPlatform || window.__OVERSKILL_SDK_LOADED__) {
      console.log('[ConsoleLogger] Runtime SDK detected - skipping deprecated bundled logger');
      return false;
    }

    // CRITICAL: Only enable if in iframe (being viewed in OverSkill editor)
    // Don't run when app is viewed directly (wastes requests, causes errors)
    const isInIframe = window.parent !== window && window.parent !== null;

    if (!isInIframe) {
      console.log('[Preview Auth] Not in iframe - skipping console logger');
      return false;
    }

    // Enable in development or if explicitly enabled
    const appConfig = window.APP_CONFIG || {};
    return appConfig.ENVIRONMENT === 'development' ||
           appConfig.CONSOLE_LOGGING_ENABLED === true ||
           isInIframe;  // Always enable if in iframe for AI debugging
  }

  getAppId() {
    // Priority 1: APP_CONFIG (injected by WorkerScriptAssembler)
    if (window.APP_CONFIG && window.APP_CONFIG.APP_ID) {
      return window.APP_CONFIG.APP_ID;
    }

    // Priority 2: Vite environment variable
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_ID) {
      return import.meta.env.VITE_APP_ID;
    }

    // Priority 3: Extract from preview URL (fallback for older apps without APP_CONFIG)
    // Preview URLs: preview-{appId}.overskill.app or {appId}.overskill.app
    try {
      const hostname = window.location.hostname;
      if (hostname.includes('overskill.app')) {
        // Extract appId from subdomain: preview-{appId} or {appId}
        const subdomain = hostname.split('.')[0];
        if (subdomain.startsWith('preview-')) {
          return subdomain.replace('preview-', '');
        }
        // Direct app URL: {appId}.overskill.app
        return subdomain;
      }
    } catch (e) {
      // Fallthrough to unknown
    }

    return 'unknown';
  }

  init() {
    // Store original console methods
    this.originalConsole = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console)
    };

    // Override console methods
    console.log = (...args) => this.captureLog('log', args);
    console.error = (...args) => this.captureLog('error', args);
    console.warn = (...args) => this.captureLog('warn', args);
    console.info = (...args) => this.captureLog('info', args);
    console.debug = (...args) => this.captureLog('debug', args);

    // Capture unhandled errors
    window.addEventListener('error', (event) => {
      this.captureLog('error', [
        `Uncaught ${event.error?.name || 'Error'}: ${event.message}`,
        `at ${event.filename}:${event.lineno}:${event.colno}`
      ]);
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.captureLog('error', [
        `Unhandled Promise Rejection: ${event.reason}`
      ]);
    });

    // Start periodic sending
    this.startPeriodicSend();

    console.log('[ConsoleLogger] Console logging enabled for AI debugging');
  }

  captureLog(level, args) {
    // Call original console method first
    this.originalConsole[level](...args);

    // Capture log entry
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level,
      message: this.formatArgs(args),
      appId: this.appId
    };

    // Add to memory buffer
    this.logs.push(logEntry);

    // Keep only last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Send critical errors immediately
    if (level === 'error') {
      this.sendLogsToServer();
    }
  }

  formatArgs(args) {
    return args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  }

  startPeriodicSend() {
    setInterval(() => {
      if (this.logs.length > 0) {
        this.sendLogsToServer();
      }
    }, this.sendInterval);
  }

  getBridgeBaseUrl() {
    // Priority 1: Cached URL from parent (set via postMessage)
    if (isEditorOrigin(this.bridgeBaseUrl)) {
      return this.bridgeBaseUrl;
    }

    // Priority 2: APP_CONFIG.BRIDGE_URL (set during deployment)
    if (isEditorOrigin(window.APP_CONFIG?.BRIDGE_URL)) {
      return window.APP_CONFIG.BRIDGE_URL;
    }

    // Priority 3: Parse document.referrer (parent window URL)
    if (document.referrer) {
      try {
        const referrerUrl = new URL(document.referrer);
        // Only use referrer if it's an overskill.com domain (not overskill.app)
        if (isEditorOrigin(referrerUrl.origin)) {
          // Handle different overskill.com environments:
          // - dev.overskill.com → use as-is (development environment)
          // - staging.overskill.com → use as-is (staging environment)
          // - overskill.com → normalize to www.overskill.com (production non-www redirects)
          // - www.overskill.com → use as-is (production)
          let normalizedHostname = referrerUrl.hostname;

          // Only add www. prefix to BARE overskill.com (not subdomains like dev.overskill.com)
          // CORS preflight requests can't follow redirects, so we need the final URL
          if (referrerUrl.hostname === 'overskill.com') {
            normalizedHostname = 'www.overskill.com';
          }

          return `${referrerUrl.protocol}//${normalizedHostname}`;
        }
      } catch (e) {
        // Invalid URL, continue to fallback
      }
    }

    // Priority 4: Determine environment from preview URL
    const hostname = window.location.hostname;

    // Local development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:3000';
    }

    // Preview apps on overskill.app should send to www.overskill.com (production)
    // or dev.overskill.com if in development mode
    if (hostname.includes('overskill.app')) {
      // Check if this is a development/staging preview
      // Development previews might have specific indicators
      const isDev = window.APP_CONFIG?.ENVIRONMENT === 'development' ||
                    hostname.includes('dev-') ||
                    hostname.includes('staging-');
      return isDev ? 'https://dev.overskill.com' : 'https://www.overskill.com';
    }

    // Default fallback to production
    return 'https://www.overskill.com';
  }

  async sendLogsToServer() {
    if (this.logs.length === 0) return;

    const logsToSend = [...this.logs];
    this.logs = []; // Clear after copying

    try {
      const baseUrl = this.getBridgeBaseUrl();

      // Validate we have a proper absolute URL
      if (!baseUrl || !baseUrl.startsWith('http')) {
        this.originalConsole.warn('[ConsoleLogger] Invalid bridge URL:', baseUrl);
        this.logs = [...logsToSend, ...this.logs].slice(-this.maxLogs);
        return;
      }

      // Send each log to iframe bridge endpoint
      // Use Promise.all to send in parallel but don't wait (fire and forget)
      const promises = logsToSend.map(log =>
        fetch(`${baseUrl}/api/v1/iframe_bridge/${this.appId}/log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'console',
            data: log
          })
        }).catch(() => {}) // Silent fail per log
      );

      // Fire and forget - don't await
      Promise.all(promises);
    } catch (error) {
      // Silently fail - don't spam console with logging errors
      // Restore logs to buffer if send failed
      this.logs = [...logsToSend, ...this.logs].slice(-this.maxLogs);
    }
  }

  // Public API for manual log retrieval
  getLogs() {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
  }
}

// Create singleton instance
const consoleLogger = new ConsoleLogger();

// Export for access in components if needed
export default consoleLogger;

// Make available globally for debugging
if (typeof window !== 'undefined') {
  window.consoleLogger = consoleLogger;
}
