package sk.adna.obrazovka;

import android.content.Context;
import android.content.SharedPreferences;

/** Lokálne nastavenia zariadenia (adresa servera, automatické spustenie). */
final class Prefs {
    private static final String FILE = "adna_obrazovka";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_AUTOSTART = "autostart";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String serverUrl(Context c) { return sp(c).getString(KEY_SERVER, ""); }

    static boolean autostart(Context c) { return sp(c).getBoolean(KEY_AUTOSTART, true); }

    static void save(Context c, String url, boolean autostart) {
        sp(c).edit().putString(KEY_SERVER, url).putBoolean(KEY_AUTOSTART, autostart).apply();
    }

    /**
     * Upraví zadanú adresu: doplní http:// a port 8080, odstráni koncové lomky a cestu /obrazovka.
     * Vráti null, ak adresa nie je platná.
     */
    static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim();
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.endsWith("/obrazovka")) s = s.substring(0, s.length() - "/obrazovka".length());
        try {
            java.net.URL u = new java.net.URL(s);
            if (u.getHost() == null || u.getHost().isEmpty()) return null;
            if (u.getPort() == -1 && "http".equals(u.getProtocol())) {
                s = u.getProtocol() + "://" + u.getHost() + ":8080" + u.getPath();
            }
        } catch (java.net.MalformedURLException e) {
            return null;
        }
        return s;
    }

    static String displayUrl(Context c) {
        String base = serverUrl(c);
        return base.isEmpty() ? "" : base + "/obrazovka/";
    }
}
