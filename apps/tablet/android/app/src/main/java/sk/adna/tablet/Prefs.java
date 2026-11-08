package sk.adna.tablet;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.UUID;

/** Lokálne nastavenia tabletu (adresa servera, názov zariadenia, PIN správcu). */
final class Prefs {
    private static final String FILE = "adna_tablet";
    private static final String K_SERVER = "server_url";
    private static final String K_NAME = "device_name";
    private static final String K_ID = "device_id";
    private static final String K_PIN = "pin_hash";
    private static final String K_PINNING = "screen_pinning";
    private static final String K_HOME = "home_app";
    private static final String K_KIOSK_OFF = "kiosk_suspended";

    private final SharedPreferences sp;

    Prefs(Context c) { sp = c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE); }

    String serverUrl() { return sp.getString(K_SERVER, ""); }
    void setServerUrl(String v) { sp.edit().putString(K_SERVER, normalizeUrl(v)).apply(); }

    String deviceName() { return sp.getString(K_NAME, ""); }
    void setDeviceName(String v) { sp.edit().putString(K_NAME, v == null ? "" : v.trim()).apply(); }

    /** Identifikátor zariadenia posielaný serveru (názov, ak je nastavený, inak náhodné ID). */
    String deviceId() {
        String name = deviceName();
        if (!name.isEmpty()) return name;
        String id = sp.getString(K_ID, null);
        if (id == null) {
            id = "tablet-" + UUID.randomUUID().toString().substring(0, 8);
            sp.edit().putString(K_ID, id).apply();
        }
        return id;
    }

    boolean screenPinning() { return sp.getBoolean(K_PINNING, true); }
    void setScreenPinning(boolean v) { sp.edit().putBoolean(K_PINNING, v).apply(); }

    boolean homeApp() { return sp.getBoolean(K_HOME, false); }
    void setHomeApp(boolean v) { sp.edit().putBoolean(K_HOME, v).apply(); }

    boolean kioskSuspended() { return sp.getBoolean(K_KIOSK_OFF, false); }
    void setKioskSuspended(boolean v) { sp.edit().putBoolean(K_KIOSK_OFF, v).apply(); }

    boolean hasPin() { return sp.getString(K_PIN, null) != null; }

    void setPin(String pin) {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        sp.edit().putString(K_PIN, hex(salt) + ":" + hash(salt, pin)).apply();
    }

    boolean checkPin(String pin) {
        String stored = sp.getString(K_PIN, null);
        if (stored == null || pin == null) return false;
        int i = stored.indexOf(':');
        if (i < 0) return false;
        byte[] salt = unhex(stored.substring(0, i));
        return MessageDigest.isEqual(stored.substring(i + 1).getBytes(StandardCharsets.US_ASCII),
                hash(salt, pin).getBytes(StandardCharsets.US_ASCII));
    }

    /** Doplní http:// a odstráni koncové lomky. */
    static String normalizeUrl(String v) {
        if (v == null) return "";
        String s = v.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String hash(byte[] salt, String pin) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] data = salt;
            for (int i = 0; i < 10000; i++) {   // jednoduché sťaženie skúšania PIN-u
                md.reset();
                md.update(data);
                md.update(pin.getBytes(StandardCharsets.UTF_8));
                data = md.digest();
            }
            return hex(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static byte[] unhex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return out;
    }
}
