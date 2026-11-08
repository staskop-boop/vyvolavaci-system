package sk.adna.obrazovka;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Spustenie po zapnutí zariadenia. POZOR: Android 10+ obmedzuje spúšťanie aktivít na pozadí.
 * Na mnohých TV boxoch to funguje, ale nie je to zaručené na každom televízore (pozri README.md).
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)
                && !"com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        if (!Prefs.autostart(context) || Prefs.serverUrl(context).isEmpty()) return;
        try {
            Intent i = new Intent(context, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(i);
        } catch (Exception e) {
            Log.w("AdNa", "Automatické spustenie zlyhalo: " + e);
        }
    }
}
