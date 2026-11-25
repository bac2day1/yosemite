const { execFile } = require('child_process');
const os = require('os');

/**
 * Send a free phone push notification via ntfy.sh (or any self-hosted ntfy server).
 * Works on iOS & Android with the free ntfy app — no account or payment required.
 */
async function sendNtfyAlert(alertCfg, payload) {
  if (!alertCfg.ntfyEnabled || !alertCfg.ntfyTopic) {
    return { sent: false, skipped: true };
  }

  const base = String(alertCfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
  const topic = encodeURIComponent(String(alertCfg.ntfyTopic).trim());
  const url = `${base}/${topic}`;

  const headers = {
    'Title': payload.title.replace(/[^\x20-\x7E]/g, ''),
    'Priority': payload.priority || 'high',
    'Tags': payload.tags || 'national_park,bell'
  };
  if (payload.clickUrl) {
    headers['Click'] = payload.clickUrl;
    headers['Actions'] = `view, Book Now, ${payload.clickUrl}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: payload.message
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { sent: false, error: `ntfy returned HTTP ${res.status}: ${txt.slice(0, 120)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

/**
 * Send a native OS desktop notification (Windows Toast, macOS osascript, or Linux notify-send).
 * Runs best-effort and never crashes on headless home servers.
 */
function sendDesktopAlert(alertCfg, payload) {
  if (!alertCfg.desktopEnabled) {
    return Promise.resolve({ sent: false, skipped: true });
  }

  const platform = os.platform();
  const safeTitle = String(payload.title || 'Yosemite Room Alert').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const safeBody = String(payload.message || '').replace(/[\r\n]+/g, ' | ').slice(0, 240);

  return new Promise(resolve => {
    if (platform === 'win32') {
      const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const psScript = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
        `$xml = '<toast><visual><binding template="ToastText02"><text id="1">${xmlEscape(safeTitle)}</text><text id="2">${xmlEscape(safeBody)}</text></binding></visual></toast>'`,
        '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
        '$doc.LoadXml($xml)',
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
        '$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Yosemite Lodging Watcher")',
        '$notifier.Show($toast)'
      ].join('; ');

      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 8000 }, err => {
        if (err) {
          resolve({ sent: false, error: err.message });
        } else {
          resolve({ sent: true });
        }
      });
      return;
    }

    if (platform === 'darwin') {
      const script = `display notification "${safeBody.replace(/"/g, '\\"')}" with title "${safeTitle.replace(/"/g, '\\"')}"`;
      execFile('osascript', ['-e', script], { timeout: 5000 }, err => {
        resolve(err ? { sent: false, error: err.message } : { sent: true });
      });
      return;
    }

    // Linux (desktop environments with notify-send; silently skips on headless servers)
    execFile('notify-send', [safeTitle, safeBody], { timeout: 5000 }, err => {
      resolve(err ? { sent: false, error: err.message } : { sent: true });
    });
  });
}

async function dispatchAlerts(alertCfg, payload, broadcastFn) {
  const [ntfy, desktop] = await Promise.all([
    sendNtfyAlert(alertCfg, payload),
    sendDesktopAlert(alertCfg, payload)
  ]);

  if (typeof broadcastFn === 'function') {
    broadcastFn('alert', {
      ...payload,
      browserEnabled: Boolean(alertCfg.browserEnabled),
      soundEnabled: Boolean(alertCfg.soundEnabled),
      timestamp: new Date().toISOString()
    });
  }

  return { ntfy, desktop };
}

module.exports = {
  sendNtfyAlert,
  sendDesktopAlert,
  dispatchAlerts
};
