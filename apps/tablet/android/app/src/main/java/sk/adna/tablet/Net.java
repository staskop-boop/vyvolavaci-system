package sk.adna.tablet;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Overenie dostupnosti servera (GET /api/health). Volať mimo hlavného vlákna. */
final class Net {
    private Net() {}

    static boolean health(String serverUrl) {
        if (serverUrl == null || serverUrl.isEmpty()) return false;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(serverUrl + "/api/health").openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(4000);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            if (code != 200) return false;
            InputStream in = c.getInputStream();
            byte[] buf = new byte[512];
            int n = in.read(buf);
            in.close();
            return n > 0 && new String(buf, 0, n, "UTF-8").contains("\"ok\":true");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
