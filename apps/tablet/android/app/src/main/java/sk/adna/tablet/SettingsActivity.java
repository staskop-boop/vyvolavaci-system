package sk.adna.tablet;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Nastavenia tabletu (prístupné len cez PIN správcu). Rozhranie je vytvorené programovo. */
public class SettingsActivity extends Activity {
    static final String EXTRA_FIRST_RUN = "first_run";
    static final int RESULT_EXIT_KIOSK = 100;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Prefs prefs;
    private boolean firstRun;
    private EditText server, name, pin1, pin2;
    private CheckBox pinning, home;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = new Prefs(this);
        firstRun = getIntent().getBooleanExtra(EXTRA_FIRST_RUN, false) || !prefs.hasPin();

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = Ui.dp(this, 32);
        col.setPadding(pad, pad, pad, pad);
        scroll.addView(col);

        col.addView(Ui.text(this, firstRun ? "AdNa Tablet – prvotné nastavenie" : "AdNa Tablet – nastavenia", 28, Ui.BLUE, true));
        if (firstRun) {
            col.addView(Ui.text(this, "Zadajte adresu servera AdNa v lokálnej sieti a zvoľte PIN správcu. "
                    + "PIN budete potrebovať na vstup do nastavení (5× ťuknúť do ľavého horného rohu).", 17, Ui.MUTED, false), Ui.wrap(this, 8));
        }

        col.addView(Ui.text(this, "Adresa servera", 18, Ui.TEXT, true), Ui.wrap(this, 24));
        server = Ui.input(this, "napr. http://192.168.1.10:8080", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setText(prefs.serverUrl());
        col.addView(server, Ui.wrap(this, 4));
        Button test = Ui.button(this, "Overiť spojenie", false);
        col.addView(test, Ui.wrap(this, 8));
        status = Ui.text(this, "", 17, Ui.MUTED, false);
        col.addView(status, Ui.wrap(this, 8));
        test.setOnClickListener(v -> testConnection());

        col.addView(Ui.text(this, "Názov zariadenia (nepovinné)", 18, Ui.TEXT, true), Ui.wrap(this, 24));
        name = Ui.input(this, "napr. tablet-cakaren", InputType.TYPE_CLASS_TEXT);
        name.setText(prefs.deviceName());
        col.addView(name, Ui.wrap(this, 4));

        col.addView(Ui.text(this, firstRun ? "PIN správcu (aspoň 4 číslice)" : "Zmena PIN-u (nechajte prázdne, ak ho nemeníte)", 18, Ui.TEXT, true), Ui.wrap(this, 24));
        int pinType = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        pin1 = Ui.input(this, "Nový PIN", pinType);
        pin2 = Ui.input(this, "Zopakujte PIN", pinType);
        col.addView(pin1, Ui.wrap(this, 4));
        col.addView(pin2, Ui.wrap(this, 4));

        col.addView(Ui.text(this, "Kiosk režim", 18, Ui.TEXT, true), Ui.wrap(this, 24));
        DevicePolicyManager dpm = (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        boolean owner = dpm != null && dpm.isDeviceOwnerApp(getPackageName());
        col.addView(Ui.text(this, owner
                ? "Aplikácia je správcom zariadenia – plný kiosk režim je aktívny."
                : "Aplikácia nie je správcom zariadenia. Pre plný kiosk režim pozri návod (adb shell dpm set-device-owner …).",
                16, owner ? Ui.TEAL : Ui.MUTED, false), Ui.wrap(this, 4));
        pinning = new CheckBox(this);
        pinning.setText("Pripnúť obrazovku, ak aplikácia nie je správcom zariadenia");
        pinning.setTextSize(17);
        pinning.setChecked(prefs.screenPinning());
        col.addView(pinning, Ui.wrap(this, 8));
        home = new CheckBox(this);
        home.setText("Používať aplikáciu ako domovskú obrazovku (tlačidlo Domov otvorí AdNa)");
        home.setTextSize(17);
        home.setChecked(prefs.homeApp());
        col.addView(home, Ui.wrap(this, 8));

        Button save = Ui.button(this, "Uložiť a spustiť", true);
        col.addView(save, Ui.wrap(this, 32));
        save.setOnClickListener(v -> save());

        if (!firstRun) {
            Button back = Ui.button(this, "Späť bez uloženia", false);
            col.addView(back, Ui.wrap(this, 12));
            back.setOnClickListener(v -> { setResult(RESULT_CANCELED); finish(); });
            Button exit = Ui.button(this, "Ukončiť kiosk režim (údržba tabletu)", false);
            exit.setTextColor(Ui.DANGER);
            col.addView(exit, Ui.wrap(this, 12));
            exit.setOnClickListener(v -> { setResult(RESULT_EXIT_KIOSK); finish(); });
        }
        col.addView(Ui.text(this, "Verzia 1.0.0", 14, Ui.MUTED, false), Ui.wrap(this, 24));
        setContentView(scroll);
    }

    private void testConnection() {
        final String url = Prefs.normalizeUrl(server.getText().toString());
        status.setTextColor(Ui.MUTED);
        status.setText("Overujem " + url + " …");
        new Thread(() -> {
            final boolean ok = Net.health(url);
            main.post(() -> {
                status.setTextColor(ok ? Ui.TEAL : Ui.DANGER);
                status.setText(ok ? "Spojenie so serverom je v poriadku." : "Server sa nepodarilo kontaktovať. Skontrolujte adresu a sieť.");
            });
        }, "adna-test").start();
    }

    private void save() {
        String url = Prefs.normalizeUrl(server.getText().toString());
        if (url.isEmpty()) { error("Zadajte adresu servera."); return; }
        String p1 = pin1.getText().toString(), p2 = pin2.getText().toString();
        if (firstRun || !p1.isEmpty()) {
            if (p1.length() < 4) { error("PIN musí mať aspoň 4 číslice."); return; }
            if (!p1.equals(p2)) { error("PIN-y sa nezhodujú."); return; }
            prefs.setPin(p1);
        }
        prefs.setServerUrl(url);
        prefs.setDeviceName(name.getText().toString());
        prefs.setScreenPinning(pinning.isChecked());
        prefs.setHomeApp(home.isChecked());
        getPackageManager().setComponentEnabledSetting(
                new ComponentName(this, getPackageName() + ".HomeAlias"),
                home.isChecked() ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP);
        setResult(RESULT_OK);
        finish();
    }

    private void error(String m) {
        status.setTextColor(Ui.DANGER);
        status.setText(m);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (firstRun) return; // bez nastavenia sa nedá pokračovať
        super.onBackPressed();
    }
}
