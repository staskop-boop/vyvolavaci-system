package sk.adna.tablet;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Pomocné funkcie pre programovo vytvárané rozhranie (bez XML layoutov). */
final class Ui {
    static final int BLUE = Color.rgb(0xc8, 0x10, 0x2e);
    static final int TEAL = Color.rgb(0x11, 0x11, 0x11);
    static final int TEXT = Color.rgb(0x11, 0x11, 0x11);
    static final int MUTED = Color.rgb(0x5f, 0x5f, 0x5f);
    static final int DANGER = Color.rgb(0x8b, 0x1a, 0x1a);

    private Ui() {}

    static int dp(Activity a, float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, a.getResources().getDisplayMetrics());
    }

    static TextView text(Activity a, String s, float sp, int color, boolean bold) {
        TextView t = new TextView(a);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    static Button button(Activity a, String s, boolean primary) {
        Button b = new Button(a);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(a, 14));
        if (primary) { bg.setColor(BLUE); b.setTextColor(Color.WHITE); }
        else { bg.setColor(Color.WHITE); bg.setStroke(dp(a, 2), Color.rgb(0xe0, 0xe0, 0xe0)); b.setTextColor(BLUE); }
        b.setBackground(bg);
        b.setPadding(dp(a, 24), dp(a, 14), dp(a, 24), dp(a, 14));
        return b;
    }

    static EditText input(Activity a, String hint, int type) {
        EditText e = new EditText(a);
        e.setHint(hint);
        e.setInputType(type);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        e.setSingleLine(true);
        return e;
    }

    static LinearLayout.LayoutParams wrap(Activity a, int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(a, topDp);
        return lp;
    }

    interface PinCallback { void onPin(String pin); }

    /** Dialóg na zadanie PIN-u. */
    static void askPin(Activity a, String title, final PinCallback cb) {
        final EditText e = input(a, "PIN", InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        e.setGravity(Gravity.CENTER);
        new AlertDialog.Builder(a)
                .setTitle(title)
                .setView(e)
                .setPositiveButton("Pokračovať", (d, w) -> cb.onPin(e.getText().toString()))
                .setNegativeButton("Zrušiť", null)
                .show();
    }
}
