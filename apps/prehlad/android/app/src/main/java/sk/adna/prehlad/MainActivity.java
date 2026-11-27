package sk.adna.prehlad;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * AdNa Prehľad – živý stav ambulancie na diaľku. Zobrazuje stránku /prehlad/ zo servera AdNa
 * (prihlásenie rovnakým kontom ako v aplikácii Sestra). Všetky údaje ostávajú na serveri – appka je len okno.
 * Pri výpadku spojenia ukáže vlastnú stránku a skúša to znova; adresu servera možno zmeniť (napr. LAN v ambulancii).
 */
public class MainActivity extends Activity {
    private static final long RETRY_MS = 10000;
    private static final String RED = "#BC1A21";

    private final Handler main = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private WebView web;
    private LinearLayout offline;
    private TextView offlineDetail;
    private boolean pageError;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("adna", MODE_PRIVATE);
        getWindow().setStatusBarColor(Color.parseColor(RED));
        buildUi();
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else load();
    }

    private String serverUrl() {
        return prefs.getString("url", BuildConfig.DEFAULT_URL);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private TextView text(String s, int sp, String color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(Color.parseColor(color));
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#F8F1F1"));

        CookieManager.getInstance().setAcceptCookie(true);
        web = new WebView(this);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setSupportZoom(false);
        ws.setTextZoom(100);
        ws.setUserAgentString(ws.getUserAgentString() + " AdNaPrehlad/" + BuildConfig.VERSION_NAME);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client());
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER);
        offline.setBackgroundColor(Color.WHITE);
        offline.setPadding(dp(28), dp(28), dp(28), dp(28));
        offline.addView(text("AdNa", 48, RED, true));
        TextView msg = text("⚠ Server ambulancie je teraz nedostupný.", 20, "#1A1A1A", true);
        offline.addView(msg);
        TextView msg2 = text("Skontrolujte pripojenie na internet. Spojenie sa obnovuje automaticky.", 16, "#434242", false);
        msg2.setPadding(0, dp(10), 0, 0);
        offline.addView(msg2);
        offlineDetail = text("", 13, "#5D5B5B", false);
        offlineDetail.setPadding(0, dp(16), 0, dp(16));
        offline.addView(offlineDetail);
        Button retry = new Button(this);
        retry.setText("Skúsiť znova");
        retry.setOnClickListener(v -> load());
        offline.addView(retry);
        Button change = new Button(this);
        change.setText("Zmeniť adresu servera");
        change.setOnClickListener(v -> askUrl());
        offline.addView(change);
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
    }

    private void load() {
        main.removeCallbacksAndMessages(null);
        pageError = false;
        web.loadUrl(serverUrl());
    }

    private void showOffline(String detail) {
        offlineDetail.setText(serverUrl() + (detail == null || detail.isEmpty() ? "" : "\n" + detail));
        offline.setVisibility(View.VISIBLE);
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::load, RETRY_MS);
    }

    /** Adresa servera: predvolene https://vyvolavaci.adna.sk/prehlad/, v ambulancii aj http://10.160.1.16:8080/prehlad/. */
    private void askUrl() {
        EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        in.setText(serverUrl());
        in.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle("Adresa servera AdNa")
                .setView(in)
                .setPositiveButton("Uložiť", (d, w) -> {
                    String u = in.getText().toString().trim();
                    if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u;
                    if (!u.contains("/prehlad")) u = u.replaceAll("/+$", "") + "/prehlad/";
                    prefs.edit().putString("url", u).apply();
                    load();
                })
                .setNeutralButton("Predvolená", (d, w) -> { prefs.edit().remove("url").apply(); load(); })
                .setNegativeButton("Zrušiť", null)
                .show();
    }

    private boolean sameServer(Uri u) {
        Uri s = Uri.parse(serverUrl());
        return u.getHost() != null && u.getHost().equalsIgnoreCase(s.getHost()) && u.getPort() == s.getPort();
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (sameServer(u)) return false;
            // cudzie odkazy (napr. Cloudflare, mapy) do prehliadača – v appke len server AdNa
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageError = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!pageError) offline.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
            if (!req.isForMainFrame()) return;
            pageError = true;
            showOffline(String.valueOf(error.getDescription()));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest req, android.webkit.WebResourceResponse resp) {
            if (!req.isForMainFrame() || resp.getStatusCode() < 500) return;
            pageError = true;
            showOffline("Server odpovedal chybou " + resp.getStatusCode() + ".");
        }
    }

    @Override
    public void onBackPressed() {
        if (offline.getVisibility() == View.VISIBLE) { super.onBackPressed(); return; }
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
