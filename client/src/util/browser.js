// Browser/platform detection, used only to show the right "unblock
// notifications" steps. Deliberately coarse — we just need the right menu path,
// and UA sniffing is unreliable for anything more precise than that.

export function detectBrowser() {
  if (typeof navigator === 'undefined') return { id: 'unknown', name: 'your browser', mobile: false };
  const ua = navigator.userAgent;
  const mobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
  const ios = /iphone|ipad|ipod/i.test(ua);
  const android = /android/i.test(ua);

  // Order matters: several browsers include "Safari"/"Chrome" in their UA.
  if (/SamsungBrowser/i.test(ua)) return { id: 'samsung', name: 'Samsung Internet', mobile, android, ios };
  if (/Edg\//i.test(ua)) return { id: 'edge', name: 'Edge', mobile, android, ios };
  if (/OPR\/|Opera/i.test(ua)) return { id: 'opera', name: 'Opera', mobile, android, ios };
  if (/Firefox\/|FxiOS/i.test(ua)) return { id: 'firefox', name: 'Firefox', mobile, android, ios };
  if (/CriOS/i.test(ua)) return { id: 'chrome-ios', name: 'Chrome on iPhone', mobile, android, ios };
  if (/Chrome\//i.test(ua)) return { id: android ? 'chrome-android' : 'chrome', name: 'Chrome', mobile, android, ios };
  if (/Safari\//i.test(ua)) return { id: ios ? 'safari-ios' : 'safari', name: 'Safari', mobile, android, ios };
  return { id: 'unknown', name: 'your browser', mobile, android, ios };
}

// Step-by-step route back to "Allow" for a site the user has blocked.
export function unblockSteps(browser = detectBrowser()) {
  switch (browser.id) {
    case 'chrome-android':
      return [
        'Tap the 🔒 (or ⓘ) icon to the left of the web address',
        'Tap Permissions → Notifications',
        'Switch Notifications to Allow',
        'Come back here and tap "I\'ve allowed it"',
      ];
    case 'chrome':
    case 'edge':
    case 'opera':
      return [
        'Click the icon to the left of the web address (🔒 or ⚙)',
        'Find Notifications in the list',
        'Change it from Block to Allow',
        'Reload the page',
      ];
    case 'samsung':
      return [
        'Open the ☰ menu → Settings',
        'Tap Sites and downloads → Site permissions → Notifications',
        'Find this site and switch it to Allow',
        'Reload the page',
      ];
    case 'firefox':
      return [
        'Tap/click the 🔒 icon next to the web address',
        'Find "Send Notifications — Blocked"',
        'Tap the ✕ to clear the block',
        'Reload the page and allow when asked',
      ];
    case 'safari-ios':
    case 'chrome-ios':
      return [
        'Notifications on iPhone only work once the app is installed',
        'In Safari, tap Share → Add to Home Screen',
        'Open CoinLudo from your home screen (not the browser)',
        'Tap "Allow notifications" there',
      ];
    case 'safari':
      return [
        'Open Safari → Settings (or Preferences)',
        'Go to the Websites tab → Notifications',
        'Find this site and set it to Allow',
        'Reload the page',
      ];
    default:
      return [
        'Open your browser settings',
        'Find Site settings (or Permissions) → Notifications',
        'Find this site and change it to Allow',
        'Reload the page',
      ];
  }
}
