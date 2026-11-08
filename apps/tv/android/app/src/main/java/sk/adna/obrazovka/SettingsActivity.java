package sk.adna.obrazovka;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Nastavenia ovládateľné diaľkovým ovládačom (šípky + OK). */
public class SettingsActivity extends Activity {
    private EditText url;
    private CheckBox autostart;
    private TextView result;
    private Button overlayBtn;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        scroll.setFillViewport(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(48);
        col.setPadding(pad, dp(32), pad, dp(32));
        scroll.addView(col);

        TextView title = text("Nastavenia obrazovky AdNa", 32, "#C8102E");
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        col.addView(text("Ovládanie: šípkami sa presúvate, tlačidlom OK potvrdzujete. Text zadáte cez klávesnicu na obrazovke.", 18, "#5F5F5F"));

        col.addView(label("Adresa servera (napr. 192.168.1.10 alebo http://192.168.1.10:8080)"));
        url = new EditText(this);
        url.setSingleLine(true);
        url.setTextSize(24);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setImeOptions(EditorInfo.IME_ACTION_DONE);
        url.setText(Prefs.serverUrl(this));
        url.setHint("192.168.1.10");
        col.addView(url, matchWrap());

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        Button test = button("Otestovať spojenie");
        test.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { testConnection(); }
        });
        row.addView(test);
        result = text("", 20, "#111111");
        result.setPadding(dp(24), 0, 0, 0);
        row.addView(result);
        col.addView(row, matchWrap());

        autostart = new CheckBox(this);
        autostart.setText("Spúšťať po zapnutí zariadenia (ak to zariadenie dovolí)");
        autostart.setTextSize(22);
        autostart.setChecked(Prefs.autostart(this));
        col.addView(autostart, matchWrap());

        overlayBtn = button("Povoliť spúšťanie po zapnutí (Android 10+)");
        overlayBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { requestOverlay(); }
        });
        col.addView(overlayBtn);
        col.addView(text("Na Androide 10 a novšom môže systém spustenie po zapnutí zablokovať. Toto povolenie "
                + "(„Zobrazovať cez iné aplikácie“) to na mnohých zariadeniach umožní. Nie je to zaručené na každom televízore.", 16, "#5F5F5F"));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(24), 0, 0);
        Button save = button("Uložiť a spustiť");
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { save(); }
        });
        Button cancel = button("Späť bez uloženia");
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        actions.addView(save);
        actions.addView(cancel);
        col.addView(actions);

        col.addView(text("Verzia aplikácie: " + version(), 16, "#5F5F5F"));
        setContentView(scroll);

        if (Prefs.serverUrl(this).isEmpty()) url.requestFocus(); else save.requestFocus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        overlayBtn.setVisibility(needsOverlay() ? View.VISIBLE : View.GONE);
    }

    private boolean needsOverlay() {
        return Build.VERSION.SDK_INT >= 29 && !Settings.canDrawOverlays(this);
    }

    private void requestOverlay() {
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            // Mnohé TV nemajú túto obrazovku – povolenie sa dá udeliť cez adb (pozri README).
            Toast.makeText(this, "Toto zariadenie nemá nastavenie povolenia. Použite: adb shell appops set "
                    + getPackageName() + " SYSTEM_ALERT_WINDOW allow", Toast.LENGTH_LONG).show();
        }
    }

    private void save() {
        String n = Prefs.normalize(url.getText().toString());
        if (n == null) {
            result.setTextColor(Color.parseColor("#8B1A1A"));
            result.setText("Zadajte platnú adresu servera.");
            url.requestFocus();
            return;
        }
        Prefs.save(this, n, autostart.isChecked());
        Toast.makeText(this, "Uložené: " + n, Toast.LENGTH_SHORT).show();
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(i);
        finish();
    }

    private void testConnection() {
        final String n = Prefs.normalize(url.getText().toString());
        if (n == null) {
            result.setTextColor(Color.parseColor("#8B1A1A"));
            result.setText("Neplatná adresa.");
            return;
        }
        result.setTextColor(Color.parseColor("#5F5F5F"));
        result.setText("Overujem " + n + " …");
        new Thread(new Runnable() {
            @Override public void run() {
                String msg;
                boolean ok = false;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(n + "/api/health").openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(4000);
                    int code = c.getResponseCode();
                    InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
                    byte[] buf = new byte[512];
                    int len = in != null ? in.read(buf) : -1;
                    String body = len > 0 ? new String(buf, 0, len, "UTF-8") : "";
                    ok = code == 200 && body.contains("\"ok\":true");
                    msg = ok ? "Spojenie je v poriadku." : "Server odpovedal neočakávane (HTTP " + code + ").";
                } catch (Exception e) {
                    msg = "Server nie je dostupný: " + e.getClass().getSimpleName();
                } finally {
                    if (c != null) c.disconnect();
                }
                final String fm = msg;
                final boolean fok = ok;
                runOnUiThread(new Runnable() {
                    @Override public void run() {
                        result.setTextColor(Color.parseColor(fok ? "#1E8A4C" : "#8B1A1A"));
                        result.setText(fm);
                    }
                });
            }
        }).start();
    }

    private TextView text(String s, int sp, String color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(Color.parseColor(color));
        t.setPadding(0, dp(8), 0, dp(8));
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 20, "#111111");
        t.setPadding(0, dp(24), 0, dp(4));
        return t;
    }

    private Button button(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setTextSize(20);
        b.setAllCaps(false);
        b.setFocusable(true);
        return b;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
