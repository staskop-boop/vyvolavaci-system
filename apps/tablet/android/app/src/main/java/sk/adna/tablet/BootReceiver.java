package sk.adna.tablet;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Spustenie po zapnutí tabletu. Na Androide 10+ systém spúšťanie aktivít z pozadia obmedzuje –
 * spoľahlivo funguje, ak je aplikácia správcom zariadenia alebo nastavená ako domovská obrazovka.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        Intent i = new Intent(context, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(i);
        } catch (Exception ignored) {
            // Systém spustenie nepovolil – aplikáciu treba spustiť ručne alebo ju nastaviť ako domovskú.
        }
    }
}
