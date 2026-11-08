package sk.adna.obrazovka;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Obrazovka v čakárni: celoobrazovkový WebView so stránkou http://SERVER:8080/obrazovka/.
 * Ovládanie diaľkovým ovládačom: MENU / Nastavenia alebo dlhé podržanie OK = nastavenia; Späť 2x = ukončenie.
 */
public class MainActivity extends Activity {
    private static final long RETRY_MS = 5000;
    private static final long HEALTH_MS = 30000;
    private static final long LONG_PRESS_MS = 1500;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private LinearLayout errorView;
    private TextView errorDetail;
    private String loadedUrl = "";
    private boolean mainFrameError = false;
    private long lastBack = 0;
    private long okDownAt = 0;
    private boolean okLongHandled = false;
    private int healthFailures = 0;

    private final Runnable retry = new Runnable() {
        @Override public void run() { load(true); }
    };

    private final Runnable healthCheck = new Runnable() {
        @Override public void run() {
            checkHealth();
            handler.postDelayed(this, HEALTH_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        setContentView(root);
        createWebView();
        createErrorView();
        if (Prefs.serverUrl(this).isEmpty()) {
            openSettings(); // prvé spustenie – treba zadať adresu servera
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void createWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // zvukový signál bez interakcie
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " AdNaObrazovka/" + versionName());
        web.addJavascriptInterface(new Bridge(), "AdNaNative");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (!mainFrameError) hideError();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    mainFrameError = true;
                    showError("Server nie je dostupný (" + err.getDescription() + ").");
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Zostávame iba na stránkach servera AdNa.
                String base = Prefs.serverUrl(MainActivity.this);
                return base.isEmpty() || !req.getUrl().toString().startsWith(base);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Proces prehliadača spadol – vytvoríme WebView nanovo, aplikácia nekončí.
                handler.post(new Runnable() {
                    @Override public void run() {
                        createWebView();
                        root.bringChildToFront(errorView);
                        load(true);
                    }
                });
                return true;
            }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setFocusable(true);
        web.requestFocus();
    }

    private void createErrorView() {
        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorView.setBackgroundColor(Color.WHITE);
        int pad = dp(48);
        errorView.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Obrazovka AdNa sa pripája k serveru…");
        title.setTextColor(Color.parseColor("#C8102E"));
        title.setTextSize(34);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        errorView.addView(title);

        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.parseColor("#111111"));
        errorDetail.setTextSize(22);
        errorDetail.setGravity(Gravity.CENTER);
        errorDetail.setPadding(0, dp(20), 0, dp(28));
        errorView.addView(errorDetail);

        Button settings = new Button(this);
        settings.setText("Nastavenia");
        settings.setTextSize(22);
        settings.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openSettings(); }
        });
        errorView.addView(settings, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showError(String reason) {
        String url = Prefs.displayUrl(this);
        errorDetail.setText(reason + "\n\nAdresa: " + (url.isEmpty() ? "(nenastavená)" : url)
                + "\nPripojenie sa opakuje automaticky každých " + (RETRY_MS / 1000) + " s."
                + "\nNastavenia: tlačidlo MENU alebo dlhé podržanie OK.");
        errorView.setVisibility(View.VISIBLE);
        errorView.bringToFront();
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
    }

    private void hideError() {
        errorView.setVisibility(View.GONE);
        handler.removeCallbacks(retry);
        web.requestFocus();
    }

    private void load(boolean force) {
        String url = Prefs.displayUrl(this);
        if (url.isEmpty()) {
            showError("Nie je nastavená adresa servera.");
            handler.removeCallbacks(retry);
            return;
        }
        if (!force && url.equals(loadedUrl) && !mainFrameError) return;
        mainFrameError = false;
        loadedUrl = url;
        web.loadUrl(url);
    }

    /** Kontrola živosti stránky – ak sa nenačítala alebo neodpovedá, načíta sa znova. */
    private void checkHealth() {
        if (web == null || loadedUrl.isEmpty()) return;
        if (mainFrameError) return; // opakovanie rieši „retry“
        web.evaluateJavascript("(window.AdNaDisplay && window.AdNaDisplay.ok) ? '1' : '0'", new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String v) {
                if (v != null && v.contains("1")) { healthFailures = 0; return; }
                if (++healthFailures >= 2) { healthFailures = 0; load(true); }
            }
        });
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersive();
        load(false);
        handler.removeCallbacks(healthCheck);
        handler.postDelayed(healthCheck, HEALTH_MS);
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(healthCheck);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_SETTINGS) {
            if (e.getAction() == KeyEvent.ACTION_UP) openSettings();
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                okDownAt = e.getEventTime();
                okLongHandled = false;
            } else if (e.getAction() == KeyEvent.ACTION_DOWN && !okLongHandled
                    && e.getEventTime() - okDownAt >= LONG_PRESS_MS) {
                okLongHandled = true;
                openSettings();
                return true;
            } else if (e.getAction() == KeyEvent.ACTION_UP && okLongHandled) {
                return true;
            }
            // Krátke OK ide do stránky (napr. „Zapnúť zvuk“ v prehliadači).
        }
        if (code == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                long now = System.currentTimeMillis();
                if (now - lastBack < 2000) {
                    finish();
                } else {
                    lastBack = now;
                    Toast.makeText(this, "Pre ukončenie obrazovky stlačte Späť ešte raz", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    private String versionName() {
        try {
            PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return p.versionName;
        } catch (Exception e) {
            return "1.0";
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Rozhranie pre JavaScript stránky obrazovky (window.AdNaNative). */
    public class Bridge {
        @JavascriptInterface public boolean isApp() { return true; }
        @JavascriptInterface public String appVersion() { return versionName(); }
        @JavascriptInterface public String platform() { return "android-tv/" + Build.VERSION.SDK_INT; }
        @JavascriptInterface public void openSettings() {
            handler.post(new Runnable() { @Override public void run() { MainActivity.this.openSettings(); } });
        }
    }
}
