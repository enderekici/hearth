package com.enderekici.hearth;

import android.app.Service;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.TextView;

public final class ReturnOverlayService extends Service {
    static final String ACTION_HIDE = "com.enderekici.hearth.HIDE_RETURN";
    static final String ACTION_SHOW = "com.enderekici.hearth.SHOW_RETURN";
    private WindowManager manager;
    private TextView button;
    private WindowManager.LayoutParams params;
    private boolean attached;

    @Override public void onCreate() {
        super.onCreate();
        if (!Settings.canDrawOverlays(this)) { stopSelf(); return; }
        manager = (WindowManager) getSystemService(WINDOW_SERVICE);
        button = new TextView(this); button.setText("Return"); button.setTextColor(Color.WHITE);
        button.setTextSize(14); button.setGravity(Gravity.CENTER); button.setPadding(18, 10, 18, 10);
        GradientDrawable bg = new GradientDrawable(); bg.setColor(0xdd202a35); bg.setCornerRadius(28);
        button.setBackground(bg);
        button.setOnClickListener(v -> {
            Intent launch = new Intent(this, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(launch);
        });
        params = new WindowManager.LayoutParams(140, 54,
                WindowManager.LayoutParams.TYPE_SYSTEM_ALERT,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.RIGHT | Gravity.CENTER_VERTICAL;
        params.x = 12;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (button != null && intent != null) {
            if (ACTION_HIDE.equals(intent.getAction())) removeOverlay();
            else if (ACTION_SHOW.equals(intent.getAction())) addOverlay();
        }
        Intent launch = new Intent(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this)
                .setContentTitle("Hearth return control")
                .setContentText("Tap to return to Hearth")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setOngoing(true)
                .setVisibility(Notification.VISIBILITY_SECRET)
                .setContentIntent(pending)
                .build();
        startForeground(41, notification);
        return START_STICKY;
    }
    @Override public void onDestroy() {
        removeOverlay();
        stopForeground(true);
        super.onDestroy();
    }
    private void addOverlay() {
        if (!attached && button != null && manager != null) {
            manager.addView(button, params);
            attached = true;
        }
    }
    private void removeOverlay() {
        if (attached && button != null && manager != null) {
            manager.removeView(button);
            attached = false;
        }
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
