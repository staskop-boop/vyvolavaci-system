package sk.adna.tablet;

import android.app.admin.DeviceAdminReceiver;

/** Správca zariadenia – umožňuje plný kiosk režim (adb shell dpm set-device-owner sk.adna.tablet/.AdminReceiver). */
public class AdminReceiver extends DeviceAdminReceiver {
}
