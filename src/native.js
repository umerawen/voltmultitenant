// The app as a phone app (Capacitor). On the website every export here is a
// no-op or a pass-through, so the web build behaves exactly as before.
//
// Inside the app the page is served from capacitor://localhost (iOS) or
// https://localhost (Android), not from the website, so:
//   · server functions (/api/*) are called on the live site — apiUrl()
//   · links people share (invites, password reset) point at the site — siteUrl()
//   · sign-in and account linking open in the phone's browser and come back
//     through the app's link scheme — openAuthUrl() + the appUrlOpen listener
import { Capacitor } from "@capacitor/core";

export const IS_NATIVE = Capacitor.isNativePlatform();
export const PLATFORM = Capacitor.getPlatform(); // "web" | "ios" | "android"
export const SITE = (import.meta.env.VITE_SITE_URL || "https://voltmultitenant.vercel.app").replace(/\/$/, "");
// The scheme the app registers; OAuth providers send people back to it.
export const APP_SCHEME = "com.voltleagues.app";
export const AUTH_RETURN = `${APP_SCHEME}://auth`;

export const apiUrl = (path) => (IS_NATIVE ? SITE + path : path);
export const siteOrigin = () => (IS_NATIVE ? SITE : window.location.origin);

// Lazily loaded so the website never downloads native plugin code it can't use.
const plug = {
  app: () => import("@capacitor/app").then((m) => m.App),
  browser: () => import("@capacitor/browser").then((m) => m.Browser),
  haptics: () => import("@capacitor/haptics"),
  status: () => import("@capacitor/status-bar"),
  splash: () => import("@capacitor/splash-screen").then((m) => m.SplashScreen),
  share: () => import("@capacitor/share").then((m) => m.Share),
};

// Open a sign-in or linking page in the phone's browser (the in-app browser on
// iOS, a Custom Tab on Android). Google and Discord refuse logins inside a
// plain web view, and the browser keeps the person's existing Discord session.
export async function openAuthUrl(url) {
  if (!IS_NATIVE) { window.location.href = url; return; }
  const Browser = await plug.browser();
  await Browser.open({ url, presentationStyle: "popover", toolbarColor: "#0a0d18" });
}

// A short tap of feedback for moments that matter: a bid, a sale, the draw landing.
export async function haptic(kind = "light") {
  if (!IS_NATIVE) return;
  try {
    const { Haptics, ImpactStyle, NotificationType } = await plug.haptics();
    if (kind === "success") return Haptics.notification({ type: NotificationType.Success });
    if (kind === "heavy") return Haptics.impact({ style: ImpactStyle.Heavy });
    if (kind === "medium") return Haptics.impact({ style: ImpactStyle.Medium });
    return Haptics.impact({ style: ImpactStyle.Light });
  } catch { /* no haptics engine */ }
}

// The phone's share sheet when there is one; otherwise false (the caller copies instead).
export async function shareLink({ title, text, url }) {
  try {
    if (IS_NATIVE) { const Share = await plug.share(); await Share.share({ title, text, url, dialogTitle: title }); return true; }
    if (navigator.share) { await navigator.share({ title, text, url }); return true; }
  } catch { /* cancelled */ }
  return false;
}

// Push notifications. Off unless built with VITE_PUSH=1 — asking Firebase for a
// token on Android without google-services.json crashes the app. Android only
// for now: on iOS this plugin returns an APNs token, which FCM can't send to
// (iOS needs @capacitor-firebase/messaging and an APNs key in Firebase).
// Asks once for permission, then files the device under whoever is signed in
// (volt_push_register).
let pushWired = false;
export async function registerPush(sb) {
  if (!IS_NATIVE || PLATFORM !== "android" || !sb || import.meta.env.VITE_PUSH !== "1") return;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return;
    if (!pushWired) {
      pushWired = true;
      PushNotifications.addListener("registration", ({ value }) => { sb.rpc("volt_push_register", { p_token: value, p_platform: PLATFORM }).then(() => {}, () => {}); });
      PushNotifications.addListener("registrationError", (e) => console.warn("push registration", e));
    }
    await PushNotifications.register();
  } catch (e) { console.warn("push", e); }
}

// Once at start-up: status bar, splash, and links that open the app.
export async function initNative() {
  if (!IS_NATIVE) return;
  document.documentElement.classList.add("is-native", "is-" + PLATFORM);
  try {
    const { StatusBar, Style } = await plug.status();
    await StatusBar.setStyle({ style: Style.Dark });
    if (PLATFORM === "android") await StatusBar.setBackgroundColor({ color: "#0a0d18" });
  } catch { /* not available */ }
  try { (await plug.splash()).hide(); } catch { /* fine */ }

  const App = await plug.app();
  // Links into the app: the OAuth return (com.voltleagues.app://auth#access_token=…),
  // the Discord-link return (…://discord?status=linked) and shared site links
  // (https://<site>/?join=code). Each becomes the same URL inside the app, so
  // the code that already handles them on the website handles them here.
  App.addListener("appUrlOpen", async ({ url }) => {
    try { (await plug.browser()).close(); } catch { /* already closed */ }
    let u; try { u = new URL(url); } catch { return; }
    if (u.protocol === APP_SCHEME + ":") {
      if (u.host === "auth") { window.location.replace("/" + (u.search || "") + (u.hash || "")); return; }
      if (u.host === "discord") { window.location.replace("/?discord=" + encodeURIComponent(u.searchParams.get("status") || "linked")); return; }
      window.location.replace("/" + (u.search || "") + (u.hash || ""));
      return;
    }
    if (u.origin === SITE) window.location.replace("/" + (u.search || "") + (u.hash || ""));
  });
  // Android's back button: back through the app's history, then out.
  App.addListener("backButton", ({ canGoBack }) => { if (canGoBack) window.history.back(); else App.exitApp(); });
}
