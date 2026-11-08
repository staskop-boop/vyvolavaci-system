package sk.adna.tablet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Kiosk aplikácia pre tablet v čakárni. Zobrazuje webové rozhranie /tablet/ zo servera AdNa
 * na celej obrazovke. Pri nedostupnom serveri ukáže vlastnú stránku a každých 5 s to skúša znova.
 */
public class MainActivity extends Activity {
    private static final long RETRY_MS = 5000;
    private static final int REQ_SETTINGS = 1;
    private static final int SECRET_TAPS = 5;
    private static final long SECRET_WINDOW_MS = 3000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Prefs prefs;
    private WebView web;
    private LinearLayout offline;
    private TextView offlineDetail;
    private boolean pageError;
    private boolean retryScheduled;
    private boolean paused;
    private final long[] taps = new long[SECRET_TAPS];
    private int tapIdx;
    private int wrongPins;
    private long pinLockedUntil;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        prefs.setKioskSuspended(false); // každé nové spustenie kiosk opäť zapne
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        buildUi();
        if (!prefs.hasPin() || prefs.serverUrl().isEmpty()) {
            // Prvé spustenie: najprv nastavenie PIN-u správcu a adresy servera.
            openSettings(true);
        } else {
            loadApp();
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        web = new WebView(this);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setTextZoom(100);
        web.setLongClickable(false);
        web.setOnLongClickListener(v -> true);
        web.setHapticFeedbackEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new NativeBridge(), "AdNaNative");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new KioskClient());
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        // Vlastná stránka pri výpadku servera / siete.
        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER);
        offline.setBackgroundColor(Color.WHITE);
        offline.setPadding(Ui.dp(this, 32), Ui.dp(this, 32), Ui.dp(this, 32), Ui.dp(this, 32));
        TextView brand = Ui.text(this, "AdNa", 64, Ui.BLUE, true);
        brand.setGravity(Gravity.CENTER);
        TextView msg = Ui.text(this, "Registrácia je dočasne nedostupná.", 30, Ui.TEXT, true);
        msg.setGravity(Gravity.CENTER);
        TextView msg2 = Ui.text(this, "Obráťte sa, prosím, na sestru. Spojenie sa obnovuje automaticky.", 22, Ui.MUTED, false);
        msg2.setGravity(Gravity.CENTER);
        offlineDetail = Ui.text(this, "", 16, Ui.MUTED, false);
        offlineDetail.setGravity(Gravity.CENTER);
        offline.addView(brand);
        offline.addView(msg, Ui.wrap(this, 24));
        offline.addView(msg2, Ui.wrap(this, 12));
        offline.addView(offlineDetail, Ui.wrap(this, 32));
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));

        // Skrytý vstup do nastavení: 5 ťuknutí do ľavého horného rohu do 3 sekúnd.
        View hotspot = new View(this);
        hotspot.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == MotionEvent.ACTION_DOWN) onSecretTap();
            return true;
        });
        root.addView(hotspot, new FrameLayout.LayoutParams(Ui.dp(this, 90), Ui.dp(this, 90), Gravity.TOP | Gravity.START));

        setContentView(root);
    }

    private void onSecretTap() {
        long now = SystemClock.uptimeMillis();
        taps[tapIdx] = now;
        tapIdx = (tapIdx + 1) % SECRET_TAPS;
        long oldest = taps[tapIdx];
        if (oldest != 0 && now - oldest <= SECRET_WINDOW_MS) {
            java.util.Arrays.fill(taps, 0);
            askAdminPin();
        }
    }

    private void askAdminPin() {
        long now = SystemClock.elapsedRealtime();
        if (now < pinLockedUntil) {
            Toast.makeText(this, "Príliš veľa nesprávnych pokusov. Skúste o " + ((pinLockedUntil - now) / 1000 + 1) + " s.", Toast.LENGTH_LONG).show();
            return;
        }
        Ui.askPin(this, "PIN správcu", pin -> {
            if (prefs.checkPin(pin)) {
                wrongPins = 0;
                openSettings(false);
            } else {
                wrongPins++;
                if (wrongPins >= 5) { wrongPins = 0; pinLockedUntil = SystemClock.elapsedRealtime() + 60_000; }
                Toast.makeText(this, "Nesprávny PIN.", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void openSettings(boolean firstRun) {
        Intent i = new Intent(this, SettingsActivity.class);
        i.putExtra(SettingsActivity.EXTRA_FIRST_RUN, firstRun);
        startActivityForResult(i, REQ_SETTINGS);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SETTINGS) return;
        if (resultCode == SettingsActivity.RESULT_EXIT_KIOSK) {
            prefs.setKioskSuspended(true);
            stopKiosk();
            Toast.makeText(this, "Kiosk režim je pozastavený. Opätovne sa zapne pri ďalšom spustení aplikácie.", Toast.LENGTH_LONG).show();
            moveTaskToBack(true);
            return;
        }
        if (!prefs.hasPin() || prefs.serverUrl().isEmpty()) { openSettings(true); return; }
        loadApp();
    }

    private void loadApp() {
        pageError = false;
        String url = prefs.serverUrl() + "/tablet/";
        web.loadUrl(url);
    }

    private void showOffline(String detail) {
        pageError = true;
        offlineDetail.setText(detail == null ? "" : detail);
        offline.setVisibility(View.VISIBLE);
        scheduleRetry();
    }

    private void scheduleRetry() {
        if (retryScheduled || paused) return;
        retryScheduled = true;
        main.postDelayed(() -> {
            retryScheduled = false;
            final String server = prefs.serverUrl();
            new Thread(() -> {
                final boolean ok = Net.health(server);
                main.post(() -> {
                    if (ok) loadApp(); else scheduleRetry();
                });
            }, "adna-health").start();
        }, RETRY_MS);
    }

    private boolean isServerUrl(Uri u) {
        Uri s = Uri.parse(prefs.serverUrl());
        return u != null && s.getHost() != null && s.getHost().equalsIgnoreCase(u.getHost())
                && s.getPort() == u.getPort() && String.valueOf(s.getScheme()).equalsIgnoreCase(u.getScheme());
    }

    private class KioskClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Mimo servera AdNa sa navigovať nedá.
            return !isServerUrl(request.getUrl());
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!pageError) offline.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline("Server: " + prefs.serverUrl() + " – " + error.getDescription());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse r) {
            if (request.isForMainFrame() && r.getStatusCode() >= 400) showOffline("Server odpovedal chybou " + r.getStatusCode() + ".");
        }
    }

    /** Rozhranie pre JavaScript (window.AdNaNative). Neposkytuje žiadne citlivé údaje. */
    final class NativeBridge {
        @JavascriptInterface public String getDeviceId() { return prefs.deviceId(); }
        @JavascriptInterface public String getAppVersion() { return "1.0.0"; }
        @JavascriptInterface public boolean isApp() { return true; }
    }

    // ---------- kiosk ----------
    private void startKiosk() {
        if (prefs.kioskSuspended()) return;
        try {
            ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE) return;
            DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
            if (dpm != null && dpm.isDeviceOwnerApp(getPackageName())) {
                dpm.setLockTaskPackages(new ComponentName(this, AdminReceiver.class), new String[]{getPackageName()});
                startLockTask();                       // plný kiosk bez potvrdenia
            } else if (prefs.screenPinning()) {
                startLockTask();                       // pripnutie obrazovky – Android si vyžiada potvrdenie
            }
        } catch (Exception ignored) {
            // Kiosk režim nie je dostupný – aplikácia funguje ďalej na celej obrazovke.
        }
    }

    private void stopKiosk() {
        try { stopLockTask(); } catch (Exception ignored) { }
    }

    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        paused = false;
        hideSystemUi();
        web.onResume();
        if (prefs.hasPin() && !prefs.serverUrl().isEmpty()) startKiosk();
        if (pageError) scheduleRetry();
    }

    @Override
    protected void onPause() {
        paused = true;
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        prefs.setKioskSuspended(false); // nové spustenie (napr. po reštarte) kiosk opäť zapne
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Tlačidlo Späť je v kiosk režime vypnuté.
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
